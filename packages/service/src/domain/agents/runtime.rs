use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const AGENT_TYPES: &[&str] = &["session", "auto_name"];

#[cfg(test)]
pub const DEFAULT_PROVIDER: &str = crate::domain::agents::claude_code::PROVIDER_ID;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatus {
    Available,
    Unavailable,
    ComingSoon,
}

/// How a provider became available to this Cadencr process.
///
/// This is host-owned metadata rather than an ACP capability: installed agents
/// cannot claim to be built-ins in their descriptor or handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderOrigin {
    BuiltIn,
    InstalledLocal,
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
    /// Provider/CLI-advertised default for this model. `None` means callers
    /// should leave effort unset and let the CLI apply its native default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort_level: Option<String>,
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
            default_effort_level: None,
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
    /// Connector-owned icon bytes, inlined as a bounded `data:image/...` URL.
    /// Built-ins omit this and keep using their bundled renderer assets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
    pub status: ProviderStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    pub models: Vec<ModelCatalogEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<ProviderModeCatalogEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub access_modes: Vec<ProviderModeCatalogEntry>,
    pub default_model: Option<String>,
}

impl ProviderCatalogEntry {
    pub fn unavailable(
        id: impl Into<String>,
        label: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon_data: None,
            status: ProviderStatus::Unavailable,
            status_message: Some(message.into()),
            models: Vec::new(),
            modes: Vec::new(),
            access_modes: Vec::new(),
            default_model: None,
        }
    }
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
    pub providers: Vec<ProviderCatalogResponseEntry>,
}

/// A runtime catalog entry plus the host-owned source of its registration.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderCatalogResponseEntry {
    #[serde(flatten)]
    pub provider: ProviderCatalogEntry,
    pub origin: ProviderOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_capability: Option<ProviderProfileCapability>,
    /// A prompt sent while the agent works is delivered into the running turn
    /// and acknowledged (steering). When false the composer queues it for
    /// after the turn instead of promising a steer it can't confirm.
    #[serde(default)]
    pub steering_acknowledged: bool,
    /// `/compact` is a session action Cadencr performs (manual compaction
    /// through the live runtime) rather than text the runtime understands.
    #[serde(default)]
    pub compact_action: bool,
    /// Terminal command that resumes a session outside Cadencr.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<ProviderResumeCommand>,
    /// Prompt content the provider accepts, as last negotiated over ACP
    /// `initialize`. Absent until a runtime has been observed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_capabilities: Option<ProviderPromptCapabilities>,
}

/// A program and argument vector; `{session_id}` is the only placeholder.
/// Never a shell string: the desktop quotes every element itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProviderResumeCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl ProviderResumeCommand {
    pub fn new(program: &str, args: &[&str]) -> Self {
        Self {
            program: program.to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
        }
    }
}

/// ACP `promptCapabilities`: which non-text content blocks a prompt may carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
pub struct ProviderPromptCapabilities {
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderProfileCapability {
    pub active_profile: String,
    pub default_profile: String,
    pub supports_config_inheritance: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderProfileEntry {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderProfilesResponse {
    pub provider: String,
    pub active_profile: String,
    pub default_profile: String,
    pub profiles: Vec<ProviderProfileEntry>,
}

impl std::ops::Deref for ProviderCatalogResponseEntry {
    type Target = ProviderCatalogEntry;

    fn deref(&self) -> &Self::Target {
        &self.provider
    }
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

pub fn model_setting_key(agent_type: &str) -> String {
    format!("model_{agent_type}")
}

pub fn default_provider_settings() -> ProviderSettings {
    let default = crate::domain::agents::providers::default_provider_id().to_string();
    ProviderSettings {
        session: default.clone(),
        auto_name: default,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        default_provider_settings, is_workspace_only_agent_type, reject_workspace_only,
        validate_agent_type,
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
        let default = crate::domain::agents::providers::default_provider_id();

        assert_eq!(settings.session, default);
        assert_eq!(settings.auto_name, default);
    }
}
