//! Process-wide settings directory, set once at startup.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static SETTINGS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Tighten existing settings documents before any credentials are loaded.
pub fn secure(dir: &Path) -> anyhow::Result<()> {
    crate::remote::secure_fs::create_dir_owner_only(dir)?;
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name == "settings.json" || name.ends_with(".settings.json") {
            crate::remote::secure_fs::ensure_owner_only(&path)?;
        }
    }
    Ok(())
}

/// Set the settings directory. Called once from `main` after the path is
/// resolved. Subsequent calls are ignored (the first one wins).
pub fn init(dir: PathBuf) {
    let _ = SETTINGS_DIR.set(dir);
}

/// The active settings directory. In production this is always initialized by
/// `main`. The fallback is a non-existent temp path (never the real user
/// settings dir) so that test code which forgot to initialize reads as empty
/// instead of silently touching `~/.cadencr/settings`.
///
/// In `cfg(test)` builds every test gets its own isolated settings dir: libtest
/// spawns a fresh OS thread per test case, so a per-thread directory keeps tests
/// that exercise the global store (via `get_setting`/`set_setting`/etc.) from
/// leaking state into one another through a shared file. There are no
/// multi-threaded tokio tests, so a `#[tokio::test]` body and any task it spawns
/// share the one thread and therefore the same isolated dir.
pub fn global_dir() -> PathBuf {
    #[cfg(test)]
    {
        test_dir()
    }
    #[cfg(not(test))]
    {
        SETTINGS_DIR
            .get()
            .cloned()
            .unwrap_or_else(|| std::env::temp_dir().join("cadencr-settings-uninitialized"))
    }
}

/// A sibling of the settings dir — `~/.cadencr/<name>` in production, since
/// settings live at `~/.cadencr/settings`. Used by everything else that owns a
/// user-visible directory under the Cadencr home (themes, diagnostics), so the
/// derivation exists once and inherits the per-test isolation above.
///
/// In test builds the directory *nests* inside the per-thread settings dir
/// instead: the test settings dir sits directly in the temp dir, so its parent
/// is `/tmp` — shared between tests and outside the sandbox.
pub fn sibling_dir(name: &str) -> PathBuf {
    let settings = global_dir();
    #[cfg(test)]
    {
        settings.join(name)
    }
    #[cfg(not(test))]
    settings
        .parent()
        .map(|parent| parent.join(name))
        .unwrap_or_else(|| settings.join(name))
}

/// A sibling that holds regenerable or installed **data** (plugins, provider
/// installations, trust state, publication work). Same as [`sibling_dir`]
/// except in the Linux XDG layout, where the settings dir lives under
/// `$XDG_CONFIG_HOME/cadencr` and data belongs under `$XDG_DATA_HOME/cadencr`.
pub fn data_sibling_dir(name: &str) -> PathBuf {
    placed_sibling(name, SiblingRoot::Data)
}

/// A sibling that holds **cache** content (learned caches, diagnostics dumps).
/// Same as [`sibling_dir`] except in the Linux XDG layout, where it moves under
/// `$XDG_CACHE_HOME/cadencr`.
pub fn cache_sibling_dir(name: &str) -> PathBuf {
    placed_sibling(name, SiblingRoot::Cache)
}

enum SiblingRoot {
    Data,
    Cache,
}

fn placed_sibling(name: &str, root: SiblingRoot) -> PathBuf {
    #[cfg(test)]
    {
        let _ = root;
        global_dir().join(name)
    }
    #[cfg(not(test))]
    {
        use crate::shared::app_paths;
        let target = match root {
            SiblingRoot::Data => app_paths::data_dir(),
            SiblingRoot::Cache => app_paths::cache_dir(),
        };
        relocated_sibling(
            &global_dir(),
            app_paths::config_dir()
                .ok()
                .map(canonical_or_raw)
                .as_deref(),
            target.ok().as_deref(),
            name,
        )
        .unwrap_or_else(|| sibling_dir(name))
    }
}

