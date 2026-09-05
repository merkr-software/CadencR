//! Sticky-index bookkeeping for ACP streaming content blocks. Split out of
//! `events.rs` so that file stays under the 400-line ceiling.
//!
//! ACP `agent_message_chunk` notifications carry no part-id, so we track a
//! single open text/thinking block index here and let consecutive same-kind
//! chunks share that index. Without sticky indices the FE would see one
//! fresh content block per delta, which fragments persisted assistant
//! messages and breaks streaming render.
//!

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::stream_events;
use super::stream_events::message_start_event;
use super::terminal_io::{TerminalOutput, DEFAULT_TERMINAL_OUTPUT_LIMIT};
use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent};

#[derive(Default)]
pub struct EventIndexer {
    next_index: u64,
    tool_indices: HashMap<String, u64>,
    /// Canonical Cadencr-side tool name (e.g. `Write`, `Bash`) keyed by the
    /// ACP `toolCallId`. Recorded on `tool_call` start so that subsequent
    /// `tool_call_update` mappings — which typically don't repeat the tool
    /// name — can still tell whether the call is a file-change tool and
    /// whether to synthesise an `input_json_delta` from the update payload.
    tool_names: HashMap<String, String>,
    /// `toolCallId` of the most recently-opened `TodoWrite` tool block.
    /// Used by the `plan` session-update mapper to backfill todos onto the
    /// existing tool block (OpenCode emits `tool_call(todowrite)` with an
    /// empty `rawInput`, then sends the actual entries via `plan`).
    pub last_todowrite_call_id: Option<String>,
    plan_todowrite_emitted: bool,
    suppressed_tool_call_ids: HashSet<String>,
    compact_boundary_emitted: bool,
    pub current_text_index: Option<u64>,
    pub current_thinking_index: Option<u64>,
    /// True once we've emitted a `message_start` for the current assistant
    /// message segment. ACP doesn't have an explicit "new message" signal,
    /// so we synthesise one when text/thinking starts after a turn boundary
    /// or a tool call. The FE relies on this envelope to allocate a new
    /// chat bubble.
    pub message_started: bool,
    question_prompt_ids: HashSet<String>,
    tool_inputs: HashMap<String, Value>,
    /// ACP terminal output arrives as deltas in `_meta.terminal_output`
    /// rather than standard `content` / `rawOutput`. Accumulate it until the
    /// terminal exit update so the provider-neutral tool result contains the
    /// complete command output.
    terminal_outputs: HashMap<String, TerminalOutput>,
}

impl EventIndexer {
    pub fn next_anonymous(&mut self) -> u64 {
        let i = self.next_index;
        self.next_index += 1;
        i
    }

    pub fn index_for_tool(&mut self, tool_call_id: &str) -> u64 {
        if let Some(idx) = self.tool_indices.get(tool_call_id) {
            return *idx;
        }
        let idx = self.next_index;
        self.next_index += 1;
        self.tool_indices.insert(tool_call_id.to_string(), idx);
        idx
    }

    /// Remember the canonical tool name observed at `tool_call` start. Also
    /// stamps the recency tracker for the TodoWrite/plan join.
    pub fn record_tool_name(&mut self, tool_call_id: &str, tool_name: &str) {
        self.tool_names
            .insert(tool_call_id.to_string(), tool_name.to_string());
        if tool_name == "TodoWrite" {
            self.last_todowrite_call_id = Some(tool_call_id.to_string());
        }
    }

    pub fn tool_name_for(&self, tool_call_id: &str) -> Option<&str> {
        self.tool_names.get(tool_call_id).map(String::as_str)
    }

    pub fn record_tool_input(&mut self, tool_call_id: &str, input: Value) {
        self.tool_inputs.insert(tool_call_id.to_string(), input);
    }

    pub fn tool_input_for(&self, tool_call_id: &str) -> Option<&Value> {
        self.tool_inputs.get(tool_call_id)
    }

    pub fn append_terminal_output(&mut self, tool_call_id: &str, delta: &str) {
        if let Some(output) = self.terminal_outputs.get_mut(tool_call_id) {
            output.append(delta.as_bytes());
            return;
        }
        let mut output = TerminalOutput::new(DEFAULT_TERMINAL_OUTPUT_LIMIT);
        output.append(delta.as_bytes());
        self.terminal_outputs
            .insert(tool_call_id.to_string(), output);
    }

