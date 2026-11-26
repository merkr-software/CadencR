//! Read/write API over the settings files. This module holds the pure,
//! dir-based core functions (testable with temp dirs); the `global` and
//! `project` submodules wrap them, resolving the active settings dir from
//! `dir::global_dir()`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::error::AppError;

use super::cache::{self, CachedEntry};
use super::{file, lock, validate, Scope, SettingWarning};

mod global;
mod project;
mod scalars;
pub(super) use scalars::set_value;
use scalars::set_values;

pub use global::*;
pub use project::*;

pub type SettingsMap = (PathBuf, BTreeMap<String, String>, Vec<SettingWarning>);

/// Read + parse + validate a settings file. Never errors: a missing file is an
/// empty map, and a malformed file degrades to an empty map plus a warning so a
/// corrupt file can't brick the app on a hot read path.
pub fn load(path: &Path, scope: Scope) -> (BTreeMap<String, String>, Vec<SettingWarning>) {
    match cache::get_or_load(path).as_ref() {
        CachedEntry::Missing => (BTreeMap::new(), Vec::new()),
        CachedEntry::Present(doc) => doc.validated(scope),
        CachedEntry::Unreadable(message) => (
            BTreeMap::new(),
            vec![SettingWarning::new("", message.clone())],
        ),
    }
}

/// A missing document is empty. An unreadable or malformed one is an error.
/// The scalar projection still includes per-key validation warnings.
pub fn read(
    path: &Path,
    scope: Scope,
) -> Result<(BTreeMap<String, String>, Vec<SettingWarning>), AppError> {
    let entry = cache::get_or_load(path);
    let Some(doc) = entry.readable_document()? else {
        return Ok((BTreeMap::new(), Vec::new()));
    };
    doc.parsed_doc
        .as_ref()
        .map_err(|message| file::invalid_document(path, message))?;
    Ok(doc.validated(scope))
}

/// Read a single validated scalar setting without cloning the entire map.
/// Missing or unreadable files return `None` (matching [`load`]).
pub(super) fn load_key(path: &Path, scope: Scope, key: &str) -> Option<String> {
    match cache::get_or_load(path).as_ref() {
        CachedEntry::Present(doc) => doc.get_validated(scope, key),
        CachedEntry::Missing | CachedEntry::Unreadable(_) => None,
    }
}

/// Read a setting for a runtime decision. A default is only used by callers
/// after a successful read with no value.
pub(crate) fn read_key(path: &Path, scope: Scope, key: &str) -> Result<Option<String>, AppError> {
    cache::inspect_document(path, |doc| match doc {
        Some(doc) => file::read_scalar(doc, scope, key),
        None => Ok(None),
    })
}

/// Read the full stored document (all keys preserved, nested sections intact) for
/// a read-modify-write. Errors if the existing file isn't valid JSON so a single
/// key write never silently clobbers a file a user is mid-edit on.
pub(super) fn load_document_for_write(
    path: &Path,
) -> Result<serde_json::Map<String, serde_json::Value>, AppError> {
    match file::read_file(path)? {
        Some(text) => {
            file::parse_document(&text).map_err(|message| file::invalid_document(path, &message))
        }
        None => Ok(serde_json::Map::new()),
    }
}

/// How [`update_document_locked`] handles a missing or unparseable settings file.
pub(crate) enum ReadPolicy {
    /// Missing file starts from `{}`; invalid JSON returns `BadRequest` so a
    /// write never clobbers a file the user is mid-edit on.
    Strict,
    /// Missing or invalid JSON leaves the file untouched and returns `Ok(None)`
    /// without calling `mutate`. Used by best-effort startup cleanups.
    SkipMissingOrCorrupt,
}

