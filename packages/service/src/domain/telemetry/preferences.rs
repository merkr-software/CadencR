use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::domain::settings_store;
use crate::domain::settings_store::store::{update_document_locked, ReadPolicy};
use crate::error::AppError;

use super::models::TelemetryConsent;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub(super) struct StoredPreferences {
    pub diagnostics_enabled: bool,
    pub usage_enabled: bool,
    pub audience_enabled: bool,
    pub decision_version: Option<u32>,
    #[serde(deserialize_with = "deserialize_month")]
    pub audience_last_claimed_month: Option<String>,
    pub installation_id: Option<String>,
    pub first_turn_completed: bool,
}

fn valid_month(value: &str) -> bool {
    value.len() == 7
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        && value.as_bytes()[5..].iter().all(u8::is_ascii_digit)
        && ("01"..="12").contains(&&value[5..])
}

fn deserialize_month<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let month = Option::<String>::deserialize(deserializer)?;
    if month.as_deref().is_some_and(|value| !valid_month(value)) {
        return Err(serde::de::Error::custom("Invalid audience month"));
    }
    Ok(month)
}

/// Missing preferences predate the explicit decision; audience counts default on.
impl Default for StoredPreferences {
    fn default() -> Self {
        Self {
            diagnostics_enabled: false,
            usage_enabled: false,
            audience_enabled: true,
            decision_version: None,
            audience_last_claimed_month: None,
            installation_id: None,
            first_turn_completed: false,
        }
    }
}

impl StoredPreferences {
    pub fn decision_made(&self) -> bool {
        self.decision_version.is_some_and(|version| version >= 1)
    }

    pub fn valid_id(&self) -> Option<&str> {
        self.installation_id
            .as_deref()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
    }

    fn can_claim_first_turn(&self) -> bool {
        !self.first_turn_completed && self.decision_made() && self.usage_enabled
    }
}

/// Unreadable or malformed preferences fail closed; missing fields use channel defaults.
pub(super) fn read(path: &Path) -> Result<StoredPreferences, AppError> {
    settings_store::cache::inspect_document(path, |doc| match doc {
        Some(doc) => preferences_in(doc),
        None => Ok(StoredPreferences::default()),
    })
}

fn preferences_in(doc: &Map<String, Value>) -> Result<StoredPreferences, AppError> {
    doc.get("telemetry")
        .map(decode)
        .transpose()
        .map(Option::unwrap_or_default)
}

fn decode(value: &Value) -> Result<StoredPreferences, AppError> {
    let invalid = || {
        settings_store::file::invalid_settings(
            "Invalid telemetry preferences in settings.json. Repair the telemetry object via Edit JSON.",
        )
    };
    // Serde also accepts sequences for structs. An explicit array is a corrupt
    // settings section, even if positional defaults could fill it in.
    if !value.is_object() {
        return Err(invalid());
    }
    StoredPreferences::deserialize(value).map_err(|_| invalid())
}

pub(super) fn path() -> std::path::PathBuf {
    settings_store::paths::global_file(&settings_store::global_dir())
}

pub(super) async fn update(consent: Option<TelemetryConsent>, reset: bool) -> Result<(), AppError> {
    settings_store::global_update_document(move |doc| {
        let mut stored = preferences_in(doc)?;
        if let Some(consent) = consent {
            stored.diagnostics_enabled = consent.diagnostics_enabled;
            stored.usage_enabled = consent.usage_enabled;
            if let Some(audience_enabled) = consent.audience_enabled {
                stored.audience_enabled = audience_enabled;
            }
            stored.decision_version = Some(1);
        }
        if reset
            || ((stored.diagnostics_enabled || stored.usage_enabled) && stored.valid_id().is_none())
        {
            stored.installation_id = Some(uuid::Uuid::new_v4().to_string());
            stored.first_turn_completed = false;
        }
        let value = serde_json::to_value(stored)
            .map_err(|_| AppError::internal("Could not save telemetry preferences"))?;
        doc.insert("telemetry".to_string(), value);
        Ok(())
    })
    .await
}

pub(super) async fn claim_first_turn() -> Result<bool, AppError> {
    let path = path();
    if !read(&path)?.can_claim_first_turn() {
        return Ok(false);
    }
    claim_marker(&path, "first_turn_completed", true.into(), |stored| {
        stored.can_claim_first_turn()
    })
    .await
}

