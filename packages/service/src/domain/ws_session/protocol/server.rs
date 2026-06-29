use serde::{Deserialize, Serialize};

use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimePermissionOption};
use crate::domain::sessions::models::AgentMessageOrigin;

use super::PermissionDecision;

// --- Server → Client payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUsageUpdatePayload {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Authoritative context window for the active model. `None` means
    /// "unknown until the provider reports one" — distinct from 0.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInitializedPayload {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub supports_prompt_receipts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMessagePayload {
    pub blocks: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequestPayload {
    pub request_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    pub description: Option<String>,
    /// Permission pattern for "allow future" persistence (e.g. "Read(/path)" or "Bash(git push:*)").
    pub pattern: Option<String>,
    pub preview: Option<String>,
    #[serde(default)]
    pub options: Vec<PermissionOptionPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionOptionPayload {
    pub decision: PermissionDecision,
    pub option_id: Option<String>,
    pub label: String,
    pub description: String,
    #[serde(default)]
    pub collect_feedback: bool,
}

impl From<RuntimePermissionOption> for PermissionOptionPayload {
    fn from(option: RuntimePermissionOption) -> Self {
        Self {
            decision: match option.decision {
                RuntimePermissionDecision::AllowOnce => PermissionDecision::AllowOnce,
                // The WS protocol predates the runtime split between
                // session-scoped and persistent grants and only exposes a
                // single `AllowFuture` discriminant; both runtime flavours
                // collapse onto it for backwards compatibility. Distinct
                // labels/descriptions still let the FE render two separate
                // buttons when the agent advertises both kinds.
                RuntimePermissionDecision::AllowFuture
                | RuntimePermissionDecision::AllowForSession => PermissionDecision::AllowFuture,
                RuntimePermissionDecision::Deny => PermissionDecision::Deny,
            },
            option_id: option.option_id,
            label: option.label,
            description: option.description,
            collect_feedback: option.collect_feedback,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionErrorPayload {
    pub code: String,
    pub message: String,
    /// Optional context carrying the permission-mode wire id involved in
    /// the failure. Set only for mode-related rejections (e.g.
    /// `MODE_REJECTED_BY_CLI`) so the FE can advance past the rejected
    /// mode in the cycle without re-querying state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEndedPayload {
    pub reason: String,
}

/// `session.user_message` — mirrors a just-sent user prompt to *other* devices
/// viewing the same feature (the remote-access conversation mirror). The device
/// that sent the prompt renders it locally and never receives this echo; only
/// passive viewers do, so their conversation shows the prompt as it's sent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessageMirrorPayload {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<AgentMessageOrigin>,
}

/// Discriminant for `SessionLifecyclePayload`.
///
/// Currently only carries OS-power-driven transitions. `SuspendRequested` is
/// emitted after the WS handler has captured the runtime session id and
/// interrupted the live process in response to a `session.suspend` envelope
/// (driven by Electron's `powerMonitor.suspend`); `Resumed` is the matching
/// acknowledgement after `session.resume`. The frontend turn-lifecycle state
/// machine consumes these via `ws-envelope-handler` — UI never flips on the
/// raw OS event, only on this backend-confirmed envelope (see
/// `no-optimistic-updates.md`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionLifecycleKind {
    SuspendRequested,
    Resumed,
}

/// Server → Client: a lifecycle transition driven outside the normal turn
/// flow (today: OS suspend/resume). Provider-neutral — every adapter emits
/// the same shape and the frontend renders the same banner regardless of
/// which provider is active.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLifecyclePayload {
    pub session_id: String,
    pub kind: SessionLifecycleKind,
}

/// Discriminant for `SessionStreamStatusPayload`.
///
/// Hard failures stay on `session.error`; this enum only carries
/// transient transport-health transitions.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamStatusState {
    Degraded,
    Recovered,
}

/// Provider-neutral transport-health envelope for the agent stream.
///
/// Emitted by the WS bridge when the underlying runtime reports
/// `RuntimeEventKind::StreamStatus`. The frontend uses this to render a
/// "Reconnecting…" / "Recovered" banner under the loader so users never
/// see an infinite silent loader (plan findings 1, 2, 3, 8).
///
/// `reason` is opaque human-readable text suited for a tooltip (e.g.
/// `"reconnecting (attempt 3): connection refused"`, `"no heartbeat
/// for 60s"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStreamStatusPayload {
    pub state: StreamStatusState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptReceivedPayload {
    pub client_message_id: String,
}

/// Server → the *sending* client only: the persisted DB id of a user message
/// the sender is showing optimistically (matched by its `user_message_ref`).
/// The sender renders its own prompt from a local `ws-user-*` block that has no
/// DB id, so rewind/fork — which cut at a persisted message id — stay hidden on
/// it until the conversation is reloaded. Stamping the id back lets those
/// actions light up on the live message immediately.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptPersistedPayload {
    pub user_message_ref: String,
    pub message_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureRenamedPayload {
    pub feature_id: i64,
    pub title: String,
}

/// Server → Client: auto-naming is starting or finished for a feature.
/// Frontend replaces the title with a skeleton while `in_progress: true`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureAutoNamingPayload {
    pub feature_id: i64,
    pub in_progress: bool,
}

/// Server → Client: one or more aspects of a feature changed.
/// The frontend uses `changed` to selectively invalidate React Query caches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureUpdatedPayload {
    pub feature_id: i64,
    pub changed: Vec<String>,
}
