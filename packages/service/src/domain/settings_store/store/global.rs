//! Global (workspace) settings wrappers over the dir-based core functions.
//! These resolve the active settings dir from `dir::global_dir()`.

use std::path::PathBuf;

use crate::domain::workspace::models::Setting;
use crate::error::AppError;

use super::super::{dir, file, lock, paths, Scope, SettingWarning};
use super::{load, load_document_for_write, read_for_edit, set_value, write_content};

fn global_path() -> PathBuf {
    paths::global_file(&dir::global_dir())
}

pub fn global_get(key: &str) -> Option<String> {
    load(&global_path(), Scope::Workspace).0.remove(key)
}

/// Like `global_get` but treats empty/whitespace-only as unset.
pub fn global_get_nonempty(key: &str) -> Option<String> {
    global_get(key).filter(|v| !v.trim().is_empty())
}

pub fn global_list() -> Vec<Setting> {
    load(&global_path(), Scope::Workspace)
        .0
        .into_iter()
        .map(|(key, value)| Setting {
            key,
            value: Some(value),
        })
        .collect()
}

pub async fn global_set(key: &str, value: &str) -> Result<(), AppError> {
    set_value(&global_path(), key, value).await
}

pub async fn global_write_content(content: &str) -> Result<Vec<SettingWarning>, AppError> {
    write_content(&global_path(), Scope::Workspace, content).await
}

pub fn global_read_for_edit() -> (PathBuf, String, Vec<SettingWarning>) {
    let path = global_path();
    let (content, warnings) = read_for_edit(&path, Scope::Workspace);
    (path, content, warnings)
}

/// Read a nested object section (e.g. `profiles`) from the global file. Returns
/// an empty map when the key is absent or its value isn't an object. A present
/// but unparseable file also degrades to empty, but logs a warning first: that
/// is the root cause behind otherwise-confusing "section missing" symptoms (a
/// corrupt `settings.json` silently dropping an active Bedrock/Vertex profile).
pub fn global_get_object(key: &str) -> serde_json::Map<String, serde_json::Value> {
    let path = global_path();
    let Ok(Some(text)) = file::read_file(&path) else {
        return serde_json::Map::new();
    };
    let doc = match file::parse_document(&text) {
        Ok(doc) => doc,
        Err(message) => {
            tracing::warn!(
                file = %path.display(),
                error = %message,
                "settings file is not valid JSON; ignoring its '{key}' section"
            );
            return serde_json::Map::new();
        }
    };
    file::object_section(&doc, key)
}

/// Atomically read-modify-write a nested object section under `key` in the global
/// file. `f` mutates the section in place; if it leaves it empty the key is
/// removed. Every other key (scalar settings and other sections) is preserved.
/// Errors if the existing file isn't valid JSON (never clobbers a mid-edit file)
/// or if `f` returns an error (in which case nothing is written).
pub async fn global_modify_object<F>(key: &str, f: F) -> Result<(), AppError>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(), AppError>,
{
    let path = global_path();
    let _guard = lock::write_lock().lock().await;
    let mut doc = load_document_for_write(&path)?;
    let mut section = file::object_section(&doc, key);
    f(&mut section)?;
    if section.is_empty() {
        doc.remove(key);
    } else {
        doc.insert(key.to_string(), serde_json::Value::Object(section));
    }
    file::write_atomic(&path, &file::serialize_document(&doc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn modify_object_round_trips_and_preserves_scalars() {
        // global_* helpers resolve their own path via the per-test settings dir.
        global_set("theme_current", "aurora").await.unwrap();

        global_modify_object("profiles", |obj| {
            obj.insert(
                "bedrock".to_string(),
                serde_json::json!({ "AWS_REGION": "us-east-1" }),
            );
            Ok(())
        })
        .await
        .unwrap();

        let section = global_get_object("profiles");
        assert_eq!(
            section["bedrock"]["AWS_REGION"],
            serde_json::json!("us-east-1")
        );
        // Scalar setting survived the nested write.
        assert_eq!(global_get("theme_current").as_deref(), Some("aurora"));

        // Emptying the section removes the key entirely.
        global_modify_object("profiles", |obj| {
            obj.remove("bedrock");
            Ok(())
        })
        .await
        .unwrap();
        assert!(global_get_object("profiles").is_empty());
    }
}
