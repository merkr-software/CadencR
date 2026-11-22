//! Workspace keys that changed name, carried over once at startup.
//!
//! When a built-in provider became an installed provider plugin, its workspace
//! default moved to the provider-neutral key the host uses for every installed
//! provider. The old value is copied under the new key unless the new key is
//! already set; the old key stays in the file, so this never loses a value and
//! an older app version still reads its own key.

use std::path::Path;

use crate::error::AppError;

use super::{dir, paths, registry, store};

/// `(old key, new key)` pairs. Migration data, not provider behavior: the
/// keys a former built-in wrote, named once so their values survive.
const RENAMED_KEYS: &[(&str, &str)] = &[("cursor_access_mode", "provider_access_mode.cursor")];

/// Copy renamed keys in the global settings file; returns `true` if it
/// rewrote the file. Leaves a corrupt or missing file untouched.
pub async fn carry_renamed_global_keys() -> Result<bool, AppError> {
    carry(&paths::global_file(&dir::global_dir()), RENAMED_KEYS).await
}

async fn carry(path: &Path, renamed: &[(&'static str, &'static str)]) -> Result<bool, AppError> {
    let pairs: Vec<(&'static str, &'static str)> = renamed.to_vec();
    let changed = store::update_document_locked(
        path,
        store::ReadPolicy::SkipMissingOrCorrupt,
        "settings rename-keys",
        move |doc| {
            let mut changed = false;
            for (old, new) in pairs {
                if doc.contains_key(new) {
                    continue;
                }
                let Some(value) = doc.get(old).and_then(|value| value.as_str()) else {
                    continue;
                };
                // A value the new key rejects would only fall back to its default.
                if registry::workspace_spec(new).is_some_and(|spec| spec.is_valid(value)) {
                    doc.insert(new.to_string(), value.into());
                    changed = true;
                }
            }
            Ok((changed, changed))
        },
    )
    .await?;
    Ok(changed.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::settings_store::file;

    fn read(path: &Path) -> serde_json::Map<String, serde_json::Value> {
        file::parse_document(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn copies_the_old_value_and_keeps_the_old_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"cursor_access_mode":"fullAccess","theme_current":"aurora"}"#,
        )
        .unwrap();

        assert!(carry(&path, RENAMED_KEYS).await.unwrap());
        let doc = read(&path);
        assert_eq!(doc["provider_access_mode.cursor"], "fullAccess");
        assert_eq!(doc["cursor_access_mode"], "fullAccess");
        assert_eq!(doc["theme_current"], "aurora");

        // Idempotent: the new key is set now.
        assert!(!carry(&path, RENAMED_KEYS).await.unwrap());
    }

    #[tokio::test]
    async fn never_overrides_a_value_already_under_the_new_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let content =
            r#"{"cursor_access_mode":"fullAccess","provider_access_mode.cursor":"autoReview"}"#;
        std::fs::write(&path, content).unwrap();

        assert!(!carry(&path, RENAMED_KEYS).await.unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
    }

    #[tokio::test]
    async fn skips_values_the_new_key_rejects() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"cursor_access_mode":"bypassPermissions"}"#).unwrap();

        assert!(!carry(&path, RENAMED_KEYS).await.unwrap());
        assert!(!read(&path).contains_key("provider_access_mode.cursor"));
    }

    #[tokio::test]
    async fn leaves_missing_and_corrupt_files_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(!carry(&path, RENAMED_KEYS).await.unwrap());
        assert!(!path.exists());

        std::fs::write(&path, "{ corrupt").unwrap();
        assert!(!carry(&path, RENAMED_KEYS).await.unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ corrupt");
    }
}
