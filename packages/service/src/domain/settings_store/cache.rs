//! Watcher-invalidated in-memory cache for settings JSON documents.
//!
//! Reads hit the cache only while the file's directory is actively watched by
//! [`super::watcher`]. When no watcher is active (unit tests doing raw
//! `std::fs::write`, `mcp-serve`), every read goes directly to disk so external
//! edits are always visible immediately.
//!
//! The watcher is not trusted alone: every hit is checked against a
//! [`fingerprint::Fingerprint`] (one `stat`), so an event the OS dropped or a
//! watch that died with its directory cannot serve stale settings. Only
//! `Missing` and `Present` are cached; a read error (EMFILE, EACCES during a
//! chmod…) may be transient and is retried on the next read.

mod fingerprint;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use crate::error::AppError;

use super::{file, validate, watcher, Scope, SettingWarning};
use fingerprint::DiskState;

/// Cached parsed/validated view of one settings file on disk.
pub(crate) enum CachedEntry {
    /// File does not exist (`NotFound`).
    Missing,
    /// File exists and was read into UTF-8 text.
    Present(Box<CachedDocument>),
    /// File exists but failed to open/read; carries the exact `SETTINGS_READ_FAILED`
    /// error message so callers surface the same 422 response.
    Unreadable(String),
}

pub(crate) struct CachedDocument {
    pub raw: String,
    pub parsed_doc: Result<serde_json::Map<String, serde_json::Value>, String>,
    pub parsed_scalars: Result<(BTreeMap<String, String>, Vec<SettingWarning>), String>,
    workspace: OnceLock<(BTreeMap<String, String>, Vec<SettingWarning>)>,
    project: OnceLock<(BTreeMap<String, String>, Vec<SettingWarning>)>,
}

impl CachedDocument {
    pub(crate) fn from_text(raw: String) -> Self {
        let parsed_doc = file::parse_document(&raw);
        let parsed_scalars = match &parsed_doc {
            Ok(doc) => Ok(file::scalars_from_document(doc)),
            Err(message) => Err(message.clone()),
        };
        Self {
            raw,
            parsed_doc,
            parsed_scalars,
            workspace: OnceLock::new(),
            project: OnceLock::new(),
        }
    }

    fn validated_ref(&self, scope: Scope) -> &(BTreeMap<String, String>, Vec<SettingWarning>) {
        let slot = match scope {
            Scope::Workspace => &self.workspace,
            Scope::Project => &self.project,
        };
        slot.get_or_init(|| validate_parsed(&self.parsed_scalars, scope))
    }

    pub(crate) fn validated(
        &self,
        scope: Scope,
    ) -> (BTreeMap<String, String>, Vec<SettingWarning>) {
        self.validated_ref(scope).clone()
    }

    pub(crate) fn get_validated(&self, scope: Scope, key: &str) -> Option<String> {
        self.validated_ref(scope).0.get(key).cloned()
    }

    pub(crate) fn validated_warnings(&self, scope: Scope) -> Vec<SettingWarning> {
        self.validated_ref(scope).1.clone()
    }
}

fn validate_parsed(
    parsed: &Result<(BTreeMap<String, String>, Vec<SettingWarning>), String>,
    scope: Scope,
) -> (BTreeMap<String, String>, Vec<SettingWarning>) {
    match parsed {
        Ok((map, parse_warnings)) => {
            let (clean, mut validation_warnings) = validate::validate(scope, map.clone());
            let mut warnings = parse_warnings.clone();
            warnings.append(&mut validation_warnings);
            (clean, warnings)
        }
        Err(message) => (
            BTreeMap::new(),
            vec![SettingWarning::new("", message.clone())],
        ),
    }
}

struct CacheSlot {
    entry: Arc<CachedEntry>,
    disk: DiskState,
}

#[derive(Default)]
struct CacheStore {
    generation: u64,
    entries: HashMap<PathBuf, CacheSlot>,
}

static CACHE: OnceLock<RwLock<CacheStore>> = OnceLock::new();

fn cache() -> &'static RwLock<CacheStore> {
    CACHE.get_or_init(|| RwLock::new(CacheStore::default()))
}

