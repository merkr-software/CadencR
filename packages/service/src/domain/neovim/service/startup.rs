use std::time::Duration;

use futures::io::AsyncWrite;
use nvim_rs::Neovim;

use crate::error::AppError;

/// A listening socket can exist while init.lua is still running. Poll from
/// Rust: vim.wait() inside an RPC would block the init that must finish first.
/// Only file opens use this barrier; PTY attachment must allow startup input.
pub(super) async fn wait_until_ready<W>(nvim: &Neovim<W>, timeout: Duration) -> Result<(), AppError>
where
    W: AsyncWrite + Send + Unpin + 'static,
{
    tokio::time::timeout(timeout, async {
        loop {
            let ready = nvim
                .exec_lua(
                    "return vim.v.vim_did_enter == 1 and vim.fn.state('x') == ''",
                    vec![],
                )
                .await
                .map_err(|error| AppError::NeovimSpawnError {
                    detail: format!("failed to check Neovim initialization: {error}"),
                })?;
            if ready.as_bool() == Some(true) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| AppError::NeovimHandshakeTimeout)?
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nvim_rs::rpc::handler::Dummy;

    use super::super::{
        file::{open_file, RpcTask},
        lifecycle::{wait_for_socket, StartupPty},
        tests::nvim_available_test,
    };
    use super::wait_until_ready;
    use crate::domain::terminal::service::{PtyKind, PtyManager};
    use crate::error::AppError;

    enum StartupPhase {
        Init,
        VimEnter,
    }

    async fn paused_neovim(phase: StartupPhase) -> Option<(tempfile::TempDir, StartupPty)> {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return None;
        }
        let directory = tempfile::tempdir().unwrap();
        let init = directory.path().join("init.lua");
        let initialize = r#"
            local function initialize()
                vim.fn.writefile({'waiting'}, 'init-waiting')
                assert(vim.wait(15000, function()
                    return vim.fn.filereadable('release-init') == 1
                end, 10), 'test did not release initialization')
                vim.cmd('filetype plugin indent on')
                vim.cmd('syntax on')
                vim.api.nvim_create_autocmd('FileType', {
                    pattern = 'lua',
                    callback = function(ev)
                        vim.b[ev.buf].test_filetype_initialized = true
                    end,
                })
            end
        "#;
        let invoke = match phase {
            StartupPhase::Init => "initialize()",
            StartupPhase::VimEnter => {
                "vim.api.nvim_create_autocmd('VimEnter', {callback = initialize})"
            }
        };
        std::fs::write(&init, format!("{initialize}\n{invoke}\n")).unwrap();
        std::fs::write(
            directory.path().join("sample.lua"),
            "local answer = 42\nprint(answer)\n",
        )
        .unwrap();
        let mut command = portable_pty::CommandBuilder::new("nvim");
        command.arg("-u");
        command.arg(&init);
        command.args(["-i", "NONE", "--noplugin", "--listen"]);
        command.arg(directory.path().join("nvim.sock"));
        if let Some(path) = cli_discovery::login_shell_path().await {
            command.env("PATH", path);
        }
        let manager = PtyManager::new();
        let (id, handle) = manager
            .create_pty_with_command(
                1,
                command,
                directory.path().to_str().unwrap(),
                120,
                40,
                PtyKind::Neovim,
            )
            .unwrap();
        let cleanup = StartupPty::new(manager, id);
        wait_for_socket(
            &directory.path().join("nvim.sock"),
            &mut handle.alive.subscribe(),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !directory.path().join("init-waiting").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Neovim should pause inside its init before filetype setup");
        Some((directory, cleanup))
    }

    async fn assert_file_open_waits(phase: StartupPhase) {
        let Some((directory, _cleanup)) = paused_neovim(phase).await else {
            return;
        };
        let socket = directory.path().join("nvim.sock");
        let (nvim, io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .unwrap();
        let _io = RpcTask(io.abort_handle());
        let initializing = nvim
            .exec_lua(
                "return vim.v.vim_did_enter == 0 or vim.fn.state('x') ~= ''",
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(initializing.as_bool(), Some(true));

        let sample = directory.path().join("sample.lua");
        let mut opening = Box::pin(open_file(
            &socket,
            sample.to_str().unwrap(),
            Some(2),
            Some(3),
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut opening)
                .await
                .is_err(),
            "opening must remain pending while init.lua is still running"
        );
        std::fs::write(directory.path().join("release-init"), "").unwrap();
        tokio::time::timeout(Duration::from_secs(5), opening)
            .await
            .unwrap()
            .unwrap();
        let initialized = nvim
            .exec_lua(
                r#"
                    local cursor = vim.api.nvim_win_get_cursor(0)
                    return vim.v.vim_did_enter == 1
                        and vim.bo.filetype == 'lua'
                        and (vim.bo.syntax == 'lua'
                            or vim.treesitter.highlighter.active[vim.api.nvim_get_current_buf()] ~= nil)
                        and vim.b.test_filetype_initialized == true
                        and cursor[1] == 2 and cursor[2] == 2
                "#,
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(initialized.as_bool(), Some(true));
    }

    #[tokio::test]
    async fn file_open_waits_for_initialization_and_runs_filetype_plugins() {
        assert_file_open_waits(StartupPhase::Init).await;
    }

    #[tokio::test]
    async fn file_open_waits_for_vimenter_callbacks_to_finish() {
        assert_file_open_waits(StartupPhase::VimEnter).await;
    }

    #[tokio::test]
    async fn initialization_timeout_is_reported_without_opening_a_buffer() {
        let Some((directory, _cleanup)) = paused_neovim(StartupPhase::Init).await else {
            return;
        };
        let (nvim, io) =
            nvim_rs::create::tokio::new_path(directory.path().join("nvim.sock"), Dummy::new())
                .await
                .unwrap();
        let _io = RpcTask(io.abort_handle());
        let error = wait_until_ready(&nvim, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::NeovimHandshakeTimeout));
        assert_eq!(
            nvim.exec_lua("return vim.api.nvim_buf_get_name(0)", vec![])
                .await
                .unwrap()
                .as_str(),
            Some("")
        );
    }

    #[tokio::test]
    async fn cancelled_file_open_does_not_run_after_initialization() {
        let Some((directory, _cleanup)) = paused_neovim(StartupPhase::Init).await else {
            return;
        };
        let socket = directory.path().join("nvim.sock");
        let sample = directory.path().join("sample.lua");
        assert!(tokio::time::timeout(
            Duration::from_millis(100),
            open_file(&socket, sample.to_str().unwrap(), None, None),
        )
        .await
        .is_err());
        std::fs::write(directory.path().join("release-init"), "").unwrap();
        let (nvim, io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .unwrap();
        let _io = RpcTask(io.abort_handle());
        wait_until_ready(&nvim, Duration::from_secs(5))
            .await
            .unwrap();
        let absent = nvim
            .exec_lua(
                "return vim.fn.bufnr(...) == -1",
                vec![sample.to_str().unwrap().into()],
            )
            .await
            .unwrap();
        assert_eq!(absent.as_bool(), Some(true));
    }
}
