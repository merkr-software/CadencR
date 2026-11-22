//! The queue row as stored, and as the composer lists it.

use serde::Serialize;

use crate::domain::sessions::models::AgentMessageOrigin;

/// Note on an agent message's origin, in the composer and the transcript.
pub(crate) const AGENT_MESSAGE_NOTE: &str = "delivered from queued session message";

/// Where a queued prompt stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::Type, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum QueuedPromptStatus {
    /// Waiting, editable.
    Pending,
    /// Claimed for sending.
    Delivering,
    /// The last delivery attempt failed (see `error`); editing retries it.
    Error,
}

/// Who queued a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type)]
#[sqlx(rename_all = "snake_case")]
pub(crate) enum QueueOrigin {
    /// The user, from the composer.
    User,
    /// Another session's agent (`delivery=next_turn`).
    Session,
}

/// A queue row with what delivery needs.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct QueueRow {
    pub id: i64,
    pub session_id: i64,
    pub content: String,
    pub status: QueuedPromptStatus,
    pub error: Option<String>,
    pub created_at: String,
    pub message_uuid: Option<String>,
    pub origin_kind: QueueOrigin,
    pub source_session_id: Option<i64>,
    pub attempt_count: i64,
    /// Read only by listings, which join the sender's conversation.
    #[sqlx(default)]
    pub source_feature_id: Option<i64>,
    #[sqlx(default)]
    pub source_project_id: Option<i64>,
}

/// A prompt waiting for the end of the agent's turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct QueuedPrompt {
    pub id: i64,
    pub session_id: i64,
    pub content: String,
    pub status: QueuedPromptStatus,
    pub error: Option<String>,
    pub created_at: String,
    /// The conversation whose agent queued this message
    /// (`delivery=next_turn`); absent for the user's own queued prompts.
    pub origin: Option<AgentMessageOrigin>,
}

impl From<QueueRow> for QueuedPrompt {
    fn from(row: QueueRow) -> Self {
        let origin = (row.origin_kind == QueueOrigin::Session).then(|| AgentMessageOrigin {
            origin_kind: "session_generated".to_string(),
            source_session_id: row.source_session_id,
            source_feature_id: row.source_feature_id,
            source_project_id: row.source_project_id,
            source_message_id: None,
            note: Some(AGENT_MESSAGE_NOTE.to_string()),
            created_at: Some(row.created_at.clone()),
        });
        Self {
            id: row.id,
            session_id: row.session_id,
            content: row.content,
            status: row.status,
            error: row.error,
            created_at: row.created_at,
            origin,
        }
    }
}
