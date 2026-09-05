use crate::domain::terminal::service::PtyManager;
use crate::error::AppError;
use tokio::sync::watch;
use tracing::{debug, warn};

/// An unregistered child must be killed on startup failure or cancellation.
pub(super) struct StartupPty {
    manager: PtyManager,
    id: Option<String>,
}

impl StartupPty {
    pub(super) fn new(manager: PtyManager, id: String) -> Self {
        Self {
            manager,
            id: Some(id),
        }
    }

    pub(super) fn disarm(&mut self) {
        self.id = None;
    }
}

impl Drop for StartupPty {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            if let Err(error) = self.manager.kill_pty(id) {
                warn!(pty_id = %id, %error, "failed to kill Neovim after interrupted startup");
            }
        }
    }
}

pub(super) async fn wait_for_socket(
    path: &std::path::Path,
    alive: &mut watch::Receiver<Option<i32>>,
) -> Result<(), AppError> {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        loop {
            if let Some(code) = *alive.borrow_and_update() {
                return Err(AppError::NeovimSpawnError {
                    detail: format!("Neovim exited during startup (code {code})"),
                });
            }
            if path.exists() {
                return Ok(());
            }
            tokio::select! {
                result = alive.changed() => {
                    if result.is_err() { return Err(AppError::NeovimProcessNotRunning); }
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
            }
        }
    })
    .await
    .map_err(|_| AppError::NeovimHandshakeTimeout)?
}

/// Version string from `nvim --version`'s first line (e.g. "NVIM v0.10.2"),
/// resolving PATH the same way the spawn path does so both agree on which
/// binary is in play. Empty when nvim is unavailable.
pub(super) async fn nvim_version() -> String {
    let mut cmd = tokio::process::Command::new("nvim");
    cmd.arg("--version").kill_on_drop(true);
    match cli_discovery::login_shell_path().await {
        Some(login_path) => {
            debug!(path = %login_path, "resolved login-shell PATH for nvim detection");
            cmd.env("PATH", login_path);
        }
        None => {
            debug!("no login-shell PATH resolved; falling back to inherited process PATH for nvim detection");
        }
    }
    let output = match tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            warn!(%error, "failed to spawn `nvim --version`");
            return String::new();
        }
        Err(_) => {
            warn!("`nvim --version` timed out");
            return String::new();
        }
    };
    if !output.status.success() {
        warn!(
            status = %output.status,
            stderr = %String::from_utf8_lossy(&output.stderr),
            "`nvim --version` exited non-zero"
        );
        return String::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Whether `nvim` is spawnable, resolving PATH the same way `start` does.
pub async fn nvim_available() -> bool {
    !nvim_version().await.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn startup_observes_an_exit_before_subscribing() {
        let dir = tempfile::tempdir().unwrap();
        let (alive, _) = watch::channel(None);
        alive.send_replace(Some(9));
        let result =
            wait_for_socket(&dir.path().join("missing.sock"), &mut alive.subscribe()).await;
        assert!(matches!(result, Err(AppError::NeovimSpawnError { .. })));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn interrupted_startup_kills_its_unregistered_pty() {
        use crate::domain::terminal::service::PtyKind;
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.args(["-c", "exec sleep 60"]);
        let (id, handle) = manager
            .create_pty_with_command(
                1,
                command,
                dir.path().to_str().unwrap(),
                80,
                24,
                PtyKind::Neovim,
            )
            .unwrap();
        let mut alive = handle.alive.subscribe();
        drop(StartupPty::new(manager.clone(), id));
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while alive.borrow_and_update().is_none() {
                alive.changed().await.unwrap();
            }
        })
        .await
        .expect("cancelled startup child must be reaped");
        manager.kill_all();
    }
}
