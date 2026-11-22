//! Watches the settings directory and broadcasts a change event when a settings
//! file is created/modified — by our own writes or an external editor/script.
//! The broadcast drives the frontend to re-fetch so external edits show up live.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use notify_debouncer_mini::notify::RecursiveMode;
use tokio::sync::broadcast;

use crate::shared::file_watch::{watch_dir_managed, WatchHandle};

use super::{cache, paths, SettingsChangeEvent};

/// Settings edits are not a live-preview surface, so a longer window than the
/// themes watcher uses is fine — it collapses the burst one save fans out into.
const DEBOUNCE: Duration = Duration::from_millis(500);

static WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);
static NEXT_WATCH_ID: AtomicU64 = AtomicU64::new(1);
static WATCHED_DIRS: OnceLock<RwLock<Vec<WatchedDir>>> = OnceLock::new();
static PROCESS_WATCHERS: Mutex<Vec<WatcherGuard>> = Mutex::new(Vec::new());

struct WatchedDir {
    id: u64,
    raw: PathBuf,
    canon: Option<PathBuf>,
}

impl WatchedDir {
    fn cache_dir(&self) -> &Path {
        self.canon.as_deref().unwrap_or(&self.raw)
    }

    fn matches_parent(&self, parent: &Path) -> bool {
        parent == self.raw || self.canon.as_deref() == Some(parent)
    }
}

fn watched_dirs() -> &'static RwLock<Vec<WatchedDir>> {
    WATCHED_DIRS.get_or_init(|| RwLock::new(Vec::new()))
}

/// Whether at least one settings watcher is currently active.
pub fn is_running() -> bool {
    WATCHER_RUNNING.load(Ordering::Acquire)
}

/// Canonical cache key for `path` if its parent directory is currently watched,
/// or `None` when reads must bypass the cache and go straight to disk.
pub(crate) fn watched_cache_key(path: &Path) -> Option<PathBuf> {
    if !is_running() {
        return None;
    }
    let parent = path.parent()?;
    let name = path.file_name()?;
    let dirs = watched_dirs().read().unwrap_or_else(|e| e.into_inner());
    dirs.iter()
        .find(|entry| entry.matches_parent(parent))
        .map(|entry| entry.cache_dir().join(name))
}

/// Owns an active settings watcher; dropping it stops watching, clears cached
/// entries for that directory, and updates [`is_running`].
pub(crate) struct WatcherGuard {
    id: u64,
    cache_dir: PathBuf,
    _handle: WatchHandle,
}

impl Drop for WatcherGuard {
    fn drop(&mut self) {
        let mut dirs = watched_dirs().write().unwrap_or_else(|e| e.into_inner());
        dirs.retain(|entry| entry.id != self.id);
        if dirs.is_empty() {
            WATCHER_RUNNING.store(false, Ordering::Release);
        }
        drop(dirs);
        cache::invalidate_dir(&self.cache_dir);
    }
}

/// Start watching `dir` (non-recursive). Best-effort: a failure is logged but
/// never fatal — settings still work, just without live external-edit refresh.
pub fn start(dir: &Path, tx: broadcast::Sender<SettingsChangeEvent>) {
    if let Some(guard) = start_guarded_with_debounce(dir, DEBOUNCE, tx) {
        if let Ok(mut watchers) = PROCESS_WATCHERS.lock() {
            watchers.push(guard);
        }
    }
}

pub(crate) fn start_guarded_with_debounce(
    dir: &Path,
    debounce: Duration,
    tx: broadcast::Sender<SettingsChangeEvent>,
) -> Option<WatcherGuard> {
    let raw = dir.to_path_buf();
    let canon = std::fs::canonicalize(dir).ok();
    let cache_dir = canon.clone().unwrap_or_else(|| raw.clone());
    let cache_dir_cb = cache_dir.clone();

    let handle = watch_dir_managed(
        dir,
        RecursiveMode::NonRecursive,
        debounce,
        tx,
        move |path| {
            settings_file_name(path).map(|file| {
                // Invalidate cache BEFORE bumping global generation or notifying
                // consumers so any immediate reload sees fresh bytes from disk.
                cache::invalidate_key(&cache_dir_cb.join(&file));
                if file == paths::GLOBAL_FILE_NAME {
                    super::generation::bump_global();
                    crate::domain::telemetry::settings_changed();
                }
                SettingsChangeEvent { file }
            })
        },
    )?;

    let id = NEXT_WATCH_ID.fetch_add(1, Ordering::Relaxed);
    {
        let mut dirs = watched_dirs().write().unwrap_or_else(|e| e.into_inner());
        dirs.push(WatchedDir { id, raw, canon });
        WATCHER_RUNNING.store(true, Ordering::Release);
    }

    Some(WatcherGuard {
        id,
        cache_dir,
        _handle: handle,
    })
}

/// Returns the file name if `path` is a settings document we care about
/// (`settings.json` or `*.settings.json`), filtering out the dotfile temp files
/// our atomic writes create.
fn settings_file_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if name.starts_with('.') {
        return None;
    }
    if name == paths::GLOBAL_FILE_NAME || name.ends_with(".settings.json") {
        Some(name.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn recognizes_settings_files() {
        assert_eq!(
            settings_file_name(&PathBuf::from("/s/settings.json")),
            Some("settings.json".to_string())
        );
        assert_eq!(
            settings_file_name(&PathBuf::from("/s/my-project.settings.json")),
            Some("my-project.settings.json".to_string())
        );
    }

    #[test]
    fn ignores_temp_and_unrelated_files() {
        assert!(settings_file_name(&PathBuf::from("/s/.settings.json.tmp")).is_none());
        assert!(settings_file_name(&PathBuf::from("/s/notes.txt")).is_none());
        assert!(settings_file_name(&PathBuf::from("/s/cadencr.db")).is_none());
    }

    #[test]
    fn reading_settings_ten_times_emits_zero_change_events() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        super::super::file::write_atomic(&file, r#"{"theme_current":"aurora"}"#).unwrap();

        let (tx, mut rx) = broadcast::channel::<SettingsChangeEvent>(32);
        let guard = start_guarded_with_debounce(dir.path(), Duration::from_millis(80), tx)
            .expect("settings watcher should start");
        assert!(is_running());

        // Let the OS event stream settle and flush any initial write event.
        std::thread::sleep(Duration::from_millis(250));
        while rx.try_recv().is_ok() {}

        for _ in 0..10 {
            let text = super::super::file::read_file(&file).unwrap().unwrap();
            assert!(text.contains("aurora"));
        }

        std::thread::sleep(Duration::from_millis(250));
        assert!(
            rx.try_recv().is_err(),
            "calling read_file 10 times must emit zero SettingsChangeEvent"
        );

        drop(guard);
    }
}
