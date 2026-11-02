use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::domain::settings_store;
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
}

/// Unreadable or malformed preferences fail closed; missing fields use channel defaults.
pub(super) fn read(path: &Path) -> Result<StoredPreferences, AppError> {
    let Some(text) = settings_store::file::read_file(path)? else {
        return Ok(StoredPreferences::default());
    };
    let doc = settings_store::file::parse_document(&text).map_err(AppError::BadRequest)?;
    match doc.get("telemetry") {
        None => Ok(StoredPreferences::default()),
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| {
            AppError::BadRequest("Invalid telemetry preferences; repair settings.json".into())
        }),
    }
}

pub(super) fn path() -> std::path::PathBuf {
    settings_store::paths::global_file(&settings_store::global_dir())
}

pub(super) async fn update(consent: Option<TelemetryConsent>, reset: bool) -> Result<(), AppError> {
    settings_store::global_modify_object("telemetry", |object| {
        let mut stored: StoredPreferences =
            serde_json::from_value(serde_json::Value::Object(object.clone())).map_err(|_| {
                AppError::BadRequest("Invalid telemetry preferences; repair settings.json".into())
            })?;
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
        *object = serde_json::to_value(stored)
            .map_err(|_| AppError::Internal("Could not save telemetry preferences".into()))?
            .as_object()
            .cloned()
            .ok_or_else(|| AppError::Internal("Invalid telemetry preferences".into()))?;
        Ok(())
    })
    .await
}

pub(super) async fn claim_first_turn() -> Result<bool, AppError> {
    let stored = read(&path())?;
    if stored.first_turn_completed || !stored.decision_made() || !stored.usage_enabled {
        return Ok(false);
    }
    let mut claimed = false;
    settings_store::global_modify_object("telemetry", |object| {
        if object
            .get("decision_version")
            .and_then(|v| v.as_u64())
            .is_some_and(|version| version >= 1)
            && object.get("usage_enabled").and_then(|v| v.as_bool()) == Some(true)
            && object.get("first_turn_completed").and_then(|v| v.as_bool()) != Some(true)
        {
            object.insert("first_turn_completed".into(), serde_json::json!(true));
            claimed = true;
        }
        Ok(())
    })
    .await?;
    Ok(claimed)
}

/// Claim durably before sending: failures can undercount, never trigger a retry.
pub(super) async fn claim_audience_month(path: &Path, month: &str) -> Result<bool, AppError> {
    if !valid_month(month) {
        return Err(AppError::Internal("Invalid current audience month".into()));
    }
    let mut claimed = false;
    settings_store::store::modify_object_at(path, "telemetry", |object| {
        let stored: StoredPreferences =
            serde_json::from_value(serde_json::Value::Object(object.clone())).map_err(|_| {
                AppError::BadRequest("Invalid telemetry preferences; repair settings.json".into())
            })?;
        if !stored.audience_enabled
            || stored
                .audience_last_claimed_month
                .as_deref()
                .is_some_and(|last| last >= month)
        {
            return Ok(());
        }
        // Audience activity never creates detailed telemetry consent or an installation identity.
        object.insert("audience_last_claimed_month".into(), month.into());
        claimed = true;
        Ok(())
    })
    .await?;
    Ok(claimed)
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
            r#"{"telemetry":{"diagnostics_enabled":"true","usage_enabled":true}}"#,
            r#"{"telemetry":{"audience_last_claimed_month":"forever"}}"#,
            r#"{"telemetry":{"audience_last_claimed_month":"2026-13"}}"#,
            r#"{"telemetry":{"audience_last_claimed_month":"2026-1a"}}"#,
        ] {
            settings_store::file::write_atomic(&path, content).unwrap();
            assert!(read(&path).is_err());
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