/// Claim durably before sending: failures can undercount, never trigger a retry.
pub(super) async fn claim_audience_month(path: &Path, month: &str) -> Result<bool, AppError> {
    if !valid_month(month) {
        return Err(AppError::internal("Invalid current audience month"));
    }
    let month = month.to_owned();
    claim_marker(
        path,
        "audience_last_claimed_month",
        month.as_str().into(),
        move |stored| {
            stored.audience_enabled
                && stored
                    .audience_last_claimed_month
                    .as_deref()
                    .is_none_or(|last| last < month.as_str())
        },
    )
    .await
}

async fn claim_marker(
    path: &Path,
    key: &'static str,
    value: Value,
    can_claim: impl FnOnce(&StoredPreferences) -> bool + Send + 'static,
) -> Result<bool, AppError> {
    let claimed = update_document_locked(path, ReadPolicy::Strict, "telemetry claim", move |doc| {
        // Revalidate under the write lock. The file may have changed since the
        // activity check, and an explicitly invalid section cannot authorize delivery.
        if !can_claim(&preferences_in(doc)?) {
            return Ok((false, false));
        }
        settings_store::file::edit_object_section(doc, "telemetry", |object| {
            object.insert(key.into(), value);
            Ok(())
        })?;
        Ok((true, true))
    })
    .await?;
    Ok(claimed.expect("strict updates always run"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_and_legacy_preferences_default_audience_on_without_creating_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        for content in [
            None,
            Some("{}"),
            Some(r#"{"telemetry":{"diagnostics_enabled":false,"usage_enabled":false}}"#),
        ] {
            if let Some(content) = content {
                settings_store::file::write_atomic(&path, content).unwrap();
            }
            let stored = read(&path).unwrap();
            assert!(stored.audience_enabled);
            assert!(!stored.diagnostics_enabled && !stored.usage_enabled);
            assert!(stored.decision_version.is_none());
            assert!(stored.installation_id.is_none());
        }
    }

    #[tokio::test]
    async fn explicit_all_false_decision_survives_reload_reset_and_audience_claim() {
        update(
            Some(TelemetryConsent {
                audience_enabled: Some(false),
                ..TelemetryConsent::default()
            }),
            false,
        )
        .await
        .unwrap();
        let stored = read(&path()).unwrap();
        assert_eq!(stored.decision_version, Some(1));
        assert!(!stored.audience_enabled && !stored.diagnostics_enabled && !stored.usage_enabled);
        assert!(stored.installation_id.is_none());
        assert!(!claim_audience_month(&path(), "2026-11").await.unwrap());
        update(
            Some(TelemetryConsent {
                audience_enabled: Some(true),
                ..TelemetryConsent::default()
            }),
            false,
        )
        .await
        .unwrap();
        assert!(claim_audience_month(&path(), "2026-11").await.unwrap());
        assert!(read(&path()).unwrap().installation_id.is_none());
        update(None, true).await.unwrap();
        let stored = read(&path()).unwrap();
        assert_eq!(stored.decision_version, Some(1));
        assert_eq!(
            stored.audience_last_claimed_month.as_deref(),
            Some("2026-11")
        );
        assert!(!claim_audience_month(&path(), "2026-11").await.unwrap());
    }

    #[tokio::test]
    async fn independent_toggles_never_enable_another_channel() {
        for (diagnostics_enabled, usage_enabled, audience_enabled) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (false, false, false),
        ] {
            update(
                Some(TelemetryConsent {
                    diagnostics_enabled,
                    usage_enabled,
                    audience_enabled: Some(audience_enabled),
                }),
                false,
            )
            .await
            .unwrap();
            let stored = read(&path()).unwrap();
            assert_eq!(
                (
                    stored.diagnostics_enabled,
                    stored.usage_enabled,
                    stored.audience_enabled
                ),
                (diagnostics_enabled, usage_enabled, audience_enabled)
            );
            assert_eq!(stored.decision_version, Some(1));
        }
    }

    #[tokio::test]
    async fn defaults_off_independent_consent_persists_and_identity_resets() {
        assert!(!read(&path()).unwrap().diagnostics_enabled);
        assert!(!read(&path()).unwrap().usage_enabled);
        assert!(read(&path()).unwrap().installation_id.is_none());
        update(
            Some(TelemetryConsent {
                diagnostics_enabled: true,
                usage_enabled: false,
                audience_enabled: Some(true),
            }),
            false,
        )
        .await
        .unwrap();
        let before = read(&path()).unwrap();
        assert!(before.diagnostics_enabled);
        assert!(!before.usage_enabled);
        assert!(before.valid_id().is_some());
        update(None, true).await.unwrap();
        assert_ne!(
            before.installation_id,
            read(&path()).unwrap().installation_id
        );
        assert!(read(&path()).unwrap().diagnostics_enabled);
        update(
            Some(TelemetryConsent {
                audience_enabled: Some(false),
                ..TelemetryConsent::default()
            }),
            false,
        )
        .await
        .unwrap();
        assert!(!read(&path()).unwrap().diagnostics_enabled);
    }

    #[test]
    fn malformed_consent_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        for content in [
            "{",
            r#"{"telemetry":[]}"#,
            r#"{"telemetry":[false,false,true,1]}"#,
            r#"{"telemetry":null}"#,
            r#"{"telemetry":{"diagnostics_enabled":"true","usage_enabled":true}}"#,
            r#"{"telemetry":{"audience_last_claimed_month":"forever"}}"#,
            r#"{"telemetry":{"audience_last_claimed_month":"2026-13"}}"#,
            r#"{"telemetry":{"audience_last_claimed_month":"2026-1a"}}"#,
        ] {
            settings_store::file::write_atomic(&path, content).unwrap();
            assert_eq!(read(&path).unwrap_err().code(), "SETTINGS_INVALID");
        }
    }

    #[tokio::test]
    async fn malformed_consent_cannot_be_replaced_by_a_claim() {
        let path = path();
        for content in [
            r#"{"telemetry":null}"#,
            r#"{"telemetry":[]}"#,
            r#"{"telemetry":{"usage_enabled":true,"decision_version":1,"audience_enabled":"yes"}}"#,
        ] {
            settings_store::file::write_atomic(&path, content).unwrap();
            let monthly = claim_audience_month(&path, "2026-11").await.unwrap_err();
            assert_eq!(monthly.code(), "SETTINGS_INVALID");
            let first_turn = claim_first_turn().await.unwrap_err();
            assert_eq!(first_turn.code(), "SETTINGS_INVALID");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        }
    }

    #[tokio::test]
    async fn detailed_decision_preserves_counter_setting_changed_outside_the_dialog() {
        for audience_enabled in [false, true] {
            settings_store::global_modify_object("telemetry", |object| {
                object.insert("audience_enabled".into(), audience_enabled.into());
                object.insert("audience_last_claimed_month".into(), "2026-11".into());
                Ok(())
            })
            .await
            .unwrap();
            update(Some(TelemetryConsent::default()), false)
                .await
                .unwrap();
            let stored = read(&path()).unwrap();
            assert_eq!(stored.audience_enabled, audience_enabled);
            assert_eq!(
                stored.audience_last_claimed_month.as_deref(),
                Some("2026-11")
            );
            assert_eq!(stored.decision_version, Some(1));
            assert!(!stored.diagnostics_enabled && !stored.usage_enabled);
        }
    }

    #[tokio::test]
    async fn first_turn_claim_roundtrips_with_identity() {
        update(
            Some(TelemetryConsent {
                diagnostics_enabled: true,
                usage_enabled: true,
                audience_enabled: Some(false),
            }),
            false,
        )
        .await
        .unwrap();
        let id = read(&path()).unwrap().installation_id;
        assert!(claim_first_turn().await.unwrap());
        let document = format!("{}\n", std::fs::read_to_string(path()).unwrap());
        settings_store::file::write_atomic(&path(), &document).unwrap();
        assert!(!claim_first_turn().await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path()).unwrap(),
            document,
            "already claimed turns must not rewrite settings"
        );
        let after = read(&path()).unwrap();
        assert_eq!(id, after.installation_id);
        assert!(after.first_turn_completed && after.diagnostics_enabled && after.usage_enabled);
    }
}
