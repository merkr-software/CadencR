use std::path::{Path, PathBuf};
use std::sync::RwLock;

use cli_discovery::DiscoverySpec;

use crate::error::SdkError;

static BINARY_OVERRIDE: RwLock<Option<PathBuf>> = RwLock::new(None);
static RESOLVED: RwLock<Option<(Option<PathBuf>, PathBuf)>> = RwLock::new(None);

#[cfg(test)]
pub(crate) static TEST_DISCOVERY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Provider-neutral spec for finding the `codex` CLI binary.
///
/// Exposed so the host app can render the same binary discovery details for
/// Codex that it already renders for Claude Code and OpenCode.
pub fn codex_discovery_spec() -> DiscoverySpec {
    DiscoverySpec {
        bin_name: "codex",
        well_known_relative_to_home: vec![
            ".codex/bin",
            ".local/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".cargo/bin",
            ".volta/bin",
            ".fnm/aliases/default/bin",
            ".asdf/shims",
        ],
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

/// Set or clear the global override path for the `codex` binary.
///
/// The Cadencr service applies this once at startup from the persisted
/// workspace setting. It wins over PATH and well-known directory discovery.
pub fn set_binary_override(path: Option<PathBuf>) {
    if let Ok(mut guard) = BINARY_OVERRIDE.write() {
        *guard = path;
    }
    if let Ok(mut cache) = RESOLVED.write() {
        *cache = None;
    }
}

fn current_binary_override() -> Option<PathBuf> {
    BINARY_OVERRIDE.read().ok().and_then(|guard| guard.clone())
}

pub(crate) async fn resolved_codex_command() -> Result<PathBuf, SdkError> {
    let spec = codex_discovery_spec();
    let override_path = current_binary_override();
    if let Some(path) = &override_path {
        if !is_executable_file(path) {
            return Err(SdkError::CliNotFound {
                searched: vec![path.clone()],
            });
        }
    }
    if let Some(cached) = RESOLVED.read().ok().and_then(|guard| guard.clone()) {
        if cached.0 == override_path {
            return Ok(cached.1);
        }
    }

    let candidates = cli_discovery::discover_all(&spec, override_path.as_deref()).await;
    let Some(best) = cli_discovery::select_best(&candidates) else {
        return Err(SdkError::CliNotFound {
            searched: cli_discovery::searched_dirs(&spec).await,
        });
    };
    let resolved = best.path.clone();
    if let Ok(mut cache) = RESOLVED.write() {
        *cache = Some((override_path, resolved.clone()));
    }
    Ok(resolved)
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
    use std::path::PathBuf;
    use std::sync::MutexGuard;

    use super::{
        codex_discovery_spec, current_binary_override, resolved_codex_command, set_binary_override,
        TEST_DISCOVERY_LOCK,
    };
    use crate::error::SdkError;

    fn test_lock() -> MutexGuard<'static, ()> {
        TEST_DISCOVERY_LOCK
            .lock()
            .expect("discovery test lock poisoned")
    }

    #[test]
    fn codex_discovery_spec_uses_codex_binary() {
        let spec = codex_discovery_spec();
        assert_eq!(spec.bin_name, "codex");
        assert_eq!(spec.version_args, &["--version"]);
        assert!(spec.well_known_absolute.contains(&"/opt/homebrew/bin"));
        assert!(spec.well_known_absolute.contains(&"/usr/bin"));
        assert!(spec.well_known_absolute.contains(&"/snap/bin"));
        assert!(spec.well_known_relative_to_home.contains(&".cargo/bin"));
    }

    #[test]
    fn binary_override_round_trips() {
        let _guard = test_lock();
        let prior = current_binary_override();
        set_binary_override(Some(PathBuf::from("/custom/codex")));
        assert_eq!(
            current_binary_override(),
            Some(PathBuf::from("/custom/codex"))
        );
        set_binary_override(None);
        assert!(current_binary_override().is_none());
        set_binary_override(prior);
    }

    #[tokio::test]
    async fn missing_explicit_override_does_not_fall_through_to_path() {
        let _guard = test_lock();
        let prior = current_binary_override();
        let prior_path = std::env::var_os("PATH");
        let dir = tempfile::TempDir::new().unwrap();
        let path_binary = dir.path().join("codex");
        std::fs::write(&path_binary, "#!/bin/sh\necho codex-cli 1.2.3\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path_binary).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path_binary, perms).unwrap();
        }

        let missing_override = dir.path().join("missing-codex");
        set_binary_override(Some(missing_override.clone()));
        std::env::set_var("PATH", dir.path());

        let result = resolved_codex_command().await;

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
