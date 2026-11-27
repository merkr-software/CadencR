use std::path::Path;

use crate::error::AppError;

use super::cache::inspect_document;
use super::store::{read_key, update_document_locked, ReadPolicy};
use super::{file, Scope};

const LEGACY_ENGLISH: &str = "legacy-english";
pub(super) const VALUES: &[&str] = &[
    "system",
    "en-US",
    "es-ES",
    "de-DE",
    "ja-JP",
    "fr-FR",
    "pt-BR",
    "en",
    "fr",
    LEGACY_ENGLISH,
];

const INITIALIZED: &str = "ui_language_initialized";

/// Keep upgrade history separate from the editable preference so resetting it restores System.
pub(super) async fn read(path: &Path) -> Result<Option<String>, AppError> {
    if let Some(preference) = inspect_document(path, |doc| {
        let Some(doc) = doc else { return Ok(None) };
        if file::read_scalar(doc, Scope::Workspace, INITIALIZED)?.as_deref() == Some("true") {
            return Ok(Some(file::read_scalar(
                doc,
                Scope::Workspace,
                "ui_language",
            )?));
        }
        Ok(None)
    })? {
        return Ok(preference);
    }
    update_document_locked(
        path,
        ReadPolicy::Strict,
        "initialize interface language",
        |doc| {
            if file::read_scalar(doc, Scope::Workspace, INITIALIZED)?.as_deref() == Some("true") {
                return Ok(((), false));
            }
            if file::read_scalar(doc, Scope::Workspace, "ui_language")?.is_none() {
                let completed = file::read_scalar(doc, Scope::Workspace, "onboarding_step")?
                    .as_deref()
                    == Some("completed");
                let language = if completed { LEGACY_ENGLISH } else { "system" };
                doc.insert("ui_language".into(), language.into());
            }
            doc.insert(INITIALIZED.into(), true.into());
            Ok(((), true))
        },
    )
    .await?;
    read_key(path, Scope::Workspace, "ui_language")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::settings_store::file;

    #[tokio::test]
    async fn distinguishes_existing_and_new_profiles_once_and_preserves_explicit_choices() {
        for (original, expected) in [
            (None, "system"),
            (Some(r#"{"onboarding_step":"preferences"}"#), "system"),
            (
                Some(r#"{"onboarding_step":"completed","theme_current":"aurora"}"#),
                LEGACY_ENGLISH,
            ),
            (
                Some(r#"{"onboarding_step":"completed","ui_language":"system"}"#),
                "system",
            ),
            (
                Some(r#"{"onboarding_step":"completed","ui_language":"en"}"#),
                "en",
            ),
            (
                Some(r#"{"onboarding_step":"completed","ui_language":"fr-FR"}"#),
                "fr-FR",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("settings.json");
            if let Some(original) = original {
                file::write_atomic(&path, original).unwrap();
            }
            read(&path).await.unwrap();
            let mut doc = file::parse_document(&file::read_file(&path).unwrap().unwrap()).unwrap();
            assert_eq!(doc["ui_language"], expected);
            if expected == LEGACY_ENGLISH {
                assert_eq!(doc["theme_current"], "aurora");
            }
            doc.insert("onboarding_step".into(), "completed".into());
            let confirmed = file::serialize_document(&doc);
            file::write_atomic(&path, &confirmed).unwrap();
            read(&path).await.unwrap();
            assert_eq!(file::read_file(&path).unwrap().unwrap(), confirmed);
            doc.remove("ui_language");
            file::write_atomic(&path, &file::serialize_document(&doc)).unwrap();
            assert_eq!(
                read(&path).await.unwrap(),
                None,
                "reset must follow the system"
            );
        }
    }

    #[tokio::test]
    async fn preserves_invalid_settings_and_reports_the_repair_error() {
        for text in [
            "invalid json",
            r#"{"onboarding_step":{}}"#,
            r#"{"ui_language_initialized":true,"ui_language":"unsupported"}"#,
            r#"{"ui_language_initialized":"invalid"}"#,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("settings.json");
            file::write_atomic(&path, text).unwrap();
            assert_eq!(read(&path).await.unwrap_err().code(), "SETTINGS_INVALID");
            assert_eq!(file::read_file(&path).unwrap().as_deref(), Some(text));
        }
    }
}