    pub fn has_terminal_output(&self, tool_call_id: &str) -> bool {
        self.terminal_outputs.contains_key(tool_call_id)
    }

    pub fn take_terminal_output(&mut self, tool_call_id: &str) -> Option<(String, bool)> {
        self.terminal_outputs
            .remove(tool_call_id)
            .map(|output| output.snapshot())
    }

    pub fn mark_plan_todowrite_emitted(&mut self) {
        self.plan_todowrite_emitted = true;
    }

    pub fn has_plan_todowrite_emitted(&self) -> bool {
        self.plan_todowrite_emitted
    }

    pub fn suppress_tool_call(&mut self, tool_call_id: &str) {
        self.suppressed_tool_call_ids
            .insert(tool_call_id.to_string());
    }

    pub fn is_tool_call_suppressed(&self, tool_call_id: &str) -> bool {
        self.suppressed_tool_call_ids.contains(tool_call_id)
    }

    pub fn mark_compact_boundary_emitted(&mut self) {
        self.compact_boundary_emitted = true;
    }

    pub fn take_compact_boundary_emitted(&mut self) -> bool {
        let emitted = self.compact_boundary_emitted;
        self.compact_boundary_emitted = false;
        emitted
    }

    pub fn mark_question_prompt_emitted(&mut self, tool_call_id: &str) -> bool {
        self.question_prompt_ids.insert(tool_call_id.to_string())
    }

    /// Allocate (or reuse) the index for the currently-open text block.
    /// `is_new == true` means the caller must emit a `ContentBlockStart`
    /// before the first delta; subsequent same-kind chunks just emit deltas.
    pub fn open_text_block(&mut self) -> (u64, bool) {
        match self.current_text_index {
            Some(idx) => (idx, false),
            None => {
                let idx = self.next_anonymous();
                self.current_text_index = Some(idx);
                (idx, true)
            }
        }
    }

    pub fn open_thinking_block(&mut self) -> (u64, bool) {
        match self.current_thinking_index {
            Some(idx) => (idx, false),
            None => {
                let idx = self.next_anonymous();
                self.current_thinking_index = Some(idx);
                (idx, true)
            }
        }
    }

    /// Take ownership of the currently-open streaming-block indices, if any.
    /// Caller emits `ContentBlockStop` for each index returned. After the
    /// call both currents are `None`, so the next text/thinking chunk
    /// allocates a fresh block.
    pub fn drain_open_streaming_blocks(&mut self) -> Vec<u64> {
        let mut out = Vec::new();
        if let Some(idx) = self.current_text_index.take() {
            out.push(idx);
        }
        if let Some(idx) = self.current_thinking_index.take() {
            out.push(idx);
        }
        out
    }

    /// Drain any open text/thinking blocks and produce the matching
    /// `ContentBlockStop` envelopes. Used at turn end (W4) to make sure the
    /// FE never sees an open streaming block lingering past `stop_reason`.
    /// Also clears `message_started` so the next turn synthesises a fresh
    /// `message_start`.
    pub fn drain_open_blocks(&mut self, session_id: Option<&str>) -> Vec<RuntimeEvent> {
        let stops: Vec<RuntimeEvent> = self
            .drain_open_streaming_blocks()
            .into_iter()
            .map(|index| stream_stop_event(index, session_id))
            .collect();
        self.last_todowrite_call_id = None;
        self.plan_todowrite_emitted = false;
        self.suppressed_tool_call_ids.clear();
        self.terminal_outputs.clear();
        if !stops.is_empty() {
            self.message_started = false;
        }
        stops
    }
}

/// Build `ContentBlockStop` events for any text/thinking block still open
/// when a non-streaming variant arrives (tool call, plan, etc). Without this
/// the FE never sees the closing of the streaming block and treats the
/// following start as a sibling delta on the same content slot.
///
/// Returned via `Vec` rather than wrapping a closure so callers can sequence
/// the drain (which needs `&mut indexer`) before the mapping call (which
/// also needs `&mut indexer`) without fighting the borrow checker.
pub fn drain_streaming_block_stops(
    indexer: &mut EventIndexer,
    session_id: Option<&str>,
) -> Vec<RuntimeEvent> {
    indexer
        .drain_open_streaming_blocks()
        .into_iter()
        .map(|index| stream_stop_event(index, session_id))
        .collect()
}

