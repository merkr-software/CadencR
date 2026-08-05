//! Cadencr's per-user data, config, and cache locations.
//!
//! On Linux we follow the XDG Base Directory spec — packagers, distros, and
//! sandbox tooling all expect `$XDG_DATA_HOME` / `$XDG_CONFIG_HOME` /
//! `$XDG_CACHE_HOME` (with the standard `~/.local/share`, `~/.config`,
//! `~/.cache` fallbacks). The `dirs` crate already returns those.
//!
//! On macOS we deliberately keep the legacy `~/.cadencr/...` layout for
//! **data** (database, worktrees) so existing installs, backup tooling, and
//! the `db` skill keep working with no migration. `dirs::data_dir()` on
//! macOS returns `~/Library/Application Support`, which is not where
//! Cadencr has ever stored its files, so we override the macOS branch here.
//!
//! `config` and `cache` are namespaced under `~/.cadencr/config` and
//! `~/.cadencr/cache` on macOS so they never collide with each other or
//! with `data`. If everything pointed at the same directory, a future
//! caller doing `config_dir().join("state.json")` and
//! `cache_dir().join("state.json")` would silently corrupt data on macOS
//! while behaving correctly on Linux.
//!
//! Every Cadencr callsite that needs a Cadencr-owned path on disk should go
//! through this module rather than building paths from `dirs::home_dir()` —
//! that's the single seam that keeps Linux and macOS behaviour in sync.
//!
//! Mirrored by `packages/desktop/electron/main/app-paths.ts`; the two MUST
//! agree because the Electron main process resolves the database path and
//! passes it to the spawned Rust sidecar.

use std::path::PathBuf;

const APP_DIRNAME: &str = "cadencr";
const MACOS_LEGACY_DIRNAME: &str = ".cadencr";

enum Kind {
    Data,
    Config,
    Cache,
}

/// Root directory for Cadencr's persistent user data (database, worktrees).
///
/// Linux: `$XDG_DATA_HOME/cadencr` (default `~/.local/share/cadencr`).
/// macOS: `~/.cadencr`.
pub fn data_dir() -> Result<PathBuf, String> {
    resolve(Kind::Data)
}

/// Root directory for Cadencr's user-editable configuration.
///
/// Linux: `$XDG_CONFIG_HOME/cadencr` (default `~/.config/cadencr`).
/// macOS: `~/.cadencr`.
#[allow(dead_code)] // Reserved for future config-file callers (Phase 3+).
pub fn config_dir() -> Result<PathBuf, String> {
    resolve(Kind::Config)
}

/// Root directory for Cadencr's regeneratable cache data (logs, temp files).
///
/// Linux: `$XDG_CACHE_HOME/cadencr` (default `~/.cache/cadencr`).
/// macOS: `~/.cadencr`.
#[allow(dead_code)] // Used via `logs_dir`; kept public for direct cache use.
pub fn cache_dir() -> Result<PathBuf, String> {
    resolve(Kind::Cache)
}

/// Full path to the production SQLite database file. Resolved by the Electron
/// main process and passed to the sidecar via `--db-path`; this Rust helper
/// exists so test/CLI callers don't reach for `dirs::home_dir()` directly.
#[allow(dead_code)]
pub fn database_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("database").join("cadencr.db"))
}

/// Root directory for Cadencr-managed git worktrees.
pub fn worktrees_dir() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("worktrees"))
}

/// Root directory for service / app log files.
#[allow(dead_code)] // Reserved for the first file-log writer.
pub fn logs_dir() -> Result<PathBuf, String> {
    Ok(cache_dir()?.join("logs"))
}

fn resolve(kind: Kind) -> Result<PathBuf, String> {
    if cfg!(target_os = "macos") {
        let home =
            dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
        let legacy = home.join(MACOS_LEGACY_DIRNAME);
        return Ok(match kind {
            // Data stays at the legacy root — moving it would orphan every
            // existing macOS user's database and worktrees.
            Kind::Data => legacy,
            // Config/cache live under dedicated subroots so they can never
            // collide with each other or with `data/`.
            Kind::Config => legacy.join("config"),
            Kind::Cache => legacy.join("cache"),
        });
    }
    let (root, label) = match kind {
        Kind::Data => (dirs::data_dir(), "data"),
        Kind::Config => (dirs::config_dir(), "config"),
        Kind::Cache => (dirs::cache_dir(), "cache"),
    };
    root.ok_or_else(|| format!("Could not determine XDG {label} directory"))
        .map(|p| p.join(APP_DIRNAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Linux env-var assertions mutate process-wide env, so all tests in this
    // module that touch `$HOME` / `$XDG_*` serialize on this lock. Gated to
    // Linux because it has no consumers on other platforms.
    #[cfg(target_os = "linux")]
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_data_stays_at_legacy_root_but_config_and_cache_are_namespaced() {
        let home = dirs::home_dir().unwrap();
        let legacy = home.join(MACOS_LEGACY_DIRNAME);
        // Data lives at the legacy root — existing installs depend on this.
        assert_eq!(data_dir().unwrap(), legacy);
        assert_eq!(
            database_path().unwrap(),
            legacy.join("database").join("cadencr.db")
        );
        assert_eq!(worktrees_dir().unwrap(), legacy.join("worktrees"));
        // Config and cache get their own subroots so callers can use the
        // same filename in both without colliding.
        assert_eq!(config_dir().unwrap(), legacy.join("config"));
        assert_eq!(cache_dir().unwrap(), legacy.join("cache"));
        assert_eq!(logs_dir().unwrap(), legacy.join("cache").join("logs"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_data_dir_honors_xdg_data_home() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let xdg = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("XDG_DATA_HOME");
        std::env::set_var("XDG_DATA_HOME", xdg.path());
        assert_eq!(data_dir().unwrap(), xdg.path().join("cadencr"));
        match prev {
            Some(v) => std::env::set_var("XDG_DATA_HOME", v),
            None => std::env::remove_var("XDG_DATA_HOME"),
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_data_dir_falls_back_to_local_share() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let prev_xdg = std::env::var_os("XDG_DATA_HOME");
        let prev_home = std::env::var_os("HOME");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::set_var("HOME", home.path());
        assert_eq!(
            data_dir().unwrap(),
            home.path().join(".local").join("share").join("cadencr")
        );
        match prev_xdg {
            Some(v) => std::env::set_var("XDG_DATA_HOME", v),
            None => std::env::remove_var("XDG_DATA_HOME"),
        }
        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}