#[cfg(not(test))]
fn canonical_or_raw(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

/// `Some(<target_root>/<name>)` only when the settings dir is
/// `<config_root>/settings` and the config root differs from the target root —
/// i.e. the Linux XDG production layout. macOS (settings at `~/.cadencr/settings`,
/// config root `~/.cadencr/config`) and dev/ad-hoc layouts return `None`, so
/// they keep the historical sibling path byte-for-byte.
fn relocated_sibling(
    settings: &Path,
    config_root: Option<&Path>,
    target_root: Option<&Path>,
    name: &str,
) -> Option<PathBuf> {
    let (config_root, target_root) = (config_root?, target_root?);
    (settings.parent()? == config_root && config_root != target_root)
        .then(|| target_root.join(name))
}

/// Unique, per-test-thread settings directory (test builds only).
#[cfg(test)]
fn test_dir() -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    thread_local! {
        static DIR: PathBuf = {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("cadencr-settings-test-{}-{n}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            dir
        };
    }
    DIR.with(Clone::clone)
}

/// Resolve the settings directory from CLI/env config, falling back to a layout
/// derived from the database path. Production passes `--settings-dir`
/// explicitly; this derivation keeps dev/CLI runs working without it.
pub fn resolve_from_config(settings_dir: Option<&str>, db_path: &str) -> PathBuf {
    if let Some(dir) = settings_dir {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    derive_from_db_path(db_path)
}

/// Production DB layout is `<base>/database/<db>` → settings live at
/// `<base>/settings`. For any other layout (dev, ad-hoc CLI) we place a
/// `cadencr-settings` dir next to the database file.
fn derive_from_db_path(db_path: &str) -> PathBuf {
    let p = Path::new(db_path);
    if let Some(db_dir) = p.parent() {
        if db_dir.file_name().is_some_and(|n| n == "database") {
            if let Some(base) = db_dir.parent() {
                return base.join("settings");
            }
        }
        return db_dir.join("cadencr-settings");
    }
    PathBuf::from("cadencr-settings")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_value_wins() {
        let dir = resolve_from_config(Some("/custom/dir"), "/home/u/.cadencr/database/x.db");
        assert_eq!(dir, PathBuf::from("/custom/dir"));
    }

    #[test]
    fn empty_config_falls_through() {
        let dir = resolve_from_config(Some("  "), "/home/u/.cadencr/database/x.db");
        assert_eq!(dir, PathBuf::from("/home/u/.cadencr/settings"));
    }

    #[test]
    fn derives_production_layout() {
        let dir = resolve_from_config(None, "/home/u/.cadencr/database/cadencr.db");
        assert_eq!(dir, PathBuf::from("/home/u/.cadencr/settings"));
    }

    #[test]
    fn linux_xdg_layout_moves_data_and_cache_out_of_config() {
        let settings = Path::new("/home/u/.config/cadencr/settings");
        let config = Path::new("/home/u/.config/cadencr");
        let data = Path::new("/home/u/.local/share/cadencr");
        assert_eq!(
            relocated_sibling(settings, Some(config), Some(data), "plugins"),
            Some(PathBuf::from("/home/u/.local/share/cadencr/plugins"))
        );
    }

    #[test]
    fn macos_layout_keeps_the_legacy_sibling() {
        let settings = Path::new("/Users/u/.cadencr/settings");
        let config = Path::new("/Users/u/.cadencr/config");
        let cache = Path::new("/Users/u/.cadencr/cache");
        assert_eq!(
            relocated_sibling(settings, Some(config), Some(cache), "diagnostics"),
            None
        );
    }

    #[test]
    fn dev_layout_and_unresolved_roots_keep_the_legacy_sibling() {
        let settings = Path::new("/work/service/cadencr-settings");
        let config = Path::new("/home/u/.config/cadencr");
        let data = Path::new("/home/u/.local/share/cadencr");
        assert_eq!(
            relocated_sibling(settings, Some(config), Some(data), "plugins"),
            None
        );
        let xdg_settings = Path::new("/home/u/.config/cadencr/settings");
        assert_eq!(
            relocated_sibling(xdg_settings, None, Some(data), "plugins"),
            None
        );
        assert_eq!(
            relocated_sibling(xdg_settings, Some(config), None, "plugins"),
            None
        );
    }

    #[test]
    fn derives_dev_layout_next_to_db() {
        let dir = resolve_from_config(None, "/work/service/cadencr.local.db");
        assert_eq!(dir, PathBuf::from("/work/service/cadencr-settings"));
    }
}
