//! Login-shell PATH resolution.

use tokio::sync::OnceCell as AsyncOnceCell;

#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio::process::Command;
#[cfg(unix)]
use tracing::warn;

/// Spawn the user's login shell once and return its PATH.
///
/// Cached for the process lifetime. Returns `None` on Windows or if the shell
/// errors out — callers must treat absence as benign.
pub async fn login_shell_path() -> Option<String> {
    static CACHE: AsyncOnceCell<Option<String>> = AsyncOnceCell::const_new();
    CACHE.get_or_init(resolve_login_shell_path).await.clone()
}

#[cfg(unix)]
async fn resolve_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let spawn_result = tokio::time::timeout(
        Duration::from_secs(3),
        Command::new(&shell)
            .args(["-ilc", "printenv PATH"])
            .env_remove("CLAUDECODE")
            .output(),
    )
    .await;
    let Ok(spawn_result) = spawn_result else {
        warn!(shell = %shell, "login shell timed out after 3s while resolving PATH");
        return None;
    };
    let Ok(output) = spawn_result else {
        warn!(shell = %shell, "failed to spawn login shell while resolving PATH");
        return None;
    };

    if !output.status.success() {
        warn!(
            shell = %shell,
            stderr = %String::from_utf8_lossy(&output.stderr),
            "login shell exited non-zero while resolving PATH"
        );
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(unix))]
async fn resolve_login_shell_path() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for the fish bug: `echo $PATH` prints fish's list
    /// variable space-separated, not colon-separated, silently breaking
    /// every `split_paths()` consumer. `printenv PATH` reads the actual
    /// exported environment variable, which is always colon-separated
    /// POSIX form regardless of which shell exported it.
    #[tokio::test]
    async fn resolved_path_is_colon_separated_when_shell_is_available() {
        let Some(path) = login_shell_path().await else {
            // No $SHELL in this environment (e.g. some CI runners) — the
            // function's own contract is "absence is benign", nothing to
            // assert against.
            return;
        };
        assert!(
            !path.contains(' ') || path.contains(':'),
            "resolved PATH should be colon-separated (or contain no spaces at all), got: {path}"
        );
    }
}
