use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::ToSchema;

use crate::domain::features::models::FeatureStatus;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UserMessageDeliveryState {
    PendingAgent,
    ReceivedAgent,
    DeliveryUnknown,
    DeliveryFailed,
}

impl UserMessageDeliveryState {
    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "pending_agent" => Some(Self::PendingAgent),
            "received_agent" => Some(Self::ReceivedAgent),
            "delivery_unknown" => Some(Self::DeliveryUnknown),
            "delivery_failed" => Some(Self::DeliveryFailed),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow, ToSchema)]
pub struct AgentSessionRow {
    pub id: i64,
    pub feature_id: i64,
    pub agent_type: String,
    pub runtime_provider: Option<String>,
    pub runtime_session_id: Option<String>,
    pub status: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub subprocess_id: Option<String>,
    pub model: Option<String>,
    pub profile: Option<String>,
    pub pending_questions: Option<String>,
    pub has_file_changes: i64,
    pub permission_mode: Option<String>,
    pub codex_permission_mode: Option<String>,
    pub pending_permission: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub context_window: Option<i64>,
    pub was_compacted: i64,
    pub draft_prompt: Option<String>,
    pub message_revision: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow, ToSchema)]
pub struct ConversationReferenceCandidate {
    pub feature_id: i64,
    pub feature_title: String,
    pub project_name: String,
    pub feature_status: FeatureStatus,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AgentMessageRow {
    pub id: i64,
    pub session_id: i64,
    pub message_uuid: Option<String>,
    pub delivery_state: Option<String>,
    pub content: String,
    pub message_type: String,
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    pub parent_tool_use_id: Option<String>,
    pub created_at: Option<String>,
    pub model: Option<String>,
    #[sqlx(skip)]
    pub origin: Option<AgentMessageOrigin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageOrigin {
    pub origin_kind: String,
    pub source_session_id: Option<i64>,
    pub source_feature_id: Option<i64>,
    pub source_project_id: Option<i64>,
    pub source_message_id: Option<i64>,
    pub note: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct AgentBlock {
    pub id: String,
    #[serde(rename = "messageUuid", skip_serializing_if = "Option::is_none")]
    pub message_uuid: Option<String>,
    #[serde(
        rename = "promptDeliveryState",
        skip_serializing_if = "Option::is_none"
    )]
    pub prompt_delivery_state: Option<UserMessageDeliveryState>,
    #[serde(rename = "type")]
    pub type_: String,
    pub content: String,
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(rename = "toolArgs", skip_serializing_if = "Option::is_none")]
    pub tool_args: Option<String>,
    #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(rename = "toolUseId", skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(rename = "parentToolUseId", skip_serializing_if = "Option::is_none")]
    pub parent_tool_use_id: Option<String>,
    /// Nested child blocks (for Task/Agent tool calls)
    #[serde(rename = "childBlocks", skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Vec<Object>>)]
    pub child_blocks: Option<Vec<AgentBlock>>,
    #[serde(rename = "sourceToolName", skip_serializing_if = "Option::is_none")]
    pub source_tool_name: Option<String>,
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// When true, `content` is a bounded server-side preview of oversized
    /// persisted content. The complete payload is reachable via
    /// `GET /api/sessions/messages/{id}/full`.
    #[serde(rename = "truncatedContent", skip_serializing_if = "Option::is_none")]
    pub truncated_content: Option<bool>,
    /// UTF-8 size of the complete persisted content when `content` is a
    /// bounded preview of it, so the client can say what loading it costs.
    #[serde(rename = "fullContentBytes", skip_serializing_if = "Option::is_none")]
    pub full_content_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<AgentMessageOrigin>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionState {
    #[serde(rename = "sessionDbId")]
    pub session_db_id: i64,
    #[serde(rename = "agentType")]
    pub agent_type: String,
    pub status: String,
    #[serde(rename = "subprocessId")]
    pub subprocess_id: Option<String>,
    pub model: Option<String>,
    pub profile: Option<String>,
    pub blocks: Vec<AgentBlock>,
    #[serde(rename = "maxMessageId")]
    pub max_message_id: i64,
    #[serde(rename = "maxContentRevision")]
    pub max_content_revision: Option<i64>,
    #[serde(rename = "hasMoreContentRevisions")]
    pub has_more_content_revisions: Option<bool>,
    #[serde(
        rename = "hasMoreIncrementalMessages",
        skip_serializing_if = "Option::is_none"
    )]
    pub has_more_incremental_messages: Option<bool>,
    #[serde(rename = "isIncremental")]
    pub is_incremental: bool,
    #[serde(rename = "toolCallUpdates", skip_serializing_if = "Option::is_none")]
    pub tool_call_updates: Option<HashMap<String, String>>,
    #[serde(
        rename = "truncatedToolCallUpdateIds",
        skip_serializing_if = "Option::is_none"
    )]
    pub truncated_tool_call_update_ids: Option<Vec<String>>,
    #[serde(rename = "pendingQuestions")]
    pub pending_questions: Option<serde_json::Value>,
    #[serde(rename = "hasFileChanges")]
    pub has_file_changes: bool,
    pub resumable: bool,
    #[serde(rename = "runtimeProvider")]
    pub runtime_provider: Option<String>,
    #[serde(rename = "runtimeSessionId")]
    pub runtime_session_id: Option<String>,
    pub todos: Option<Vec<serde_json::Value>>,
    #[serde(rename = "permissionMode")]
    pub permission_mode: String,
    // The SQLite column retains its historical Codex-specific name, but this
    // provider-neutral session API exposes the access axis generically.
    #[serde(rename = "accessMode")]
    pub codex_permission_mode: String,
    #[serde(rename = "pendingPermission")]
    pub pending_permission: Option<serde_json::Value>,
    #[serde(rename = "inputTokens")]
    pub input_tokens: i64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: i64,
    #[serde(rename = "contextWindow")]
    pub context_window: Option<i64>,
    #[serde(rename = "wasCompacted")]
    pub was_compacted: bool,
    #[serde(rename = "draftPrompt")]
    pub draft_prompt: Option<String>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    #[serde(rename = "oldestMessageId")]
    pub oldest_message_id: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FeatureAgentStateResponse {
    pub sessions: Vec<SessionState>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum UnifiedAgentsMode {
    Recent,
    All,
}

impl Default for UnifiedAgentsMode {
    fn default() -> Self {
        Self::Recent
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UnifiedAgentProject {
    pub id: i64,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UnifiedAgentFeature {
    pub id: i64,
    pub title: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub label: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UnifiedAgentEntry {
    pub project: UnifiedAgentProject,
    pub feature: UnifiedAgentFeature,
    pub session: SessionState,
    pub agent_created_at: String,
    pub last_activity_at: Option<String>,
    pub is_pinned: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UnifiedAgentsResponse {
    pub agents: Vec<UnifiedAgentEntry>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DraftResponse {
    #[serde(rename = "draftPrompt")]
    pub draft_prompt: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SaveDraftRequest {
    pub draft: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SaveDraftResponse {
    pub success: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MessageFullContentResponse {
    pub content: String,
}

/// Result of syncing a session from the provider's on-disk CLI conversation.
#[derive(Debug, Serialize, ToSchema)]
pub struct RefreshSessionResponse {
    /// How many newer events were appended (`0` when already up to date).
    pub added: u32,
    /// The `agent_sessions.id` the events were appended to — lets the client
    /// fetch exactly the new rows even when its own session id is stale.
    pub session_db_id: i64,
    /// Highest `agent_messages.id` present *before* the append. The new rows are
    /// exactly those with `id > cursor`, so the client fetches `after` this.
    pub cursor: i64,
}

/// Notification preview: the start of the agent's latest text reply for a
/// feature, cleaned to a single line. `null` when the feature has no agent
/// reply yet (callers fall back to the feature title).
#[derive(Debug, Serialize, ToSchema)]
pub struct MessagePreviewResponse {
    pub preview: Option<String>,
}

/// How many of the agent's todos are done, out of the whole list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct TodoProgress {
    pub done: i64,
    pub total: i64,
}

/// What a sidebar row previews of a conversation: its last agent reply and
/// how far its todo list has come. Either is `None` until the agent has one.
#[derive(Debug, Serialize, ToSchema)]
pub struct FeatureRowSummaryResponse {
    pub preview: Option<String>,
    pub todos: Option<TodoProgress>,
}

/// Raw row used by `get_session_status_snapshot`.
#[derive(Debug, sqlx::FromRow)]
pub struct SessionStatusSnapshotRow {
    pub session_id: i64,
    pub feature_id: i64,
    pub status: String,
    pub pending_permission: bool,
    pub pending_question: bool,
    pub request_id: Option<String>,
}

/// Public-facing per-session status entry serialized in
/// `app/session_status.snapshot` payloads. The `seq` is stamped at
/// subscription time by the WS handler, so it lives on the snapshot
/// envelope rather than per-entry.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SessionStatusSnapshotEntry {
    pub session_id: i64,
    pub feature_id: i64,
    pub status: crate::domain::session_status::AgentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<crate::domain::session_status::PendingKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Server-stamped turn start (epoch ms) for a non-idle session, so a
    /// (re)connecting client anchors its elapsed timer to the same instant as
    /// every other device. Kept by the live status book; `None` for a gate
    /// restored from the DB at boot (the DB has no per-turn start column).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_started_at_ms: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_block_serde_roundtrip() {
        let block = AgentBlock {
            id: "msg-1".to_string(),
            message_uuid: Some("a48cc11a-8a72-47f7-8577-d5c533d7909c".to_string()),
            prompt_delivery_state: Some(UserMessageDeliveryState::ReceivedAgent),
            type_: "text".to_string(),
            content: "hello".to_string(),
            tool_name: None,
            tool_args: None,
            is_error: None,
            tool_use_id: None,
            parent_tool_use_id: None,
            child_blocks: None,
            source_tool_name: None,
            created_at: Some("2024-01-01".to_string()),
            model: None,
            truncated_content: None,
            full_content_bytes: None,
            origin: None,
        };
        let json = serde_json::to_string(&block).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["id"], "msg-1");
        assert_eq!(parsed["type"], "text");
        assert_eq!(parsed["content"], "hello");
        assert_eq!(
            parsed["messageUuid"],
            "a48cc11a-8a72-47f7-8577-d5c533d7909c"
        );
        assert_eq!(parsed["createdAt"], "2024-01-01");
        // None fields skipped
        assert!(parsed.get("toolName").is_none());
    }

    #[test]
    fn test_agent_block_tool_call_serde() {
        let block = AgentBlock {
            id: "msg-2".to_string(),
            message_uuid: None,
            prompt_delivery_state: None,
            type_: "tool_call".to_string(),
            content: "{\"cmd\":\"ls\"}".to_string(),
            tool_name: Some("Bash".to_string()),
            tool_args: Some("{\"cmd\":\"ls\"}".to_string()),
            is_error: None,
            tool_use_id: Some("tu-1".to_string()),
            parent_tool_use_id: None,
            child_blocks: None,
            source_tool_name: None,
            created_at: None,
            model: None,
            truncated_content: None,
            full_content_bytes: None,
            origin: None,
        };
        let json = serde_json::to_string(&block).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["toolName"], "Bash");
        assert_eq!(parsed["toolUseId"], "tu-1");
        assert_eq!(parsed["toolArgs"], "{\"cmd\":\"ls\"}");
    }

    #[test]
    fn test_agent_block_nested_children() {
        let child = AgentBlock {
            id: "msg-child".to_string(),
            message_uuid: None,
            prompt_delivery_state: None,
            type_: "text".to_string(),
            content: "child content".to_string(),
            tool_name: None,
            tool_args: None,
            is_error: None,
            tool_use_id: None,
            parent_tool_use_id: Some("tu-task".to_string()),
            child_blocks: None,
            source_tool_name: None,
            created_at: None,
            model: None,
            truncated_content: None,
            full_content_bytes: None,
            origin: None,
        };
        let parent = AgentBlock {
            id: "msg-task".to_string(),
            message_uuid: None,
            prompt_delivery_state: None,
            type_: "tool_call".to_string(),
            content: "{}".to_string(),
            tool_name: Some("Task".to_string()),
            tool_args: Some("{}".to_string()),
            is_error: None,
            tool_use_id: Some("tu-task".to_string()),
            parent_tool_use_id: None,
            child_blocks: Some(vec![child]),
            source_tool_name: None,
            created_at: None,
            model: None,
            truncated_content: None,
            full_content_bytes: None,
            origin: None,
        };
        let json = serde_json::to_string(&parent).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let children = parsed["childBlocks"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["id"], "msg-child");
        assert_eq!(children[0]["parentToolUseId"], "tu-task");
    }

    #[test]
    fn test_draft_response_serde() {
        let resp = DraftResponse {
            draft_prompt: Some("draft".to_string()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["draftPrompt"], "draft");
    }

    #[test]
    fn test_save_draft_request_deserialization() {
        let json = r#"{"draft": "my draft text"}"#;
        let req: SaveDraftRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.draft.as_deref(), Some("my draft text"));

        let json_null = r#"{"draft": null}"#;
        let req_null: SaveDraftRequest = serde_json::from_str(json_null).unwrap();
        assert!(req_null.draft.is_none());
    }
}
