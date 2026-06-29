//! Read/write API over the settings files. This module holds the pure,
//! dir-based core functions (testable with temp dirs); the `global` and
//! `project` submodules wrap them, resolving the active settings dir from
//! `dir::global_dir()`.

use std::collections::BTreeMap;
use std::path::Path;

use crate::error::AppError;

use super::{file, lock, validate, Scope, SettingWarning};

mod global;
mod project;

pub use global::*;
pub use project::*;

/// Read + parse + validate a settings file. Never errors: a missing file is an
/// empty map, and a malformed file degrades to an empty map plus a warning so a
/// corrupt file can't brick the app on a hot read path.
pub fn load(path: &Path, scope: Scope) -> (BTreeMap<String, String>, Vec<SettingWarning>) {
    match file::read_file(path) {
        Ok(Some(text)) => load_text(scope, &text),
        Ok(None) => (BTreeMap::new(), Vec::new()),
        Err(e) => (
            BTreeMap::new(),
            vec![SettingWarning::new("", e.to_string())],
        ),
    }
}

/// Parse + validate already-read document text. Split out so `read_for_edit`
/// can reuse this pass without reading the same file from disk a second time.
fn load_text(scope: Scope, text: &str) -> (BTreeMap<String, String>, Vec<SettingWarning>) {
    let (parsed, mut warnings) = match file::parse_object(text) {
        Ok(result) => result,
        Err(message) => return (BTreeMap::new(), vec![SettingWarning::new("", message)]),
    };
    let (clean, mut validation_warnings) = validate::validate(scope, parsed);
    warnings.append(&mut validation_warnings);
    (clean, warnings)
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

/// Set a single scalar key, preserving every other key (unknown scalars and
/// nested sections like `profiles` alike).
pub(super) async fn set_value(path: &Path, key: &str, value: &str) -> Result<(), AppError> {
    let _guard = lock::write_lock().lock().await;
    let mut doc = load_document_for_write(path)?;
    doc.insert(
        key.to_string(),
        serde_json::Value::String(value.to_string()),
    );
    file::write_atomic(path, &file::serialize_document(&doc))
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
    let (scalars, mut warnings) = file::parse_object(content).map_err(AppError::BadRequest)?;
    let (_clean, mut validation_warnings) = validate::validate(scope, scalars);
    warnings.append(&mut validation_warnings);

    let _guard = lock::write_lock().lock().await;
    file::write_atomic(path, &file::serialize_document(&doc))?;
    Ok(warnings)
}

/// Current document text for the editor, plus warnings. Empty file → `{}`.
pub fn read_for_edit(path: &Path, scope: Scope) -> (String, Vec<SettingWarning>) {
    match file::read_file(path) {
        Ok(Some(text)) if !text.trim().is_empty() => {
            let (_map, warnings) = load_text(scope, &text);
            (text, warnings)
        }
        Ok(_) => ("{}\n".to_string(), Vec::new()),
        Err(e) => (
            "{}\n".to_string(),
            vec![SettingWarning::new("", e.to_string())],
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