/// Serialize a read-modify-write over `path` under `WRITE_LOCK`, offloading
/// disk I/O and JSON serialization to `spawn_blocking` and refreshing the
/// watcher cache whenever a write occurs.
///
/// The lock guard moves into the blocking task: if the caller's future is
/// dropped (client gone, request cancelled), the task still runs to the end,
/// and the lock must stay held until it does or another writer could read the
/// old document and overwrite this write.
///
/// `mutate` returns `Ok((value, true))` to persist the updated document or
/// `Ok((value, false))` to leave disk untouched.
pub(crate) async fn update_document_locked<T, F>(
    path: &Path,
    policy: ReadPolicy,
    task_label: &'static str,
    mutate: F,
) -> Result<Option<T>, AppError>
where
    T: Send + 'static,
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(T, bool), AppError>
        + Send
        + 'static,
{
    let owned_path = path.to_path_buf();
    let guard = lock::write_lock().lock().await;
    tokio::task::spawn_blocking(move || -> Result<Option<T>, AppError> {
        let _guard = guard;
        let mut doc = match policy {
            ReadPolicy::Strict => load_document_for_write(&owned_path)?,
            ReadPolicy::SkipMissingOrCorrupt => {
                let Some(text) = file::read_file(&owned_path)? else {
                    return Ok(None);
                };
                let Ok(doc) = file::parse_document(&text) else {
                    // Don't touch a file we can't parse — the user can fix it via "Edit JSON".
                    return Ok(None);
                };
                doc
            }
        };
        let (value, changed) = mutate(&mut doc)?;
        if changed {
            let serialized = file::serialize_document(&doc);
            file::write_atomic(&owned_path, &serialized)?;
            cache::invalidate_path(&owned_path);
        }
        Ok(Some(value))
    })
    .await
    .map_err(|error| AppError::internal(format!("{task_label} task failed: {error}")))?
}

/// Atomically write an already-serialized document and refresh the watcher
/// cache. Takes the `WRITE_LOCK` guard by value and releases it only when the
/// blocking write is done, even if the caller's future is dropped first.
pub(super) async fn write_serialized_under_lock(
    guard: tokio::sync::MutexGuard<'static, ()>,
    path: &Path,
    serialized: String,
    task_label: &'static str,
) -> Result<(), AppError> {
    let owned_path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        file::write_atomic(&owned_path, &serialized)?;
        cache::invalidate_path(&owned_path);
        Ok(())
    })
    .await
    .map_err(|error| AppError::internal(format!("{task_label} task failed: {error}")))?
}

/// Validate and atomically write a full settings document (the "Edit JSON" save
/// path). The document is written verbatim (nested sections preserved); only the
/// flat scalar projection is validated for warnings. Errors only on invalid JSON.
pub(super) async fn write_content(
    path: &Path,
    scope: Scope,
    content: &str,
) -> Result<Vec<SettingWarning>, AppError> {
    let doc = file::parse_document(content).map_err(AppError::BadRequest)?;
    let (scalars, mut warnings) = file::scalars_from_document(&doc);
    let (_clean, mut validation_warnings) = validate::validate(scope, scalars);
    warnings.append(&mut validation_warnings);

    let serialized = file::serialize_document(&doc);
    let guard = lock::write_lock().lock().await;
    write_serialized_under_lock(guard, path, serialized, "settings write").await?;
    Ok(warnings)
}

