//! Read/write API over the settings files. This module holds the pure,
//! dir-based core functions (testable with temp dirs); the `global` and
//! `project` submodules wrap them, resolving the active settings dir from
//! `dir::global_dir()`.

use std::collections::BTreeMap;
use std::path::Path;

use crate::error::AppError;

use super::cache::{self, CachedEntry};
use super::{file, lock, validate, Scope, SettingWarning};

mod global;
mod project;
mod scalars;
use scalars::{set_value, set_values};

pub use global::*;
pub use project::*;

/// Read + parse + validate a settings file. Never errors: a missing file is an
/// empty map, and a malformed file degrades to an empty map plus a warning so a
/// corrupt file can't brick the app on a hot read path.
pub fn load(path: &Path, scope: Scope) -> (BTreeMap<String, String>, Vec<SettingWarning>) {
    read(path, scope).unwrap_or_else(|e| {
        (
            BTreeMap::new(),
            vec![SettingWarning::new("", e.to_string())],
        )
    })
}

/// Like [`load`], but a file that exists and cannot be read is an error rather
/// than an empty map. Invalid content still degrades to warnings. The settings
/// cascade uses this so an unreadable level never silently hands the decision
/// to the next one.
pub fn read(
    path: &Path,
    scope: Scope,
) -> Result<(BTreeMap<String, String>, Vec<SettingWarning>), AppError> {
    match cache::get_or_load(path).as_ref() {
        CachedEntry::Missing => Ok((BTreeMap::new(), Vec::new())),
        CachedEntry::Present(doc) => Ok(doc.validated(scope)),
        CachedEntry::Unreadable(message) => Err(file::read_failed_from_message(message.clone())),
    }
}

/// Read a single validated scalar setting without cloning the entire map.
/// Missing or unreadable files return `None` (matching [`load`]).
pub(super) fn load_key(path: &Path, scope: Scope, key: &str) -> Option<String> {
    match cache::get_or_load(path).as_ref() {
        CachedEntry::Present(doc) => doc.get_validated(scope, key),
        CachedEntry::Missing | CachedEntry::Unreadable(_) => None,
    }
}

/// Like [`load_key`], but an unreadable file returns `Err(SETTINGS_READ_FAILED)`
/// (matching [`read`]).
pub(super) fn read_key(path: &Path, scope: Scope, key: &str) -> Result<Option<String>, AppError> {
    match cache::get_or_load(path).as_ref() {
        CachedEntry::Missing => Ok(None),
        CachedEntry::Present(doc) => Ok(doc.get_validated(scope, key)),
        CachedEntry::Unreadable(message) => Err(file::read_failed_from_message(message.clone())),
    }
}

/// Read the full stored document (all keys preserved, nested sections intact) for
/// a read-modify-write. Errors if the existing file isn't valid JSON so a single
/// key write never silently clobbers a file a user is mid-edit on.
pub(super) fn load_document_for_write(
    path: &Path,
) -> Result<serde_json::Map<String, serde_json::Value>, AppError> {
    match file::read_file(path)? {
        Some(text) => file::parse_document(&text).map_err(|message| {
            AppError::BadRequest(format!(
                "{} is not valid JSON ({message}); fix it via \"Edit JSON\" before changing settings",
                path.display()
            ))
        }),
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
    let _guard = lock::write_lock().lock().await;
    let outcome =
        tokio::task::spawn_blocking(move || -> Result<Option<(T, Option<String>)>, AppError> {
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
            if !changed {
                return Ok(Some((value, None)));
            }
            let serialized = file::serialize_document(&doc);
            file::write_atomic(&owned_path, &serialized)?;
            Ok(Some((value, Some(serialized))))
        })
        .await
        .map_err(|error| AppError::internal(format!("{task_label} task failed: {error}")))??;

    match outcome {
        Some((value, Some(serialized))) => {
            cache::put_text(path, serialized);
            Ok(Some(value))
        }
        Some((value, None)) => Ok(Some(value)),
        None => Ok(None),
    }
}

/// Atomically write an already-serialized document while holding `WRITE_LOCK`
/// and refresh the watcher cache.
pub(super) async fn write_serialized_under_lock(
    _guard: &tokio::sync::MutexGuard<'static, ()>,
    path: &Path,
    serialized: String,
    task_label: &'static str,
) -> Result<(), AppError> {
    let owned_path = path.to_path_buf();
    let write_text = serialized.clone();
    tokio::task::spawn_blocking(move || file::write_atomic(&owned_path, &write_text))
        .await
        .map_err(|error| AppError::internal(format!("{task_label} task failed: {error}")))??;
    cache::put_text(path, serialized);
    Ok(())
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
    write_serialized_under_lock(&guard, path, serialized, "settings write").await?;
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
        assert!(matches!(err, AppError::BadRequest(_)));
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
    fn read_fails_on_an_unreadable_file_but_degrades_on_corrupt_content() {
        let dir = tempfile::tempdir().unwrap();
        let unreadable = dir.path().join("unreadable.json");
        std::fs::create_dir(&unreadable).unwrap();
        let error = read(&unreadable, Scope::Workspace).unwrap_err().to_string();
        // The cause reaches the user, not only "open private file <path>".
        assert!(error.to_lowercase().contains("directory"), "{error}");

        let corrupt = dir.path().join("corrupt.json");
        std::fs::write(&corrupt, "{ corrupt").unwrap();
        let (map, warnings) = read(&corrupt, Scope::Workspace).unwrap();
        assert!(map.is_empty());
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
