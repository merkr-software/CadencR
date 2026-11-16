use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::error::SdkError;
use cli_discovery::DiscoverySpec;
use once_cell::sync::Lazy;

mod process;
mod stderr;
pub(crate) use process::CliProcess;

/// Globally-set override for the `claude` binary path. Set once at app startup
/// from settings; consulted by `find_cli` when no per-call override is given.
static BINARY_OVERRIDE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// Cache of the discovery result keyed on the override snapshot. `find_cli` is
/// hit on every spawn / supported_models / supported_commands call; without
/// this cache we'd re-walk PATH and re-spawn N `--version` subprocesses every
/// time. Invalidated whenever `set_binary_override` swaps the override.
static RESOLVED: Lazy<RwLock<Option<(Option<PathBuf>, PathBuf)>>> = Lazy::new(|| RwLock::new(None));

#[cfg(test)]
static TEST_DISCOVERY_LOCK: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));

/// Set (or clear, with `None`) the global override path for the `claude`
/// binary. Wins over `$PATH`/login-shell/well-known discovery, but loses to
/// a per-call `Options.path_to_cli`.
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

// ---------------------------------------------------------------------------
// CLI discovery
// ---------------------------------------------------------------------------

/// Provider-neutral spec for finding the `claude` binary.
///
/// Exposed publicly so the host app (e.g. an HTTP discovery endpoint or
/// onboarding picker) can call `cli_discovery::discover_all` directly
/// without re-declaring the well-known install locations.
pub fn claude_discovery_spec() -> DiscoverySpec {
    DiscoverySpec {
        bin_name: "claude".into(),
        well_known_relative_to_home: vec![
            ".claude/local",
            ".local/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".fnm/aliases/default/bin",
            ".asdf/shims",
            ".cargo/bin",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
        well_known_absolute: vec![
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
            "/usr/bin".into(),
            "/snap/bin".into(),
        ],
        version_args: vec!["--version".into()],
        version_must_contain: None,
    }
}

/// Find the `claude` CLI binary.
///
/// Discovery order:
/// 1. `path_override` (caller-supplied, e.g. user setting). Used as-is if executable.
/// 2. `$PATH` walk.
/// 3. Login-shell PATH walk (fixes macOS GUI launches that miss `~/.zshrc`).
/// 4. Well-known install dirs (Homebrew, bun, npm-global, volta, asdf, etc.).
///
/// On multiple installs, picks the highest semver. On `CliNotFound`, the error
/// carries every directory that was probed so the host can render an
/// actionable "we looked here" message.
pub async fn find_cli(path_override: Option<&Path>) -> Result<PathBuf, SdkError> {
    let spec = claude_discovery_spec();
    let global_override = current_binary_override();
    let effective_override = path_override.map(Path::to_path_buf).or(global_override);

    if let Some(path) = &effective_override {
        if !is_executable_file(path) {
            return Err(SdkError::CliNotFound {
                searched: vec![path.clone()],
            });
        }
    }

    if let Some(cached) = RESOLVED.read().ok().and_then(|guard| guard.clone()) {
        if cached.0 == effective_override {
            return Ok(cached.1);
        }
    }

    let candidates = cli_discovery::discover_all(&spec, effective_override.as_deref()).await;
    let Some(best) = cli_discovery::select_best(&candidates) else {
        return Err(SdkError::CliNotFound {
            searched: cli_discovery::searched_dirs(&spec).await,
        });
    };

    let resolved = best.path.clone();
    if let Ok(mut cache) = RESOLVED.write() {
        *cache = Some((effective_override, resolved.clone()));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn make_executable(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\necho '{}'\n").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[tokio::test]
    async fn find_cli_with_override_exists_returns_override() {
        let dir = TempDir::new().unwrap();
        let path = make_executable(dir.path(), "claude");
        let result = find_cli(Some(&path)).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), path);
    }

    #[test]
    fn claude_discovery_spec_includes_well_known_install_dirs() {
        let spec = claude_discovery_spec();
        assert_eq!(spec.bin_name, "claude");
        // The official Claude local install dir must be searched.
        assert!(spec
            .well_known_relative_to_home
            .iter()
            .any(|path| path == ".claude/local"));
        // Apple Silicon Homebrew is a critical macOS-GUI fallback.
        assert!(spec
            .well_known_absolute
            .iter()
            .any(|path| path == "/opt/homebrew/bin"));
        // Linux distro packages and snaps install outside the macOS dirs.
        for dir in ["/usr/bin", "/snap/bin"] {
            assert!(spec.well_known_absolute.iter().any(|path| path == dir));
        }
    }

    #[tokio::test]
    async fn find_cli_returns_searched_dirs_on_not_found() {
        // We can't guarantee the host machine *lacks* a claude binary, so we
        // only assert: when CliNotFound *is* returned, the `searched` list is
        // non-empty (i.e. we surface where we looked, per the new error
        // contract). Skipping when the host machine has claude installed.
        let bogus_override = Path::new("/definitely/not/here/claude");
        let result = find_cli(Some(bogus_override)).await;
        match result {
            Ok(_) => {} // host has a real claude — skip
            Err(SdkError::CliNotFound { searched }) => {
                assert!(!searched.is_empty(), "searched dirs must be reported");
            }
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn missing_explicit_override_does_not_fall_through_to_path() {
        let _guard = TEST_DISCOVERY_LOCK.lock().await;
        let dir = TempDir::new().unwrap();
        let path_binary = make_executable(dir.path(), "claude");
        let prior_path = std::env::var_os("PATH");
        let prior_override = current_binary_override();

        set_binary_override(None);
        std::env::set_var("PATH", dir.path());
        if let Ok(mut cache) = RESOLVED.write() {
            *cache = None;
        }

        let missing_override = dir.path().join("missing-claude");
        let result = find_cli(Some(&missing_override)).await;

        match prior_path {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }
        set_binary_override(prior_override);

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
