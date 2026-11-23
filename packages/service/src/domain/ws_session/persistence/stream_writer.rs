//! Stream-scoped transcript writing, reconciliation, and durability tracking.

use crate::domain::agents::adapter::{RuntimeStreamScope, RuntimeToolInputBuffer};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};

mod blocks;
mod compact;
mod events;
mod live_blocks;
mod subagents;
mod text_blocks;
mod tool_blocks;
mod tool_input;
mod tool_output_dedup;
mod tool_reconciliation;
mod tool_results;
pub(super) mod transcript;

pub(crate) use live_blocks::LiveBlockContent;
pub(crate) use tool_output_dedup::{result_output_text, strip_duplicated_bash_output};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergeableMessageType {
    Text,
    Thinking,
}

impl MergeableMessageType {
    pub(super) fn db_value(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Thinking => "thinking",
        }
    }
}

/// Text/thinking deltas are coalesced in memory and appended to their row at
/// most every `DELTA_FLUSH_INTERVAL` (or once `DELTA_FLUSH_MAX_BYTES` are
/// waiting), and at every block, message and turn boundary.
///
/// Durability trade-off: live frames are published before the buffer reaches
/// SQLite, so a `kill -9`, a crash, or a panic of the reader loses up to this
/// window of text per streaming block (≈200 ms / 16 KiB), and the row stays
/// shorter than what viewers saw. Nothing marks such a row: a crashed service
/// leaves the turn to the restart path, which records the interruption
/// (`restart_continuations`). A clean shutdown, a stop, a rewind and a fork all
/// flush first; only a reader aborted at shutdown is counted
/// (`health::record_persisted_loss`). Viewers attaching mid-stream are not
/// affected: the reader re-sends its live blocks' full text to them (see
/// `live_blocks`).
pub(super) const DELTA_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);
pub(super) const DELTA_FLUSH_MAX_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy)]
struct PendingMergeableBlock {
    row_id: i64,
    message_type: MergeableMessageType,
}

#[derive(Debug)]
pub(super) struct PendingDeltaBuffer {
    pub(super) row_id: i64,
    pub(super) buffered: String,
    pub(super) last_flush_at: Option<tokio::time::Instant>,
}

/// Distinguishes a repairable coalesced text/thinking delta flush failure
/// (already recorded on the delta's own scope via `mark_delta_flush_damaged`)
/// from a failure persisting the current runtime event itself.
pub(super) enum PersistEventError {
    RepairableDeltaFlush(transcript::TranscriptPersistenceError),
    EventFailure(transcript::TranscriptPersistenceError),
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
    /// (runtime stream scope, block_index) -> coalesced text/thinking delta chunks
    /// waiting for the next windowed or boundary SQLite `UPDATE`.
    pending_delta_buffers: HashMap<(RuntimeStreamScope, u64), PendingDeltaBuffer>,
    /// (runtime stream scope, block_index) -> every text/thinking row of the
    /// scope's current message cycle, stopped or not. Unlike
    /// `pending_mergeable_blocks` it survives `content_block_stop`, so a
    /// viewer attaching just after a block ended still gets its full text.
    cycle_text_rows: HashMap<(RuntimeStreamScope, u64), PendingMergeableBlock>,
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
            pending_delta_buffers: HashMap::new(),
            cycle_text_rows: HashMap::new(),
            streamed_assistant_content: HashSet::new(),
            transcript: Default::default(),
            file_change_marked: false,
        }
    }

    pub(super) fn log_boundary_delta_flush_error(
        &self,
        session_id: i64,
        boundary: &'static str,
        error: &transcript::TranscriptPersistenceError,
    ) {
        if !matches!(
            error,
            transcript::TranscriptPersistenceError::AwaitingReconciliation
        ) {
            tracing::error!(
                session_id,
                boundary,
                %error,
                "pending delta flush degraded before boundary event"
            );
        }
    }
}