fn load_from_disk(path: &Path) -> CachedEntry {
    match file::read_file(path) {
        Ok(Some(text)) => CachedEntry::Present(Box::new(CachedDocument::from_text(text))),
        Ok(None) => CachedEntry::Missing,
        Err(error) => CachedEntry::Unreadable(error.to_string()),
    }
}

/// Whether a freshly loaded `entry` agrees with the `disk` state seen before
/// loading it. A file created or deleted in between does not get cached.
fn matches_disk(entry: &CachedEntry, disk: DiskState) -> bool {
    match (entry, disk) {
        (CachedEntry::Missing, DiskState::Missing) => true,
        (CachedEntry::Present(_), DiskState::File(_)) => true,
        // Read errors are never cached: they may be gone on the next read.
        _ => false,
    }
}

/// Read a settings file through the watcher-invalidated cache when its
/// directory is actively watched, or directly from disk otherwise.
pub(crate) fn get_or_load(path: &Path) -> Arc<CachedEntry> {
    get_or_load_with(path, load_from_disk)
}

fn get_or_load_with(path: &Path, load: impl FnOnce(&Path) -> CachedEntry) -> Arc<CachedEntry> {
    let Some(key) = watcher::watched_cache_key(path) else {
        return Arc::new(load(path));
    };
    // Stat before reading: a change racing the read leaves a stamp older than
    // the bytes, which the next hit sees as stale, never the reverse.
    let Some(disk) = fingerprint::disk_state(path) else {
        return Arc::new(load(path));
    };

    let generation = {
        let store = cache().read().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = store.entries.get(&key) {
            if slot.disk == disk {
                return Arc::clone(&slot.entry);
            }
        }
        store.generation
    };

    let entry = Arc::new(load(path));
    // Re-check both that the watcher is still running and that no concurrent
    // write or invalidation raced with our cold load before inserting.
    if matches_disk(&entry, disk) && watcher::watched_cache_key(path).is_some() {
        let mut store = cache().write().unwrap_or_else(|e| e.into_inner());
        if store.generation == generation {
            let slot = CacheSlot {
                entry: Arc::clone(&entry),
                disk,
            };
            store.entries.insert(key, slot);
        }
    }
    entry
}

/// Drop one canonical cache key (called by the watcher before bumping
/// generations or broadcasting change events).
pub(crate) fn invalidate_key(key: &Path) {
    let mut store = cache().write().unwrap_or_else(|e| e.into_inner());
    store.generation = store.generation.wrapping_add(1);
    store.entries.remove(key);
}

/// Drop any cached entry for `path`: after an internal write (called under
/// `WRITE_LOCK`), a project settings rename or undo. The next read reloads
/// from disk; caching our own text instead could pair it with the stamp of an
/// external save that landed right after our rename.
pub(crate) fn invalidate_path(path: &Path) {
    let mut store = cache().write().unwrap_or_else(|e| e.into_inner());
    store.generation = store.generation.wrapping_add(1);
    store.entries.remove(path);
    if let Some(key) = watcher::watched_cache_key(path) {
        store.entries.remove(&key);
    }
}

/// Drop every cached entry belonging to `dir` when its watcher stops.
pub(crate) fn invalidate_dir(dir: &Path) {
    let mut store = cache().write().unwrap_or_else(|e| e.into_inner());
    store.generation = store.generation.wrapping_add(1);
    store.entries.retain(|key, _| key.parent() != Some(dir));
}

/// Whether `path` currently has a cache entry (tests only).
#[cfg(test)]
pub(crate) fn is_cached(path: &Path) -> bool {
    watcher::watched_cache_key(path).is_some_and(|key| {
        let store = cache().read().unwrap_or_else(|e| e.into_inner());
        store.entries.contains_key(&key)
    })
}

