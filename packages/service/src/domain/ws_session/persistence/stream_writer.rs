//! Stream-scoped transcript writing, reconciliation, and durability tracking.

use crate::domain::agents::adapter::{RuntimeStreamScope, RuntimeToolInputBuffer};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};

mod blocks;
mod compact;
mod events;
mod subagents;
mod text_blocks;
mod tool_blocks;
mod tool_input;
mod tool_output_dedup;
mod tool_reconciliation;
mod tool_results;
pub(super) mod transcript;

pub(crate) use tool_output_dedup::{result_output_text, strip_duplicated_bash_output};

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

pub(super) struct TranscriptWriter {
    write_pool: SqlitePool,
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

impl TranscriptWriter {
    pub(super) fn new(write_pool: SqlitePool) -> Self {
        Self {
            write_pool,
            current_models: HashMap::new(),
            pending_tool_inputs: HashMap::new(),
            pending_tool_row_ids: HashMap::new(),
            pending_mergeable_blocks: HashMap::new(),
            streamed_assistant_content: HashSet::new(),
            transcript: Default::default(),
            file_change_marked: false,
        }
    }
}
