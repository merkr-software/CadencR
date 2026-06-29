use serde::{Deserialize, Serialize};

use super::PermissionDecision;

// --- Client → Server payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInitPayload {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking_effort: Option<String>,
    pub permission_mode: Option<String>,
    pub system_prompt: Option<String>,
    pub cwd: Option<String>,
    pub feature_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagePayload {
    pub base64: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProjectBranchPayload {
    #[serde(default)]
    pub base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    #[serde(default)]
    pub client_message_id: Option<String>,
    /// Client-generated reference echoed back in `prompt_persisted` with the
    /// persisted DB id, so the sender can stamp its live block and enable
    /// rewind/fork without a reload. Sent for every prompt (unlike
    /// `client_message_id`, which is receipt/steering-only).
    #[serde(default)]
    pub user_message_ref: Option<String>,
    #[serde(default)]
    pub replay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRespondPayload {
    pub session_id: String,
    pub request_id: String,
    pub decision: PermissionDecision,
    pub option_id: Option<String>,
    pub feedback: Option<String>,
    pub updated_input: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GateCloseReason {
    Sleep,
    Escape,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateClosePayload {
    pub session_id: String,
    pub request_id: Option<String>,
    pub reason: GateCloseReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionActionPayload {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSetPayload {
    pub session_id: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSetPayload {
    pub session_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModeSetPayload {
    pub session_id: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexPermissionModeSetPayload {
    pub session_id: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffortSetPayload {
    pub session_id: String,
    pub thinking_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileSetPayload {
    pub session_id: String,
    pub profile: String,
}
