//! Per-agent-stream bookkeeping inside one turn.
//!
//! A turn can interleave the root agent with one or more subagents. Sharing
//! state across them would let a subagent's deltas suppress an unrelated full
//! message from the root agent, or fuse the tail of one agent's text onto the
//! head of another's — so every piece of it is kept apart, per stream.

use std::collections::HashMap;

use super::counter::WordCounter;

/// Which agent produced an event. The root agent is the empty string — a
/// subagent is always keyed by the non-empty tool use id that launched it — so
/// the map can be probed with a borrowed key and only allocates the first time
/// a stream is seen.
const ROOT_STREAM: &str = "";

/// Per-agent state within one turn.
#[derive(Debug, Default)]
pub(super) struct StreamState {
    /// This message cycle already streamed text, so the matching full assistant
    /// message must not be counted again.
    streamed_this_cycle: bool,
    /// Word carry per open content block. Deltas are contiguous *within* a
    /// block, but another block — or another agent's stream — can interleave
    /// between them, so the carry cannot be global.
    open_blocks: HashMap<u64, WordCounter>,
}

impl StreamState {
    /// A new message cycle: nothing streamed yet, and no block is open.
    pub(super) fn start_cycle(&mut self) {
        self.streamed_this_cycle = false;
        self.open_blocks.clear();
    }

    /// Count a streamed chunk, returning the words it started. Marks the cycle
    /// as streamed, which is what suppresses the matching full message.
    pub(super) fn push_streamed(&mut self, index: u64, text: &str) -> u64 {
        self.streamed_this_cycle = true;
        self.open_blocks.entry(index).or_default().push(text)
    }

    /// The block is finished; drop its carry so the next block that reuses this
    /// index starts a fresh word.
    pub(super) fn close_block(&mut self, index: u64) {
        self.open_blocks.remove(&index);
    }

    pub(super) fn streamed_this_cycle(&self) -> bool {
        self.streamed_this_cycle
    }
}

/// Every stream of one turn, keyed by the tool use id that launched it.
#[derive(Debug, Default)]
pub(super) struct TurnStreams(HashMap<String, StreamState>);

impl TurnStreams {
    /// The state for `parent`'s stream, or the root agent's when there is none.
    pub(super) fn get_mut(&mut self, parent: Option<&str>) -> &mut StreamState {
        let stream = parent.unwrap_or(ROOT_STREAM);
        // Probed borrowed and inserted owned, so the per-delta path allocates
        // nothing once the stream has been seen.
        if !self.0.contains_key(stream) {
            self.0.insert(stream.to_owned(), StreamState::default());
        }
        self.0
            .get_mut(stream)
            .expect("stream state was just inserted")
    }
}

#[cfg(test)]
mod tests {
    use super::TurnStreams;

    #[test]
    fn keeps_each_agents_cycle_apart() {
        let mut streams = TurnStreams::default();
        streams.get_mut(None).push_streamed(0, "root text");

        assert!(streams.get_mut(None).streamed_this_cycle());
        assert!(
            !streams.get_mut(Some("tool-1")).streamed_this_cycle(),
            "a subagent must not inherit the root agent's cycle"
        );
    }

    #[test]
    fn a_closed_block_starts_the_next_word_fresh() {
        let mut streams = TurnStreams::default();
        let root = streams.get_mut(None);
        assert_eq!(root.push_streamed(0, "half"), 1);
        assert_eq!(root.push_streamed(0, "way"), 0, "one word so far");

        root.close_block(0);

        assert_eq!(root.push_streamed(0, "next"), 1, "the carry is gone");
    }

    #[test]
    fn a_new_cycle_forgets_what_streamed() {
        let mut streams = TurnStreams::default();
        let root = streams.get_mut(None);
        root.push_streamed(0, "text");

        root.start_cycle();

        assert!(!root.streamed_this_cycle());
    }
}