/// Current document text for the editor, plus warnings. Empty file → `{}`.
pub fn read_for_edit(path: &Path, scope: Scope) -> (String, Vec<SettingWarning>) {
    match cache::get_or_load(path).as_ref() {
        CachedEntry::Present(doc) if !doc.raw.trim().is_empty() => {
            (doc.raw.clone(), doc.validated_warnings(scope))
        }
        CachedEntry::Present(_) | CachedEntry::Missing => ("{}\n".to_string(), Vec::new()),
        CachedEntry::Unreadable(message) => (
            "{}\n".to_string(),
            vec![SettingWarning::new("", message.clone())],
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_writer_keeps_the_lock_until_its_write_lands() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let task_path = path.clone();
        let task = tokio::spawn(async move {
            update_document_locked(&task_path, ReadPolicy::Strict, "test", move |doc| {
                started_tx.send(()).expect("test waiting");
                release_rx.recv().expect("test releases");
                doc.insert("theme_current".into(), "aurora".into());
                Ok(((), true))
            })
            .await
        });
        tokio::task::spawn_blocking(move || started_rx.recv())
            .await
            .unwrap()
            .expect("the read-modify-write started");

        // The handler is dropped while its blocking write is still running.
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(
            lock::write_lock().try_lock().is_err(),
            "the lock must stay held until the in-flight write lands"
        );

        release_tx.send(()).unwrap();
        let _held =
            tokio::time::timeout(std::time::Duration::from_secs(5), lock::write_lock().lock())
                .await
                .expect("the lock is released once the write finishes");
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("aurora"), "{written}");
    }

    #[tokio::test]
    async fn set_preserves_other_and_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        set_value(&path, "theme_current", "tokyo-night")
            .await
            .unwrap();
        set_value(&path, "totally_made_up", "keepme").await.unwrap();
        set_value(&path, "editor_auto_save", "false").await.unwrap();

        let (map, _w) = load(&path, Scope::Workspace);
        assert_eq!(
            map.get("theme_current").map(String::as_str),
            Some("tokyo-night")
        );
        assert_eq!(
            map.get("editor_auto_save").map(String::as_str),
            Some("false")
        );
        // Unknown key survives a write to a sibling key.
        assert_eq!(
            map.get("totally_made_up").map(String::as_str),
            Some("keepme")
        );
    }

    #[tokio::test]
    async fn set_values_writes_and_removes_in_one_pass() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        set_value(&path, "sidebar_density", "compact")
            .await
            .unwrap();
        set_value(&path, "theme_current", "tokyo-night")
            .await
            .unwrap();

        let entries = BTreeMap::from([
            ("sidebar_density".to_string(), None),
            ("sidebar_row_diff".to_string(), Some("false".to_string())),
        ]);
        let (previous, changed) = set_values(&path, &entries).await.unwrap();
        assert!(changed);
        assert!(!set_values(&path, &entries).await.unwrap().1);
        assert_eq!(
            previous,
            BTreeMap::from([
                ("sidebar_density".to_string(), Some("compact".to_string())),
                ("sidebar_row_diff".to_string(), None),
            ])
        );

        let (map, _w) = load(&path, Scope::Workspace);
        assert_eq!(map.get("sidebar_density"), None);
        assert_eq!(
            map.get("sidebar_row_diff").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            map.get("theme_current").map(String::as_str),
            Some("tokyo-night")
        );
    }

    #[tokio::test]
    async fn write_content_returns_warnings_but_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let warnings = write_content(
            &path,
            Scope::Workspace,
            r#"{"editor_auto_save": "maybe", "made_up_key": "x"}"#,
        )
        .await
        .unwrap();
        assert_eq!(warnings.len(), 2);

        // The raw (user) values are persisted verbatim; validation only affects
        // what consumers read back, not the stored file.
        let text = file::read_file(&path).unwrap().unwrap();
        let (raw, _) = file::parse_object(&text).unwrap();
        assert_eq!(
            raw.get("editor_auto_save").map(String::as_str),
            Some("maybe")
        );
        assert_eq!(raw.get("made_up_key").map(String::as_str), Some("x"));

        // But a consumer read substitutes the default for the invalid value.
        let (clean, _) = load(&path, Scope::Workspace);
        assert_eq!(
            clean.get("editor_auto_save").map(String::as_str),
            Some("true")
        );
    }

    #[tokio::test]
    async fn write_content_rejects_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let err = write_content(&path, Scope::Workspace, "{ not json")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn set_does_not_clobber_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ corrupt").unwrap();
        let err = set_value(&path, "theme_current", "x").await.unwrap_err();
        assert_eq!(err.code(), file::SETTINGS_INVALID);
        // Original bytes untouched.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ corrupt");
    }

    #[test]
    fn load_degrades_gracefully_on_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ corrupt").unwrap();
        let (map, warnings) = load(&path, Scope::Workspace);
        assert!(map.is_empty());
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn read_distinguishes_missing_unreadable_and_malformed_documents() {
        let dir = tempfile::tempdir().unwrap();
        let unreadable = dir.path().join("unreadable.json");
        assert!(read(&unreadable, Scope::Workspace).unwrap().0.is_empty());
        std::fs::create_dir(&unreadable).unwrap();
        let error = read(&unreadable, Scope::Workspace).unwrap_err();
        assert!(matches!(
            error,
            AppError::Coded {
                code: file::SETTINGS_READ_FAILED,
                ..
            }
        ));
        // The cause reaches the user, not only "open private file <path>".
        assert!(
            error.to_string().to_lowercase().contains("directory"),
            "{error}"
        );

        let corrupt = dir.path().join("corrupt.json");
        std::fs::write(&corrupt, "{ corrupt").unwrap();
        assert!(matches!(
            read(&corrupt, Scope::Workspace),
            Err(AppError::Coded {
                code: file::SETTINGS_INVALID,
                ..
            })
        ));
        let (text, warnings) = read_for_edit(&corrupt, Scope::Workspace);
        assert_eq!(text, "{ corrupt");
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn load_reflects_external_edits_immediately() {
        // Reads always hit disk (no cache), so a setting changed by an external
        // editor/script is visible on the very next read.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"theme_current":"aurora"}"#).unwrap();
        assert_eq!(
            load(&path, Scope::Workspace)
                .0
                .get("theme_current")
                .map(String::as_str),
            Some("aurora")
        );
        std::fs::write(&path, r#"{"theme_current":"dracula"}"#).unwrap();
        assert_eq!(
            load(&path, Scope::Workspace)
                .0
                .get("theme_current")
                .map(String::as_str),
            Some("dracula")
        );
    }

    #[tokio::test]
    async fn concurrent_writes_do_not_lose_updates() {
        // Two writers racing on different keys must both land — the write lock
        // serializes the read-modify-write so neither clobbers the other.
        let dir = tempfile::tempdir().unwrap();
        let path = std::sync::Arc::new(dir.path().join("settings.json"));

        let mut handles = Vec::new();
        for i in 0..16 {
            let path = path.clone();
            handles.push(tokio::spawn(async move {
                set_value(&path, &format!("active_tab_{i}"), &i.to_string())
                    .await
                    .unwrap();
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        let (map, _) = load(&path, Scope::Workspace);
        for i in 0..16 {
            assert_eq!(
                map.get(&format!("active_tab_{i}")).map(String::as_str),
                Some(i.to_string().as_str()),
                "key active_tab_{i} was lost"
            );
        }
    }

    #[test]
    fn read_for_edit_returns_raw_bytes_with_warnings() {
        // The editor must see the user's raw document (not the validated view),
        // while still surfacing warnings for invalid values.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let raw = "{\n  \"editor_auto_save\": \"maybe\"\n}\n";
        std::fs::write(&path, raw).unwrap();

        let (content, warnings) = read_for_edit(&path, Scope::Workspace);
        assert_eq!(content, raw);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn read_for_edit_missing_file_is_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let (content, warnings) = read_for_edit(&path, Scope::Workspace);
        assert_eq!(content, "{}\n");
        assert!(warnings.is_empty());
    }

    #[tokio::test]
    async fn scalar_write_preserves_nested_section() {
        // A scalar write must not clobber a hand-written nested `profiles` section.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"profiles":{"bedrock":{"AWS_REGION":"us-east-1"}}}"#,
        )
        .unwrap();

        set_value(&path, "theme_current", "aurora").await.unwrap();

        let doc = file::parse_document(&file::read_file(&path).unwrap().unwrap()).unwrap();
        assert_eq!(doc["theme_current"], serde_json::json!("aurora"));
        assert_eq!(
            doc["profiles"]["bedrock"]["AWS_REGION"],
            serde_json::json!("us-east-1")
        );
    }

    #[tokio::test]
    async fn edit_json_save_preserves_nested_section() {
        // The "Edit JSON" full-document save must round-trip nested sections.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write_content(
            &path,
            Scope::Workspace,
            r#"{"theme_current":"aurora","profiles":{"vertex":{"REGION":"eu"}}}"#,
        )
        .await
        .unwrap();

        let doc = file::parse_document(&file::read_file(&path).unwrap().unwrap()).unwrap();
        assert_eq!(doc["profiles"]["vertex"]["REGION"], serde_json::json!("eu"));
    }
}