/// Emit a `ContentBlockStart` envelope using the HTTP path's canonical raw
/// shape so the FE WS parser recognises it. `is_thinking` selects between
/// a Thinking and a Text content block.
pub fn stream_start_event(index: u64, is_thinking: bool, session_id: Option<&str>) -> RuntimeEvent {
    let block = if is_thinking {
        RuntimeContentBlock::Thinking {
            thinking: String::new(),
        }
    } else {
        RuntimeContentBlock::Text {
            text: String::new(),
        }
    };
    stream_events::stream_start_event(session_id.unwrap_or(""), index, block, None)
}

pub fn stream_stop_event(index: u64, session_id: Option<&str>) -> RuntimeEvent {
    stream_events::stream_stop_event(session_id.unwrap_or(""), index, None)
}

pub fn stream_delta_event(
    index: u64,
    delta: RuntimeContentDelta,
    session_id: Option<&str>,
) -> RuntimeEvent {
    stream_events::stream_delta_event(session_id.unwrap_or(""), index, delta, None)
}

/// Synthesize the per-message envelope the FE uses to allocate a new
/// assistant chat bubble. Called once per message segment, before the
/// first text/thinking `ContentBlockStart`.
pub fn message_start_for(session_id: Option<&str>, active_model: Option<&str>) -> RuntimeEvent {
    message_start_event(
        session_id.unwrap_or(""),
        active_model.map(ToOwned::to_owned),
        None,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::EventIndexer;

    #[test]
    fn tool_indexer_reuses_index_per_tool_call_id() {
        let mut idx = EventIndexer::default();
        let a = idx.index_for_tool("t-9");
        let b = idx.index_for_tool("t-9");
        assert_eq!(a, b);
    }

    #[test]
    fn open_text_block_returns_new_then_reuses_same_index() {
        let mut idx = EventIndexer::default();
        let (i1, new1) = idx.open_text_block();
        let (i2, new2) = idx.open_text_block();
        assert!(new1);
        assert!(!new2);
        assert_eq!(i1, i2);
    }

    #[test]
    fn drain_clears_state_so_next_open_allocates_fresh() {
        let mut idx = EventIndexer::default();
        let (i1, _) = idx.open_text_block();
        let drained = idx.drain_open_streaming_blocks();
        assert_eq!(drained, vec![i1]);
        let (i2, new) = idx.open_text_block();
        assert!(new);
        assert_ne!(i1, i2);
    }

    #[test]
    fn text_and_thinking_indices_are_independent() {
        let mut idx = EventIndexer::default();
        let (text_idx, _) = idx.open_text_block();
        let (think_idx, _) = idx.open_thinking_block();
        assert_ne!(text_idx, think_idx);
        let drained = idx.drain_open_streaming_blocks();
        assert_eq!(drained.len(), 2);
    }

    #[test]
    fn drain_open_blocks_emits_stop_events_and_resets_message_started() {
        let mut idx = EventIndexer::default();
        idx.open_text_block();
        idx.message_started = true;
        let events = idx.drain_open_blocks(Some("s-1"));
        assert_eq!(events.len(), 1);
        assert!(!idx.message_started);
        assert!(idx.current_text_index.is_none());
    }

    #[test]
    fn drain_open_blocks_returns_empty_when_no_blocks_open() {
        let mut idx = EventIndexer::default();
        idx.message_started = true;
        let events = idx.drain_open_blocks(None);
        assert!(events.is_empty());
        // No-op drain must not clobber message_started.
        assert!(idx.message_started);
    }

    #[test]
    fn drain_open_blocks_resets_todowrite_dedup_state() {
        let mut idx = EventIndexer::default();
        idx.record_tool_name("todo-1", "TodoWrite");
        assert_eq!(idx.last_todowrite_call_id.as_deref(), Some("todo-1"));

        let events = idx.drain_open_blocks(Some("s-1"));

        assert!(events.is_empty());
        assert!(idx.last_todowrite_call_id.is_none());
    }

    #[test]
    fn terminal_metadata_output_is_bounded() {
        let mut idx = EventIndexer::default();
        idx.append_terminal_output("terminal-1", &"x".repeat(1024 * 1024 + 1));
        let (output, truncated) = idx.take_terminal_output("terminal-1").unwrap();
        assert_eq!(output.len(), 1024 * 1024);
        assert!(truncated);
    }
}
