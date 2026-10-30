//! Database persistence for WebSocket sessions.
//!
//! Mirrors the logic in `SessionPersistence.ts` (Effect service) but implemented
//! in Rust using sqlx. Transcript errors propagate independently from live
//! event forwarding, with bounded recovery from complete assistant messages.

use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use tracing::{debug, error};

use crate::domain::agents::adapter::{
    is_file_change_tool_name, RuntimeAssistantMessage, RuntimeContentBlock, RuntimeContentDelta,
    RuntimeEvent, RuntimeStreamEvent, RuntimeStreamScope, RuntimeToolInputBuffer,
    RuntimeUserContentBlock, RuntimeUserMessage,
};

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

mod transcript;
pub use transcript::{TranscriptPersistenceError, TranscriptPersistenceStatus};

mod event_identity;
pub use event_identity::{raw_event_with_agent_message_id, PersistedEventRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergeableMessageType {
    Text,
    Thinking,
}

impl MergeableMessageType {
    fn db_value(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Thinking => "thinking",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct PendingMergeableBlock {
    row_id: i64,
    message_type: MergeableMessageType,
}

pub struct WsSessionPersistence {
    write_pool: SqlitePool,
    session_db_id: Option<i64>,
    feature_id: i64,
    current_models: HashMap<RuntimeStreamScope, String>,
    /// (runtime stream scope, block_index) -> partial JSON being accumulated
    pending_tool_inputs: HashMap<(RuntimeStreamScope, u64), RuntimeToolInputBuffer>,
    /// (runtime stream scope, block_index) -> agent_messages.id for the tool_call row
    pending_tool_row_ids: HashMap<(RuntimeStreamScope, u64), i64>,
    /// (runtime stream scope, block_index) -> merged text/thinking row metadata
    pending_mergeable_blocks: HashMap<(RuntimeStreamScope, u64), PendingMergeableBlock>,
    /// Runtime stream scopes whose current message cycle streamed text/thinking
    /// (via `message_start` … content deltas). Used to decide whether a full
    /// assistant message's text was already persisted live, so the
    /// reconciliation fallback only writes text that was NOT streamed and never
    /// double-writes a normal turn. Reset per cycle on `message_start` and
    /// consumed when the full assistant message is reconciled.
    streamed_assistant_content: HashSet<RuntimeStreamScope>,
    transcript: transcript::TranscriptDurability,
    file_change_marked: bool,
}

include!("persistence/session_bootstrap.rs");
include!("persistence/session_tool_input_buffer.rs");
include!("persistence/session_mergeable_blocks.rs");
include!("persistence/session_events/compact.rs");
include!("persistence/session_events.rs");
include!("persistence/session_tool_results.rs");
// session_events' `#[cfg(test)]` suite is too large to keep inline under the
// 400-line cap; its overflow tests are split into these two included files
// (same flat module scope as session_events via `include!`).
include!("persistence/session_events_compact_tests.rs");
include!("persistence/session_events_reconcile_tests.rs");
include!("persistence/session_error_messages.rs");
include!("persistence/session_tool_reconciliation.rs");
include!("persistence/session_tool_output_dedup.rs");
include!("persistence/session_subagents.rs");
include!("persistence/session_queries.rs");
include!("persistence/session_state.rs");
include!("persistence/pending_user_input.rs");
include!("persistence/pending_user_gate.rs");
include!("persistence/session_archiving.rs");
include!("persistence/session_cleanup.rs");
