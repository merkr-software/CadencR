use std::time::Duration;

use crate::error::AppError;
use nvim_rs::rpc::handler::Dummy;

use super::startup::wait_until_ready;

pub(super) struct RpcTask(pub(super) tokio::task::AbortHandle);
impl Drop for RpcTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) fn resolve_file_path(cwd: &str, path: &str) -> Result<String, AppError> {
    // Agent links can name an absolute document outside the feature's project.
    // Relative paths still use the project editor's traversal/symlink checks.
    let resolved = if std::path::Path::new(path).is_absolute() {
        std::fs::canonicalize(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound(path.to_string())
            } else {
                AppError::BadRequest(format!("Cannot access path: {error}"))
            }
        })
    } else {
        let root =
            std::fs::canonicalize(cwd).map_err(|error| AppError::BadRequest(error.to_string()))?;
        crate::domain::editor::service::validate_path(&root, path)
    }
    .map_err(|error| match error {
        AppError::NotFound(_) => AppError::NeovimFileNotFound {
            path: path.to_string(),
        },
        error => error,
    })?;

    if !resolved.is_file() {
        return Err(AppError::BadRequest(format!("Path is not a file: {path}")));
    }
    Ok(resolved.to_string_lossy().into_owned())
}

pub(super) async fn open_file(
    socket: &std::path::Path,
    path: &str,
    line: Option<u32>,
    col: Option<u32>,
) -> Result<(), AppError> {
    let request_timeout = Duration::from_secs(10);
    let (nvim, io) = tokio::time::timeout(
        request_timeout,
        nvim_rs::create::tokio::new_path(socket, Dummy::new()),
    )
    .await
    .map_err(|_| AppError::NeovimSpawnError {
        detail: "Neovim control socket connection timed out".to_string(),
    })?
    .map_err(|e| AppError::NeovimSpawnError {
        detail: format!("control socket unavailable: {e}"),
    })?;
    let _io = RpcTask(io.abort_handle());
    wait_until_ready(&nvim, Duration::from_secs(90)).await?;

    // One RPC keeps scheduled BufEnter/plugin callbacks from changing focus
    // between opening the file and positioning its cursor. All arguments stay
    // msgpack values; fnameescape remains the authority for Ex path grammar.
    let opened = tokio::time::timeout(
        request_timeout,
        nvim.exec_lua(
            r#"
                local path, line, col = ...
                if vim.fn.filereadable(path) ~= 1 then return false end
                vim.cmd('tab drop ' .. vim.fn.fnameescape(path))
                local buffer = vim.fn.bufnr(path)
                for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
                    if vim.api.nvim_win_get_buf(win) == buffer then
                        vim.api.nvim_set_current_win(win)
                        vim.api.nvim_win_set_cursor(win, {line, col})
                        return true
                    end
                end
                error('opened file has no visible window')
            "#,
            vec![
                nvim_rs::Value::from(path),
                nvim_rs::Value::from(line.unwrap_or(1).max(1)),
                nvim_rs::Value::from(col.unwrap_or(1).max(1) - 1),
            ],
        ),
    )
    .await
    .map_err(|_| AppError::NeovimSpawnError {
        detail: "Neovim file-open request timed out".to_string(),
    })?
    .map_err(|error| AppError::NeovimSpawnError {
        detail: format!("failed to open file and position cursor: {error}"),
    })?;
    if opened.as_bool() != Some(true) {
        return Err(AppError::NeovimFileNotFound {
            path: path.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_file_open_is_confined_to_the_feature_root() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a | b.txt"), "inside").unwrap();
        std::fs::write(base.path().join("outside.txt"), "outside").unwrap();
        let cwd = root.to_str().unwrap();
        assert!(resolve_file_path(cwd, "a | b.txt").is_ok());
        assert!(resolve_file_path(cwd, "../outside.txt").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.path().join("outside.txt"), root.join("link")).unwrap();
            assert!(resolve_file_path(cwd, "link").is_err());
        }
    }

    #[test]
    fn absolute_file_links_can_open_files_outside_the_feature_root() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let report = base.path().join("report.md");
        std::fs::write(&report, "External report\n").unwrap();

        let resolved = resolve_file_path(root.to_str().unwrap(), report.to_str().unwrap())
            .expect("absolute file links can target an external document");

        assert_eq!(
            resolved,
            std::fs::canonicalize(&report).unwrap().to_string_lossy()
        );
    }

    #[test]
    fn file_open_rejects_directories() {
        let root = tempfile::tempdir().unwrap();

        for path in [".", root.path().to_str().unwrap()] {
            assert!(matches!(
                resolve_file_path(root.path().to_str().unwrap(), path),
                Err(AppError::BadRequest(_))
            ));
        }
    }

    #[tokio::test]
    async fn rpc_task_is_cancelled_when_request_scope_ends() {
        let task = tokio::spawn(std::future::pending::<()>());
        drop(RpcTask(task.abort_handle()));
        assert!(task.await.unwrap_err().is_cancelled());
    }
}