/// Read the parsed JSON document for `path` through the watcher-invalidated
/// cache when watched (or directly from disk when unwatched). Returns `Ok(None)`
/// if missing, `Err(BadRequest)` if malformed JSON, and `Err(SETTINGS_READ_FAILED)`
/// if unreadable.
pub fn read_document(
    path: &Path,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, AppError> {
    match get_or_load(path).as_ref() {
        CachedEntry::Missing => Ok(None),
        CachedEntry::Unreadable(message) => Err(file::read_failed_from_message(message.clone())),
        CachedEntry::Present(doc) => doc
            .parsed_doc
            .clone()
            .map(Some)
            .map_err(AppError::BadRequest),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tokio::sync::broadcast;

    use crate::domain::settings_store::{store, SettingsChangeEvent};

    #[tokio::test]
    async fn internal_write_updates_cache_immediately_and_watcher_reloads_external_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        file::write_atomic(&path, r#"{"theme_current":"aurora"}"#).unwrap();

        let (tx, mut rx) = broadcast::channel::<SettingsChangeEvent>(16);
        let guard = watcher::start_guarded_with_debounce(dir.path(), Duration::from_millis(80), tx)
            .expect("watcher should start");
        assert!(watcher::is_running());

        // Let the OS watch stream settle and drain any initial creation event.
        tokio::time::sleep(Duration::from_millis(250)).await;
        while rx.try_recv().is_ok() {}

        // Cold read populates cache.
        assert_eq!(
            store::load(&path, Scope::Workspace)
                .0
                .get("theme_current")
                .map(String::as_str),
            Some("aurora")
        );

        // Internal write updates cache immediately before any watcher debounce fires.
        store::set_value(&path, "theme_current", "tokyo-night")
            .await
            .unwrap();
        assert_eq!(
            store::load(&path, Scope::Workspace)
                .0
                .get("theme_current")
                .map(String::as_str),
            Some("tokyo-night")
        );
        // Cached `read_document` agrees immediately too.
        let doc = read_document(&path).unwrap().unwrap();
        assert_eq!(doc["theme_current"], serde_json::json!("tokyo-night"));

        // Drain the watcher event from our own internal write before external edit.
        tokio::time::sleep(Duration::from_millis(300)).await;
        while rx.try_recv().is_ok() {}

        // External write invalidates cache via watcher and reloads new value.
        std::fs::write(&path, r#"{"theme_current":"dracula"}"#).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut saw_event = false;
        while Instant::now() < deadline {
            if rx.try_recv().is_ok() {
                saw_event = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(saw_event, "watcher should fire on external std::fs::write");
        assert_eq!(
            store::load(&path, Scope::Workspace)
                .0
                .get("theme_current")
                .map(String::as_str),
            Some("dracula")
        );

        drop(guard);
    }

    /// A watcher that will not report anything during the test, so only the
    /// cache's own checks can make a read fresh.
    fn silent_watcher(dir: &Path) -> watcher::WatcherGuard {
        let (tx, _rx) = broadcast::channel::<SettingsChangeEvent>(16);
        watcher::start_guarded_with_debounce(dir, Duration::from_secs(600), tx)
            .expect("watcher should start")
    }

    #[tokio::test]
    async fn cached_reads_preserve_corrupt_and_unreadable_behavior() {
        let dir = tempfile::tempdir().unwrap();
        let corrupt = dir.path().join("settings.json");
        std::fs::write(&corrupt, "{ broken json").unwrap();
        let unreadable = dir.path().join("bad.settings.json");
        std::fs::create_dir(&unreadable).unwrap();
        let guard = silent_watcher(dir.path());

        // Corrupt JSON degrades to empty map + warning on `store::read` and errors on `read_document`.
        let (map, warnings) = store::read(&corrupt, Scope::Workspace).unwrap();
        assert!(map.is_empty());
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            read_document(&corrupt),
            Err(AppError::BadRequest(_))
        ));

        // Unreadable directory surfaces SETTINGS_READ_FAILED with cause on every read.
        for _ in 0..2 {
            let err = store::read(&unreadable, Scope::Workspace)
                .unwrap_err()
                .to_string();
            assert!(err.to_lowercase().contains("directory"), "{err}");
            assert!(read_document(&unreadable).is_err());
        }

        // The error was not cached: once the cause is gone the next read
        // succeeds, without waiting for a watcher event.
        std::fs::remove_dir(&unreadable).unwrap();
        std::fs::write(&unreadable, r#"{"theme_current":"aurora"}"#).unwrap();
        let (map, _) = store::read(&unreadable, Scope::Workspace).unwrap();
        assert_eq!(map.get("theme_current").map(String::as_str), Some("aurora"));

        drop(guard);
    }

    #[tokio::test]
    async fn a_transient_read_error_is_retried_on_the_next_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        file::write_atomic(&path, r#"{"theme_current":"aurora"}"#).unwrap();
        let guard = silent_watcher(dir.path());

        let failed = get_or_load_with(&path, |_| {
            CachedEntry::Unreadable("Too many open files (os error 24)".to_string())
        });
        assert!(matches!(failed.as_ref(), CachedEntry::Unreadable(_)));
        assert!(
            matches!(get_or_load(&path).as_ref(), CachedEntry::Present(_)),
            "a read error must not be served from the cache"
        );

        drop(guard);
    }

    #[tokio::test]
    async fn an_edit_the_watcher_has_not_reported_is_still_read_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        file::write_atomic(&path, r#"{"theme_current":"aurora"}"#).unwrap();
        let guard = silent_watcher(dir.path());
        let theme = || {
            store::load(&path, Scope::Workspace)
                .0
                .get("theme_current")
                .cloned()
        };

        assert_eq!(theme().as_deref(), Some("aurora"));
        assert!(matches!(
            get_or_load(&path).as_ref(),
            CachedEntry::Present(_)
        ));

        // In place, then atomically replaced, then deleted: no watcher event
        // has been delivered for any of these yet.
        std::fs::write(&path, r#"{"theme_current":"dracula"}"#).unwrap();
        assert_eq!(theme().as_deref(), Some("dracula"));
        file::write_atomic(&path, r#"{"theme_current":"tokyo-night"}"#).unwrap();
        assert_eq!(theme().as_deref(), Some("tokyo-night"));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(theme(), None);

        drop(guard);
    }

    #[tokio::test]
    async fn cold_read_cannot_poison_cache_after_concurrent_write_or_invalidation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        file::write_atomic(&path, r#"{"theme_current":"v1"}"#).unwrap();

        let (tx, _rx) = broadcast::channel::<SettingsChangeEvent>(16);
        let guard = watcher::start_guarded_with_debounce(dir.path(), Duration::from_millis(80), tx)
            .expect("watcher should start");

        // Case 1: an internal write lands while a cold read is in flight.
        let _stale = get_or_load_with(&path, |_| {
            file::write_atomic(&path, r#"{"theme_current":"fresh"}"#).unwrap();
            invalidate_path(&path);
            CachedEntry::Present(Box::new(CachedDocument::from_text(
                r#"{"theme_current":"stale"}"#.to_string(),
            )))
        });
        assert_eq!(
            store::load(&path, Scope::Workspace)
                .0
                .get("theme_current")
                .map(String::as_str),
            Some("fresh"),
            "stale cold load must not overwrite a concurrent internal write"
        );

        // Case 2: an invalidation lands while a cold read is in flight.
        let key = watcher::watched_cache_key(&path).expect("watched key");
        invalidate_key(&key);
        file::write_atomic(&path, r#"{"theme_current":"disk-v2"}"#).unwrap();

        let _stale = get_or_load_with(&path, |_| {
            invalidate_key(&key);
            CachedEntry::Present(Box::new(CachedDocument::from_text(
                r#"{"theme_current":"stale-v1"}"#.to_string(),
            )))
        });
        assert_eq!(
            store::load(&path, Scope::Workspace)
                .0
                .get("theme_current")
                .map(String::as_str),
            Some("disk-v2"),
            "stale cold load must not populate cache after concurrent invalidation"
        );

        drop(guard);
    }

    #[test]
    fn cached_document_validates_scopes_lazily() {
        let doc = CachedDocument::from_text(r#"{"theme_current":"aurora"}"#.to_string());
        assert!(doc.workspace.get().is_none());
        assert!(doc.project.get().is_none());

        assert_eq!(
            doc.get_validated(Scope::Workspace, "theme_current")
                .as_deref(),
            Some("aurora")
        );
        assert!(doc.workspace.get().is_some());
        assert!(
            doc.project.get().is_none(),
            "reading workspace scope must not eagerly validate project scope"
        );
    }
}
