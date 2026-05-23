//! OpenCode binary discovery + override.
//!
//! Used to also own the long-running OpenCode HTTP server (spawn,
//! monitor, health-check, shutdown). With the long-lived transport retired,
//! the only surviving responsibilities are the discovery spec the host
//! app uses to find an `opencode` binary and the settings-backed path
//! override the host can set on startup.

use cli_discovery::DiscoverySpec;
use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::error::SdkError;

/// Provider-neutral spec for finding the `opencode` binary.
///
/// Exposed publicly so the host app can call `cli_discovery::discover_all`
/// directly to render an onboarding "pick a binary" UI without re-declaring
/// the well-known install dirs here.
pub fn opencode_discovery_spec() -> DiscoverySpec {
    DiscoverySpec {
        bin_name: "opencode",
        well_known_relative_to_home: vec![".opencode/bin", ".cargo/bin"],
        well_known_absolute: vec![
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/snap/bin",
        ],
        version_args: &["--version"],
        version_must_contain: None,
    }
}

/// Globally-set override for the `opencode` binary path.
///
/// Set once by the host app at startup (e.g. read from settings).
static BINARY_OVERRIDE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

#[cfg(test)]
static TEST_DISCOVERY_LOCK: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));

/// Set (or clear, with `None`) the override path for the `opencode` binary.
///
/// The host app should call this once at startup with the user's persisted
/// setting. It wins over PATH and well-known directory discovery.
pub fn set_binary_override(path: Option<PathBuf>) {
    if let Ok(mut guard) = BINARY_OVERRIDE.write() {
        *guard = path;
    }
}

fn current_binary_override() -> Option<PathBuf> {
    BINARY_OVERRIDE.read().ok().and_then(|guard| guard.clone())
}

pub async fn resolve_binary() -> Result<PathBuf, SdkError> {
    let spec = opencode_discovery_spec();
    let override_path = current_binary_override();
    if let Some(path) = &override_path {
        if !is_executable_file(path) {
            return Err(SdkError::CliNotFound {
                searched: vec![path.clone()],
            });
        }
    }
    let candidates = cli_discovery::discover_all(&spec, override_path.as_deref()).await;
    let Some(best) = cli_discovery::select_best(&candidates) else {
        return Err(SdkError::CliNotFound {
            searched: cli_discovery::searched_dirs(&spec).await,
        });
    };
    Ok(best.path.clone())
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{
        current_binary_override, opencode_discovery_spec, resolve_binary, set_binary_override,
        TEST_DISCOVERY_LOCK,
    };
    use crate::error::SdkError;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn opencode_discovery_spec_includes_user_install_and_homebrew() {
        let spec = opencode_discovery_spec();
        assert_eq!(spec.bin_name, "opencode");
        assert!(spec.well_known_relative_to_home.contains(&".opencode/bin"));
        assert!(spec.well_known_absolute.contains(&"/opt/homebrew/bin"));
        assert!(spec.well_known_absolute.contains(&"/usr/bin"));
        assert!(spec.well_known_absolute.contains(&"/snap/bin"));
        assert!(spec.well_known_relative_to_home.contains(&".cargo/bin"));
    }

    #[tokio::test]
    async fn binary_override_round_trips() {
        let _guard = TEST_DISCOVERY_LOCK.lock().await;
        // Save and restore so this test doesn't leak state into the shared
        // singleton used by other tests in the same process.
        let prior = current_binary_override();
        let dir = tempfile::TempDir::new().unwrap();
        let fake_binary = dir.path().join("opencode");
        std::fs::write(&fake_binary, "#!/bin/sh\necho 1.2.3\n").unwrap();
        let mut perms = std::fs::metadata(&fake_binary).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o755);
        }
        std::fs::set_permissions(&fake_binary, perms).unwrap();

        set_binary_override(Some(fake_binary.clone()));
        assert_eq!(current_binary_override(), Some(fake_binary.clone()));
        assert_eq!(resolve_binary().await.unwrap(), fake_binary);
        set_binary_override(None);
        assert!(current_binary_override().is_none());
        set_binary_override(prior);
    }

    #[tokio::test]
    async fn missing_explicit_override_does_not_fall_through_to_path() {
        let _guard = TEST_DISCOVERY_LOCK.lock().await;
        let prior = current_binary_override();
        let prior_path = std::env::var_os("PATH");
        let dir = tempfile::TempDir::new().unwrap();
        let path_binary = dir.path().join("opencode");
        std::fs::write(&path_binary, "#!/bin/sh\necho 1.2.3\n").unwrap();
        let mut perms = std::fs::metadata(&path_binary).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path_binary, perms).unwrap();

        let missing_override = dir.path().join("missing-opencode");
        set_binary_override(Some(missing_override.clone()));
        std::env::set_var("PATH", dir.path());

        let result = resolve_binary().await;

        match prior_path {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }
        set_binary_override(prior);

        match result {
            Err(SdkError::CliNotFound { searched }) => {
                assert_eq!(searched, vec![missing_override.clone()]);
            }
            Ok(path) => panic!("explicit missing override fell through to {path:?}"),
            Err(other) => panic!("unexpected error: {other:?}"),
        }
        assert_ne!(path_binary, missing_override);
    }
}
