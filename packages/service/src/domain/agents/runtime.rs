use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const AGENT_TYPES: &[&str] = &["session", "auto_name"];

pub const DEFAULT_PROVIDER: &str = "claude_code";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatus {
    Available,
    Unavailable,
    ComingSoon,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelCatalogEntry {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_effort: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_effort_levels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_adaptive_thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_fast_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_auto_mode: Option<bool>,
}

impl ModelCatalogEntry {
    /// Bare alias constructor for catalog entries that don't carry capability
    /// flags or descriptions (e.g. fallback lists and third-party providers
    /// that only expose id/label).
    pub fn alias(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            description: None,
            supports_effort: None,
            supported_effort_levels: None,
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderCatalogEntry {
    pub id: String,
    pub label: String,
    pub status: ProviderStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    pub models: Vec<ModelCatalogEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<ProviderModeCatalogEntry>,
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderModeCatalogEntry {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentCatalogResponse {
    pub default_provider: String,
    pub providers: Vec<ProviderCatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderSettings {
    pub session: String,
    pub auto_name: String,
}

pub fn validate_agent_type(agent_type: &str) -> bool {
    AGENT_TYPES.contains(&agent_type)
}

/// Agent types that are configurable only at the workspace (global) level.
/// These have no per-project or per-feature override columns — their
/// behavior is inherently application-wide.
pub const WORKSPACE_ONLY_AGENT_TYPES: &[&str] = &["auto_name"];

pub fn is_workspace_only_agent_type(agent_type: &str) -> bool {
    WORKSPACE_ONLY_AGENT_TYPES.contains(&agent_type)
}

/// Reject agent types that aren't allowed to be overridden at the given scope.
/// Used by project/feature setters to block workspace-only types.
pub fn reject_workspace_only(agent_type: &str, scope: &str) -> Result<(), crate::error::AppError> {
    if is_workspace_only_agent_type(agent_type) {
        return Err(crate::error::AppError::BadRequest(format!(
            "Agent type '{agent_type}' is workspace-only and cannot be overridden per {scope}"
        )));
    }
    Ok(())
}

pub fn runtime_setting_key(agent_type: &str) -> String {
    format!("agent_runtime_{agent_type}")
}

pub fn default_provider_settings() -> ProviderSettings {
    let default = DEFAULT_PROVIDER.to_string();
    ProviderSettings {
        session: default.clone(),
        auto_name: default,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        default_provider_settings, is_workspace_only_agent_type, reject_workspace_only,
        validate_agent_type, DEFAULT_PROVIDER,
    };
    use crate::error::AppError;

    #[test]
    fn validates_supported_agent_types() {
        assert!(validate_agent_type("session"));
        assert!(validate_agent_type("auto_name"));
        assert!(!validate_agent_type("plan"));
        assert!(!validate_agent_type("unknown"));
    }

    #[test]
    fn auto_name_is_workspace_only() {
        assert!(is_workspace_only_agent_type("auto_name"));
        assert!(!is_workspace_only_agent_type("session"));
    }

    #[test]
    fn reject_workspace_only_blocks_auto_name_with_scoped_message() {
        let err = reject_workspace_only("auto_name", "feature").unwrap_err();
        match err {
            AppError::BadRequest(msg) => {
                assert!(msg.contains("auto_name"));
                assert!(msg.contains("feature"));
            }
            other => panic!("expected BadRequest, got {other:?}"),
        }
        assert!(reject_workspace_only("session", "feature").is_ok());
    }

    #[test]
    fn default_provider_settings_use_default_for_all_agent_types() {
        let settings = default_provider_settings();

        assert_eq!(settings.session, DEFAULT_PROVIDER);
        assert_eq!(settings.auto_name, DEFAULT_PROVIDER);
    }
}
