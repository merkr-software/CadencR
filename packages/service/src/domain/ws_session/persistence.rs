//! Database persistence for WebSocket sessions.
//!
//! Session identity and lifecycle storage are separate from stream transcript
//! writing. Transcript errors propagate independently from live event forwarding,
//! with bounded recovery from complete assistant messages.

use sqlx::SqlitePool;

use crate::domain::agents::adapter::RuntimeEvent;

const INSERT_MESSAGE_SQL: &str =
    "INSERT INTO agent_messages (session_id, role, content, message_type, tool_name, tool_use_id, parent_tool_use_id, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

/// A row from the `agent_sessions` table with the fields needed by the WS handler.
#[derive(Debug, Clone, sqlx::FromRow)]
#[allow(dead_code)]
pub struct SessionRow {
    pub id: i64,
    pub feature_id: i64,
    pub runtime_provider: Option<String>,
    pub runtime_session_id: Option<String>,
    pub model: Option<String>,
    pub profile: Option<String>,
    pub permission_mode: Option<String>,
    pub codex_permission_mode: Option<String>,
    pub status: String,
    pub pending_permission: Option<String>,
    pub pending_questions: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub context_window: Option<i64>,
    pub thinking_effort: Option<String>,
    pub fast_mode: bool,
    pub runtime_overrides: Option<String>,
}

impl SessionRow {
    pub fn has_pending_user_input(&self) -> bool {
        self.pending_permission.is_some() || self.pending_questions.is_some()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PersistedMessageRef {
    pub id: i64,
}

mod stream_writer;
pub use stream_writer::transcript::{TranscriptPersistenceError, TranscriptPersistenceStatus};
pub(crate) use stream_writer::{result_output_text, strip_duplicated_bash_output};

mod event_identity;
pub use event_identity::{raw_event_with_agent_message_id, PersistedEventRef};

mod message_store;
mod pending_user_gate;
mod pending_user_input;
mod session_archiving;
mod session_bootstrap;
mod session_cleanup;
mod session_configuration;
mod session_error_messages;
mod session_queries;
mod session_state;
mod user_messages;
pub use pending_user_gate::{PendingUserInput, PendingUserInputKind};

/// Session database identity and lifecycle, with a private stream transcript writer.
pub struct WsSessionPersistence {
    write_pool: SqlitePool,
    session_db_id: Option<i64>,
    feature_id: i64,
    writer: stream_writer::TranscriptWriter,
}

impl WsSessionPersistence {
    pub fn new(write_pool: SqlitePool, feature_id: i64) -> Self {
        Self::with_session_id(write_pool, feature_id, None)
    }

    pub fn with_session_id(
        write_pool: SqlitePool,
        feature_id: i64,
        session_db_id: Option<i64>,
    ) -> Self {
        Self {
            writer: stream_writer::TranscriptWriter::new(write_pool.clone()),
            write_pool,
            session_db_id,
            feature_id,
        }
    }

    pub async fn persist_runtime_event(
        &mut self,
        event: &RuntimeEvent,
    ) -> Result<Option<PersistedEventRef>, TranscriptPersistenceError> {
        self.writer
            .persist_runtime_event(self.session_db_id, event)
            .await
    }

    pub fn current_model_for_event(&self, event: &RuntimeEvent) -> Option<&str> {
        self.writer.current_model_for_event(event)
    }

    pub fn take_transcript_status_change(
        &mut self,
        terminal: bool,
    ) -> Option<TranscriptPersistenceStatus> {
        self.writer.take_transcript_status_change(terminal)
    }
}
