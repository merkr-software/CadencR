use std::{collections::BTreeMap, path::Path};

use super::{file, load_document_for_write, lock, AppError};

/// Set a single scalar key, preserving every other key (unknown scalars and
/// nested sections like `profiles` alike).
pub(super) async fn set_value(path: &Path, key: &str, value: &str) -> Result<(), AppError> {
    set_values(
        path,
        &BTreeMap::from([(key.to_string(), Some(value.to_string()))]),
    )
    .await
    .map(drop)
}

/// Set or remove several scalar keys in one atomic write (`None` removes the
/// key, so its in-code default applies again). Every other key is preserved.
/// Returns the previous values and whether the document changed, both under the write lock.
pub(super) async fn set_values(
    path: &Path,
    entries: &BTreeMap<String, Option<String>>,
) -> Result<(BTreeMap<String, Option<String>>, bool), AppError> {
    let _guard = lock::write_lock().lock().await;
    let mut doc = load_document_for_write(path)?;
    let mut changed = false;
    let previous = entries
        .iter()
        .map(|(key, value)| {
            let old = match value {
                Some(value) => doc.insert(key.clone(), serde_json::Value::String(value.clone())),
                None => doc.remove(key),
            };
            changed |= match value {
                Some(value) => old.as_ref().and_then(serde_json::Value::as_str) != Some(value),
                None => old.is_some(),
            };
            (key.clone(), old.map(stored_text))
        })
        .collect();
    if changed {
        file::write_atomic(path, &file::serialize_document(&doc))?;
    }
    Ok((previous, changed))
}

/// A stored value as the text a scalar setting holds.
fn stored_text(value: serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    }
}
