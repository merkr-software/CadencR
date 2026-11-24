//! The controls of the last accepted user prompt, shared across projects.
use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::super::permission_modes::parse_permission_mode_wire;
use super::super::providers::{
    model_supports_thinking_level, provider_catalog_entry_live_for_settings, runtime_adapter,
};
use super::super::runtime::{model_setting_key, runtime_setting_key, ProviderStatus};
use super::{resolve_configured_selection, ResolvedSelection, SelectionError, SelectionOrigin};
use crate::domain::{settings, settings_store};
use crate::error::AppError;

const SNAPSHOT: &str = "last_prompt_selection";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PromptedSelection {
    pub provider: String,
    pub model: Option<String>,
    pub profile: Option<String>,
    pub thinking_effort: Option<String>,
    pub fast_mode: bool,
    #[serde(default)]
    pub permission_mode: Option<String>,
}

/// A feature override takes precedence over the workspace's last prompted selection,
/// which applies across projects. An unconfigured workspace uses the provider default.
pub async fn resolve_selection(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    agent_type: &str,
    feature_id: Option<i64>,
    profile: Option<&str>,
) -> Result<ResolvedSelection, SelectionError> {
    if agent_type == "session" && profile.is_none() {
        if let Some(saved) = PromptedSelection::for_new_session(read_pool, cwd, feature_id).await? {
            if let Some(model_id) = saved.model {
                return Ok(ResolvedSelection {
                    provider_id: saved.provider,
                    model_id,
                    provider_origin: SelectionOrigin::Global,
                    model_origin: SelectionOrigin::Global,
                });
            }
        }
    }
    resolve_configured_selection(read_pool, cwd, agent_type, feature_id, profile).await
}

/// Record a pair from callers that only know the provider and model.
pub async fn remember_session_selection(
    provider: &str,
    model: Option<&str>,
) -> Result<(), AppError> {
    persist_selection(provider, model, None).await
}

async fn persist_selection(
    provider: &str,
    model: Option<&str>,
    snapshot: Option<String>,
) -> Result<(), AppError> {
    let entries = BTreeMap::from([
        (runtime_setting_key("session"), Some(provider.to_owned())),
        (
            model_setting_key("session"),
            Some(model.unwrap_or_default().to_owned()),
        ),
        (SNAPSHOT.into(), snapshot),
    ]);
    settings_store::global_set_many(&entries).await.map(drop)
}

impl PromptedSelection {
    pub(crate) async fn remember(&self) -> Result<(), AppError> {
        let snapshot = serde_json::to_string(self).expect("prompt selection serializes");
        persist_selection(&self.provider, self.model.as_deref(), Some(snapshot)).await
    }

    /// A single file read binds all six values to the same prompt. Ignore its
    /// controls if a settings client has since edited either legacy key.
    pub(crate) async fn for_new_session(
        pool: &SqlitePool,
        cwd: Option<&Path>,
        feature_id: Option<i64>,
    ) -> Result<Option<Self>, SelectionError> {
        let Some(values) = settings_store::global_snapshot() else {
            return Ok(None);
        };
        let Some(raw) = values.get(SNAPSHOT) else {
            return Ok(None);
        };
        let mut saved: Self = serde_json::from_str(raw).map_err(|e| {
            SelectionError::SettingsUnreadable(format!("Invalid {SNAPSHOT} setting: {e}"))
        })?;
        if values.get("agent_runtime_session") != Some(&saved.provider)
            || values.get("model_session").filter(|m| !m.is_empty()) != saved.model.as_ref()
        {
            return Ok(None);
        }
        if let Some(id) = feature_id {
            for key in ["agent_runtime_session", "model_session"] {
                if settings::feature_setting(pool, id, key).await?.is_some() {
                    return Ok(None);
                }
            }
        }
        let Some(adapter) = runtime_adapter(&saved.provider) else {
            return Ok(None);
        };
        if let Some(profile) = saved.profile.as_deref() {
            let catalog = adapter
                .profile_catalog(cwd)
                .await
                .map_err(|error| SelectionError::SettingsUnreadable(error.to_string()))?;
            if !catalog.is_some_and(|catalog| catalog.profiles.iter().any(|p| p.id == profile)) {
                return Ok(None);
            }
        }
        let entry = provider_catalog_entry_live_for_settings(
            pool,
            cwd,
            saved.profile.as_deref(),
            adapter.as_adapter(),
        )
        .await;
        if entry.status != ProviderStatus::Available {
            return Ok(None);
        }
        let id = saved.model.as_ref().or(entry.default_model.as_ref());
        let Some(model) = entry.models.iter().find(|m| Some(&m.id) == id) else {
            return Ok(None);
        };
        saved.model = Some(model.id.clone());
        saved.thinking_effort = saved
            .thinking_effort
            .filter(|effort| model_supports_thinking_level(model, effort) != Some(false));
        saved.fast_mode &= model.supports_fast_mode == Some(true);
        saved.permission_mode = saved
            .permission_mode
            .filter(|mode| parse_permission_mode_wire(mode).is_some());
        Ok(Some(saved))
    }
}

#[cfg(test)]
mod tests {
    use super::remember_session_selection;
    use crate::domain::settings_store;

    #[tokio::test]
    async fn records_the_prompted_pair_as_the_workspace_selection() {
        remember_session_selection("claude_code", Some("opus"))
            .await
            .unwrap();
        assert_eq!(
            settings_store::global_get("agent_runtime_session").as_deref(),
            Some("claude_code")
        );
        assert_eq!(
            settings_store::global_get("model_session").as_deref(),
            Some("opus")
        );
    }

    #[tokio::test]
    async fn a_provider_default_model_clears_the_previous_pick() {
        remember_session_selection("claude_code", Some("opus"))
            .await
            .unwrap();
        remember_session_selection("codex", None).await.unwrap();
        assert_eq!(
            settings_store::global_get("agent_runtime_session").as_deref(),
            Some("codex")
        );
        assert_eq!(settings_store::global_get_nonempty("model_session"), None);
    }

    #[test]
    fn legacy_snapshot_without_permission_mode_deserializes() {
        let parsed: super::PromptedSelection = serde_json::from_str(
            r#"{"provider":"antigravity","model":"gemini-4-neon","profile":null,"thinking_effort":"high","fast_mode":false}"#,
        )
        .unwrap();
        assert_eq!(parsed.provider, "antigravity");
        assert_eq!(parsed.model.as_deref(), Some("gemini-4-neon"));
        assert_eq!(parsed.permission_mode, None);
    }
}
