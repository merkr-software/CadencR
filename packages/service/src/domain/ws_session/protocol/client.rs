use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::agents::adapter::RuntimeSessionConfigValue;

use super::PermissionDecision;

// --- Client → Server payloads ---

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionInitPayload {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking_effort: Option<String>,
    pub permission_mode: Option<String>,
    pub system_prompt: Option<String>,
    pub cwd: Option<String>,
    pub feature_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ImagePayload {
    pub base64: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PromptAttachmentPayload {
    pub base64: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(default, rename = "fileName")]
    pub file_name: String,
    #[serde(default)]
    pub kind: Option<String>,
}

/// "From branch" (project-path) provisioning, requested on the first prompt.
/// When present, the backend auto-names the feature first, then forks a new
/// branch *with that name* in the project folder — no worktree, no setup. The
/// name must be derived server-side (after auto-naming), which is why this can
/// not be a pre-send git call from the client. `base` of `None` forks from the
/// project's current HEAD; `Some(ref)` forks from that ref.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct NewProjectBranchPayload {
    #[serde(default)]
    pub base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PromptSendPayload {
    pub session_id: String,
    pub text: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub claude_profile: Option<String>,
    #[serde(default)]
    pub images: Vec<ImagePayload>,
    #[serde(default)]
    pub attachments: Vec<PromptAttachmentPayload>,
    pub use_worktree: Option<bool>,
    #[serde(default)]
    pub new_project_branch: Option<NewProjectBranchPayload>,
    /// Stable Cadencr-owned identity for this logical user message. The backend
    /// persists it under a per-session unique constraint and echoes it on the
    /// canonical `session.user_message` event.
    #[serde(default)]
    pub message_uuid: Option<String>,
    #[serde(default)]
    pub track_prompt_receipt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PermissionRespondPayload {
    pub session_id: String,
    pub request_id: String,
    #[serde(default)]
    pub message_uuid: Option<String>,
    pub decision: PermissionDecision,
    pub option_id: Option<String>,
    pub feedback: Option<String>,
    pub updated_input: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GateCloseReason {
    Sleep,
    Escape,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GateClosePayload {
    pub session_id: String,
    pub request_id: Option<String>,
    pub reason: GateCloseReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionActionPayload {
    pub session_id: String,
    #[serde(default)]
    pub message_uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionConfigSetPayload {
    pub session_id: String,
    pub config_id: String,
    pub value: RuntimeSessionConfigValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderSetPayload {
    pub session_id: String,
    pub provider: String,
    /// Model to adopt under the new provider, when the caller wants a
    /// specific one instead of the provider's default. Validated against the
    /// new provider's catalog server-side; falls back to the default when
    /// absent or invalid. Optional for older clients.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelSetPayload {
    pub session_id: String,
    pub model: String,
    /// Provider owning the selected catalog entry; optional for older clients.
    #[serde(default)]
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModeSetPayload {
    pub session_id: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AccessModeSetPayload {
    pub session_id: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EffortSetPayload {
    pub session_id: String,
    pub thinking_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FastModeSetPayload {
    pub session_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProfileSetPayload {
    pub session_id: String,
    pub profile: String,
}
