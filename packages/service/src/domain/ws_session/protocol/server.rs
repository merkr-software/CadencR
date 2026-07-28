use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimePermissionOption};
use crate::domain::sessions::models::AgentMessageOrigin;
pub use crate::domain::sessions::models::UserMessageDeliveryState;

use super::{GateCloseReason, PermissionDecision, WsEnvelope, WsSessionAction};

// --- Server → Client payloads ---

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionUsageUpdatePayload {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Authoritative context window for the active model. `None` means
    /// "unknown until the provider reports one" — distinct from 0.
    ///
    /// Each update carries the sender's *complete* usage snapshot, so an absent
    /// window means the window is currently unknown — not "unchanged". Clients
    /// must not fall back to one they saw earlier: that is how a retracted
    /// window (a mid-session model switch) would keep scaling the bar by a
    /// model that is no longer running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
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
    pub access_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub supports_prompt_receipts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionMessagePayload {
    pub blocks: Vec<serde_json::Value>,
    /// Per-stream monotonic sequence number stamped by the stream reader so a
    /// client can detect a dropped envelope (a gap) and resync from the DB
    /// instead of silently rendering a truncated message. `None` on
    /// non-streamed `session.message` emitters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
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

pub fn is_question_tool(tool_name: &str) -> bool {
    tool_name == "AskUserQuestion"
}

/// Strip allow/deny chrome from AskUserQuestion payloads so API/sidebar
/// surfaces treat them as questions rather than permission prompts.
pub fn clear_question_permission_chrome(payload: &mut PermissionRequestPayload) {
    if !is_question_tool(&payload.tool_name) {
        return;
    }
    payload.options.clear();
    payload.description = None;
    payload.preview = None;
    payload.pattern = None;
}

pub fn permission_request_envelope(payload: impl Serialize) -> serde_json::Result<WsEnvelope> {
    WsEnvelope::session_event(WsSessionAction::PermissionRequest, payload)
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct SessionErrorPayload {
    pub code: String,
    pub message: String,
    /// Prompt receipts observed before a terminal stream failure. Clients mark
    /// these received before failing any remaining pending prompts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub received_prompt_message_uuids: Vec<String>,
    /// Optional context carrying the permission-mode wire id involved in
    /// the failure. Set only for mode-related rejections (e.g.
    /// `MODE_REJECTED_BY_CLI`) so the FE can advance past the rejected
    /// mode in the cycle without re-querying state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Delay requested after a transient rate-limit response. Clients use this
    /// instead of immediately feeding a reconnect storm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct SessionEndedPayload {
    pub reason: String,
    /// Canonical message UUIDs whose prompt receipts were emitted during this turn. Repeating them on the
    /// terminal envelope lets clients reconcile a missed transient
    /// `prompt_received` without leaving a delivered steer pending forever.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub received_prompt_message_uuids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GateClosedPayload {
    pub session_id: String,
    pub request_id: Option<String>,
    pub reason: GateCloseReason,
}

/// `session.user_message` — the canonical persisted user-message event sent to
/// the originating client and every passive viewer. Consumers upsert it by
/// `message_uuid`; `message_id` remains the ordering and pagination cursor.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UserMessagePayload {
    pub message_id: i64,
    pub message_uuid: String,
    pub text: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<AgentMessageOrigin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_delivery_state: Option<UserMessageDeliveryState>,
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
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionLifecycleKind {
    SuspendRequested,
    Resumed,
}

/// Server → Client: a lifecycle transition driven outside the normal turn
/// flow (today: OS suspend/resume). Provider-neutral — every adapter emits
/// the same shape and the frontend renders the same banner regardless of
/// which provider is active.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionLifecyclePayload {
    pub session_id: String,
    pub kind: SessionLifecycleKind,
}

/// Discriminant for `SessionStreamStatusPayload`.
///
/// Hard failures stay on `session.error`; this enum only carries
/// transient transport-health transitions.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum StreamStatusState {
    Degraded,
    Recovered,
}

/// Provider-neutral transport-health envelope for the agent stream.
///
/// Emitted by the WS bridge when the underlying runtime reports
/// `RuntimeEventKind::StreamStatus`. Consumers can use it to distinguish
/// transient degraded/recovered stream states from terminal `session.error`
/// failures.
///
/// `reason` is opaque human-readable text suited for a tooltip (e.g.
/// `"reconnecting (attempt 3): connection refused"`, `"no heartbeat
/// for 60s"`).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionStreamStatusPayload {
    pub state: StreamStatusState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PromptReceivedPayload {
    pub message_uuid: String,
    pub delivery_state: PromptReceiptState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PromptReceiptState {
    ReceivedAgent,
    DeliveryFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FeatureRenamedPayload {
    pub feature_id: i64,
    pub title: String,
}

/// Server → Client: auto-naming is starting or finished for a feature.
/// Frontend replaces the title with a skeleton while `in_progress: true`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FeatureAutoNamingPayload {
    pub feature_id: i64,
    pub in_progress: bool,
}

/// Server → Client: one or more aspects of a feature changed.
/// The frontend uses `changed` to selectively invalidate React Query caches.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FeatureUpdatedPayload {
    pub feature_id: i64,
    pub changed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProviderSetOkPayload {
    pub provider: String,
    pub supports_prompt_receipts: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModeChangedPayload {
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelSetOkPayload {
    pub provider: String,
    pub model: String,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EffortSetOkPayload {
    pub thinking_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProfileChangedPayload {
    pub provider: String,
    pub model: Option<String>,
    pub profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RuntimeSessionIdPayload {
    pub runtime_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BranchRewoundPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "messageId")]
    pub message_id: i64,
    #[serde(rename = "draftText")]
    pub draft_text: String,
    #[serde(rename = "codeRestored")]
    pub code_restored: bool,
    #[serde(rename = "codeRestoreError")]
    pub code_restore_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BranchForkedPayload {
    #[serde(rename = "sourceSessionId")]
    pub source_session_id: String,
    #[serde(rename = "newSessionId")]
    pub new_session_id: String,
    #[serde(rename = "newFeatureId")]
    pub new_feature_id: i64,
    #[serde(rename = "projectId")]
    pub project_id: i64,
    #[serde(rename = "draftText")]
    pub draft_text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_message_seq_is_optional_on_the_wire() {
        let payload = SessionMessagePayload {
            blocks: vec![serde_json::json!({"type": "text"})],
            seq: None,
        };

        let value = serde_json::to_value(&payload).unwrap();
        assert!(value.get("seq").is_none());

        let parsed: SessionMessagePayload =
            serde_json::from_value(serde_json::json!({"blocks": []})).unwrap();
        assert_eq!(parsed.seq, None);
    }

    #[test]
    fn model_set_ok_keeps_null_context_window_for_existing_clients() {
        let payload = ModelSetOkPayload {
            provider: "codex".to_string(),
            model: "gpt-5".to_string(),
            context_window: None,
        };

        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["provider"], "codex");
        assert_eq!(value["context_window"], serde_json::Value::Null);
    }

    #[test]
    fn canonical_question_tool_is_distinct_from_permissions() {
        assert!(is_question_tool("AskUserQuestion"));
        assert!(!is_question_tool("Bash"));
    }

    #[test]
    fn clear_question_permission_chrome_strips_allow_deny() {
        let mut payload = PermissionRequestPayload {
            request_id: "req-1".into(),
            tool_name: "AskUserQuestion".into(),
            tool_input: serde_json::json!({}),
            description: Some("Allow this?".into()),
            pattern: Some("AskUserQuestion".into()),
            preview: Some("preview".into()),
            options: vec![PermissionOptionPayload {
                decision: PermissionDecision::AllowOnce,
                option_id: None,
                label: "Allow".into(),
                description: String::new(),
                collect_feedback: false,
            }],
        };
        clear_question_permission_chrome(&mut payload);
        assert!(payload.options.is_empty());
        assert!(payload.description.is_none());
        assert!(payload.preview.is_none());
        assert!(payload.pattern.is_none());
    }

    #[test]
    fn clear_question_permission_chrome_ignores_permissions() {
        let mut payload = PermissionRequestPayload {
            request_id: "req-2".into(),
            tool_name: "Bash".into(),
            tool_input: serde_json::json!({}),
            description: Some("Run bash?".into()),
            pattern: Some("Bash(*)".into()),
            preview: Some("ls".into()),
            options: vec![PermissionOptionPayload {
                decision: PermissionDecision::Deny,
                option_id: None,
                label: "Deny".into(),
                description: String::new(),
                collect_feedback: false,
            }],
        };
        clear_question_permission_chrome(&mut payload);
        assert_eq!(payload.options.len(), 1);
        assert!(payload.description.is_some());
        assert!(payload.preview.is_some());
        assert!(payload.pattern.is_some());
    }
}
