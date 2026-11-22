//! Per-device UI state that must never live in the settings files.
//!
//! These keys used to be stored as workspace settings, but they're purely
//! ephemeral, single-device presentation state (which tab was active, per-feature
//! editor sidebar visibility, the last-opened feature). They now live in the
//! frontend's `localStorage`, so the settings JSON holds only real configuration.
//!
//! The migration skips these keys, the write endpoints reject them (they're no
//! longer in the allowlist), and a one-time startup prune strips any that an
//! earlier version already wrote into a file.

use std::path::Path;

use crate::error::AppError;

use super::{dir, paths, store};

/// Exact workspace keys to drop.
const EPHEMERAL_KEYS: &[&str] = &["lastOpenedFeature"];

/// Workspace key prefixes (each followed by a feature id) to drop.
const EPHEMERAL_PREFIXES: &[&str] = &["active_tab_", "editor_sidebar_visible_"];

/// Whether `key` is per-device UI state that must not be persisted in a file.
pub fn is_ephemeral_key(key: &str) -> bool {
    EPHEMERAL_KEYS.contains(&key) || EPHEMERAL_PREFIXES.iter().any(|p| key.starts_with(p))
}

/// Strip ephemeral keys from the global settings file. One-time cleanup for
/// files an earlier version already wrote them into; returns `true` if it
/// rewrote the file. Leaves a corrupt/missing file untouched so it can't brick
/// or clobber on startup.
pub async fn prune_ephemeral_global() -> Result<bool, AppError> {
    prune(&paths::global_file(&dir::global_dir())).await
}

async fn prune(path: &Path) -> Result<bool, AppError> {
    let changed = store::update_document_locked(
        path,
        store::ReadPolicy::SkipMissingOrCorrupt,
        "settings prune",
        |doc| {
            let before = doc.len();
            // Ephemeral keys are scalar UI state; nested sections (e.g. `profiles`) are
            // never ephemeral and are preserved by operating on the full document.
            doc.retain(|key, _| !is_ephemeral_key(key));
            let changed = doc.len() != before;
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

    #[test]
    fn matches_exact_and_prefixed_keys() {
        assert!(is_ephemeral_key("lastOpenedFeature"));
        assert!(is_ephemeral_key("active_tab_42"));
        assert!(is_ephemeral_key("editor_sidebar_visible_7"));
    }

    #[test]
    fn keeps_real_settings() {
        assert!(!is_ephemeral_key("theme_current"));
        assert!(!is_ephemeral_key("editor_sidebar_collapsed"));
        assert!(!is_ephemeral_key("model_session"));
    }

    #[tokio::test]
    async fn prune_strips_ephemeral_keys_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"theme_current":"aurora","active_tab_1":"browser","editor_sidebar_visible_2":"true","lastOpenedFeature":"{}"}"#,
        )
        .unwrap();

        assert!(prune(&path).await.unwrap());
        let text = std::fs::read_to_string(&path).unwrap();
        let (map, _) = file::parse_object(&text).unwrap();
        assert_eq!(map.get("theme_current").map(String::as_str), Some("aurora"));
        assert!(!map.contains_key("active_tab_1"));
        assert!(!map.contains_key("editor_sidebar_visible_2"));
        assert!(!map.contains_key("lastOpenedFeature"));

        // Idempotent: a second run has nothing to strip.
        assert!(!prune(&path).await.unwrap());
    }

    #[tokio::test]
    async fn prune_preserves_nested_sections() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"active_tab_1":"browser","profiles":{"bedrock":{"AWS_REGION":"us-east-1"}}}"#,
        )
        .unwrap();

        assert!(prune(&path).await.unwrap());
        let doc = file::parse_document(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(!doc.contains_key("active_tab_1"));
        assert_eq!(
            doc["profiles"]["bedrock"]["AWS_REGION"],
            serde_json::json!("us-east-1")
        );
    }

    #[tokio::test]
    async fn prune_leaves_corrupt_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ corrupt").unwrap();
        assert!(!prune(&path).await.unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ corrupt");
    }
}
