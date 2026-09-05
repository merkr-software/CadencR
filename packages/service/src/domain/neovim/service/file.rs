use crate::error::AppError;
use nvim_rs::rpc::handler::Dummy;

pub(super) struct RpcTask(pub(super) tokio::task::AbortHandle);
impl Drop for RpcTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) fn scoped_file_path(cwd: &str, path: &str) -> Result<String, AppError> {
    let root =
        std::fs::canonicalize(cwd).map_err(|error| AppError::BadRequest(error.to_string()))?;
    crate::domain::editor::service::validate_path(&root, path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| match error {
            AppError::NotFound(_) => AppError::NeovimFileNotFound {
                path: path.to_string(),
            },
            error => error,
        })
}

pub(super) async fn open_file(
    socket: &std::path::Path,
    path: &str,
    line: Option<u32>,
    col: Option<u32>,
) -> Result<(), AppError> {
    let (nvim, io) = nvim_rs::create::tokio::new_path(socket, Dummy::new())
        .await
        .map_err(|e| AppError::NeovimSpawnError {
            detail: format!("control socket unavailable: {e}"),
        })?;
    let _io = RpcTask(io.abort_handle());

    // One RPC keeps scheduled BufEnter/plugin callbacks from changing focus
    // between opening the file and positioning its cursor. All arguments stay
    // msgpack values; fnameescape remains the authority for Ex path grammar.
    let opened = nvim
        .exec_lua(
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
        )
        .await
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
    fn file_open_is_confined_to_the_feature_root() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a | b.txt"), "inside").unwrap();
        std::fs::write(base.path().join("outside.txt"), "outside").unwrap();
        let cwd = root.to_str().unwrap();
        assert!(scoped_file_path(cwd, "a | b.txt").is_ok());
        assert!(scoped_file_path(cwd, "../outside.txt").is_err());
        assert!(scoped_file_path(cwd, base.path().join("outside.txt").to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.path().join("outside.txt"), root.join("link")).unwrap();
            assert!(scoped_file_path(cwd, "link").is_err());
        }
    }

    #[tokio::test]
    async fn rpc_task_is_cancelled_when_request_scope_ends() {
        let task = tokio::spawn(std::future::pending::<()>());
        drop(RpcTask(task.abort_handle()));
        assert!(task.await.unwrap_err().is_cancelled());
    }
}
