//! Global (workspace) settings wrappers over the dir-based core functions.
//! These resolve the active settings dir from `dir::global_dir()`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::domain::workspace::models::Setting;
use crate::error::AppError;
use serde_json::{Map, Value};

use super::super::cache;
use super::super::{dir, file, lock, paths, Scope, SettingWarning};
use super::{
    load_document_for_write, load_key, read, read_for_edit, read_key, set_value, set_values,
    update_document_locked, write_content, write_serialized_under_lock, ReadPolicy, SettingsMap,
};

fn global_path() -> PathBuf {
    paths::global_file(&dir::global_dir())
}

pub fn global_get(key: &str) -> Option<String> {
    load_key(&global_path(), Scope::Workspace, key)
}

/// Read a scalar without substituting a default for read or validation errors.
pub fn global_read(key: &str) -> Result<Option<String>, AppError> {
    read_key(&global_path(), Scope::Workspace, key)
}

/// Like `global_get` but treats empty/whitespace-only as unset.
pub fn global_get_nonempty(key: &str) -> Option<String> {
    global_get(key).filter(|v| !v.trim().is_empty())
}

/// Read the stored scalar values together, without substituting defaults.
pub fn global_snapshot() -> Result<BTreeMap<String, String>, AppError> {
    let path = global_path();
    let entry = cache::get_or_load(&path);
    let Some(doc) = entry.readable_document()? else {
        return Ok(BTreeMap::new());
    };
    doc.parsed_scalars
        .as_ref()
        .map(|(values, _)| values.clone())
        .map_err(|message| file::invalid_document(&path, message))
}

/// Every global scalar setting, failing like [`global_read`].
pub fn global_list() -> Result<Vec<Setting>, AppError> {
    Ok(read(&global_path(), Scope::Workspace)?
        .0
        .into_iter()
        .map(|(key, value)| Setting {
            key,
            value: Some(value),
        })
        .collect())
}

pub async fn global_set(key: &str, value: &str) -> Result<(), AppError> {
    set_value(&global_path(), key, value).await?;
    super::super::generation::bump_global();
    Ok(())
}

/// The global document's path and validated scalar values (plus warnings).
pub fn global_map() -> Result<SettingsMap, AppError> {
    let path = global_path();
    let (map, warnings) = read(&path, Scope::Workspace)?;
    Ok((path, map, warnings))
}

/// Set or remove (`None`) several global keys in one atomic write, returning
/// each key's previous stored value.
pub async fn global_set_many(
    entries: &BTreeMap<String, Option<String>>,
) -> Result<BTreeMap<String, Option<String>>, AppError> {
    let (previous, changed) = set_values(&global_path(), entries).await?;
    if changed {
        super::super::generation::bump_global();
    }
    Ok(previous)
}

pub async fn global_write_content(content: &str) -> Result<Vec<SettingWarning>, AppError> {
    crate::domain::telemetry::settings_changed();
    let result = write_content(&global_path(), Scope::Workspace, content).await;
    crate::domain::telemetry::settings_changed();
    let warnings = result?;
    super::super::generation::bump_global();
    Ok(warnings)
}

pub fn global_read_for_edit() -> (PathBuf, String, Vec<SettingWarning>) {
    let path = global_path();
    let (content, warnings) = read_for_edit(&path, Scope::Workspace);
    (path, content, warnings)
}

/// Read a nested object section (e.g. `profiles`). Only an absent section
/// returns an empty map.
pub fn global_read_object(
    key: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, AppError> {
    global_inspect_document(|doc| Ok(file::object_section(doc, key)?.cloned().unwrap_or_default()))
}

/// Inspect related settings against the same cached document.
pub(crate) fn global_inspect_document<T>(
    inspect: impl FnOnce(&Map<String, Value>) -> Result<T, AppError>,
) -> Result<T, AppError> {
    cache::inspect_document(&global_path(), |doc| match doc {
        Some(doc) => inspect(doc),
        None => inspect(&Map::new()),
    })
}

/// Atomically change several related settings in the same document.
pub(crate) async fn global_update_document<T, F>(update: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&mut Map<String, Value>) -> Result<T, AppError> + Send + 'static,
{
    let value = update_document_locked(
        &global_path(),
        ReadPolicy::Strict,
        "settings update",
        move |doc| Ok((update(doc)?, true)),
    )
    .await?;
    super::super::generation::bump_global();
    Ok(value.expect("strict updates always run"))
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
    modify_object_at(&global_path(), key, f).await?;
    super::super::generation::bump_global();
    Ok(())
}

/// The path-based variant shares the same write lock and atomic document preservation.
pub(crate) async fn modify_object_at<F>(path: &Path, key: &str, f: F) -> Result<(), AppError>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(), AppError>,
{
    let guard = lock::write_lock().lock().await;
    let read_path = path.to_path_buf();
    let mut doc = tokio::task::spawn_blocking(move || load_document_for_write(&read_path))
        .await
        .map_err(|error| AppError::internal(format!("settings read task failed: {error}")))??;
    file::edit_object_section(&mut doc, key, f)?;
    let serialized = file::serialize_document(&doc);
    write_serialized_under_lock(guard, path, serialized, "settings write").await
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

        let section = global_read_object("profiles").unwrap();
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
        assert!(global_read_object("profiles").unwrap().is_empty());
    }
}
