use std::collections::HashMap;

use crate::domain::agents::adapter::{
    RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent, RuntimeStreamEvent,
};

/// Counts words across an arbitrary sequence of text chunks.
///
/// The agent stream arrives as token-sized deltas, so counting each chunk in
/// isolation would score nearly every token as its own word. This keeps the
/// "currently inside a word" flag across `push` calls, so a word split over
/// several deltas is counted exactly once.
#[derive(Debug, Default, Clone, Copy)]
pub struct WordCounter {
    words: u64,
    in_word: bool,
}

impl WordCounter {
    /// Feed a chunk, returning how many *new* words it started. A word split
    /// across chunks is counted by the chunk that opened it.
    pub fn push(&mut self, text: &str) -> u64 {
        let before = self.words;
        for ch in text.chars() {
            if ch.is_whitespace() {
                self.in_word = false;
            } else if !self.in_word {
                self.in_word = true;
                self.words += 1;
            }
        }
        self.words - before
    }
}

/// Which agent produced an event. The root agent is the empty string — a
/// subagent is always keyed by the non-empty tool use id that launched it — so
/// the map can be probed with a borrowed key and only allocates the first time
/// a stream is seen. A turn can interleave several streams, so every piece of
/// per-stream state is kept apart by this.
const ROOT_STREAM: &str = "";

/// Per-agent state within one turn.
#[derive(Debug, Default)]
struct StreamState {
    /// This message cycle already streamed text, so the matching full assistant
    /// message must not be counted again.
    streamed_this_cycle: bool,
    /// Word carry per open content block. Deltas are contiguous *within* a
    /// block, but another block — or another agent's stream — can interleave
    /// between them, so the carry cannot be global.
    open_blocks: HashMap<u64, WordCounter>,
}

/// Counts every word the agent produced during one turn, provider-neutrally.
///
/// Providers fall into two camps: those that stream text as content deltas and
/// those that only deliver whole assistant messages. Counting both would double
/// the score for streaming providers, so a message cycle that streamed text
/// suppresses the full-message count for that cycle — mirroring the same
/// decision the persistence layer makes when it reconciles a full assistant
/// message against already-streamed blocks.
///
/// All of that is tracked *per agent stream*. A turn can interleave the root
/// agent with one or more subagents; sharing one flag across them would let a
/// subagent's deltas suppress an unrelated full message from the root agent, or
/// fuse the tail of one agent's text onto the head of another's.
#[derive(Debug, Default)]
pub struct TurnWordUsage {
    words: u64,
    streams: HashMap<String, StreamState>,
}

impl TurnWordUsage {
    pub fn observe(&mut self, event: &RuntimeEvent) {
        let stream = event.parent_tool_use_id().unwrap_or(ROOT_STREAM);

        if let Some(stream_event) = event.stream_event() {
            self.observe_stream_event(stream, stream_event);
            return;
        }
        let Some(message) = event.assistant_message() else {
            return;
        };
        if self.stream_mut(stream).streamed_this_cycle {
            return;
        }
        // Every block of a full message is a complete unit of text, so each is
        // counted with its own fresh carry rather than flowing into the next.
        for block in &message.content {
            if let Some(text) = block_text(block) {
                self.words += count_words(text);
            }
        }
    }

    fn observe_stream_event(&mut self, stream: &str, event: &RuntimeStreamEvent) {
        match event {
            RuntimeStreamEvent::MessageStart { .. } => {
                let state = self.stream_mut(stream);
                state.streamed_this_cycle = false;
                state.open_blocks.clear();
            }
            RuntimeStreamEvent::ContentBlockStart { index, block } => {
                if let Some(text) = block_text(block) {
                    self.push_streamed(stream, *index, text);
                }
            }
            RuntimeStreamEvent::ContentBlockDelta { index, delta } => match delta {
                RuntimeContentDelta::Text { text } => self.push_streamed(stream, *index, text),
                RuntimeContentDelta::Thinking { thinking } => {
                    self.push_streamed(stream, *index, thinking)
                }
                RuntimeContentDelta::InputJson { .. } => {}
            },
            // The block is finished; drop its carry so the next block that
            // reuses this index starts a fresh word.
            RuntimeStreamEvent::ContentBlockStop { index } => {
                self.stream_mut(stream).open_blocks.remove(index);
            }
            RuntimeStreamEvent::Other => {}
        }
    }

    fn push_streamed(&mut self, stream: &str, index: u64, text: &str) {
        if text.is_empty() {
            return;
        }
        let state = self.stream_mut(stream);
        state.streamed_this_cycle = true;
        let counted = state.open_blocks.entry(index).or_default().push(text);
        self.words += counted;
    }

    fn stream_mut(&mut self, stream: &str) -> &mut StreamState {
        // Probed borrowed and inserted owned, so the per-delta path allocates
        // nothing once the stream has been seen.
        if !self.streams.contains_key(stream) {
            self.streams
                .insert(stream.to_owned(), StreamState::default());
        }
        self.streams
            .get_mut(stream)
            .expect("stream state was just inserted")
    }

    /// Drain the accumulated total, resetting for the next turn.
    ///
    /// This also drops any mid-word carry. A flush can land while a background
    /// subagent is still streaming, in which case a single word straddling the
    /// boundary may be counted twice — bounded, unavoidable without holding
    /// per-turn state past the turn, and immaterial at word granularity.
    pub fn take(&mut self) -> u64 {
        std::mem::take(self).words
    }
}

/// The countable text of a content block, if it has any. Tool calls and
/// unknown blocks carry no prose.
fn block_text(block: &RuntimeContentBlock) -> Option<&str> {
    match block {
        RuntimeContentBlock::Text { text } => Some(text),
        RuntimeContentBlock::Thinking { thinking } => Some(thinking),
        RuntimeContentBlock::ToolUse { .. } | RuntimeContentBlock::Other => None,
    }
}

/// Words in a single complete string (user prompts, which never stream).
pub fn count_words(text: &str) -> u64 {
    WordCounter::default().push(text)
}

#[cfg(test)]
mod tests {
    use super::{count_words, TurnWordUsage, WordCounter};
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent,
        RuntimeEventKind, RuntimeEventMetadata, RuntimeStreamEvent,
    };
    use serde_json::json;

    /// A stream event from the root agent.
    fn stream(event: RuntimeStreamEvent) -> RuntimeEvent {
        stream_from(None, event)
    }

    /// A stream event from a subagent launched by tool use `parent`.
    fn stream_from(parent: Option<&str>, event: RuntimeStreamEvent) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::StreamEvent {
                event,
                parent_tool_use_id: parent.map(ToString::to_string),
            },
        )
    }

    fn assistant(content: Vec<RuntimeContentBlock>) -> RuntimeEvent {
        assistant_from(None, content)
    }

    fn assistant_from(parent: Option<&str>, content: Vec<RuntimeContentBlock>) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                raw: json!({ "type": "assistant" }),
                ..Default::default()
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content,
                },
                parent_tool_use_id: parent.map(ToString::to_string),
            },
        )
    }

    fn message_start() -> RuntimeStreamEvent {
        RuntimeStreamEvent::MessageStart {
            model: None,
            input_tokens: None,
        }
    }

    fn text_delta(text: &str) -> RuntimeEvent {
        stream(RuntimeStreamEvent::ContentBlockDelta {
            index: 0,
            delta: RuntimeContentDelta::Text { text: text.into() },
        })
    }

    #[test]
    fn counts_plain_text() {
        assert_eq!(count_words("hello brave new world"), 4);
        assert_eq!(count_words("  padded \n\t words  "), 2);
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("   "), 0);
    }

    #[test]
    fn does_not_split_a_word_across_chunks() {
        let mut counter = WordCounter::default();
        // Each chunk reports only the words it opened; "hello" belongs to the
        // first, and the "ld" tail adds nothing to the word "wor" opened before.
        assert_eq!(counter.push("hel"), 1);
        assert_eq!(counter.push("lo wor"), 1);
        assert_eq!(counter.push("ld"), 0);
    }

    #[test]
    fn counts_streamed_deltas_as_one_turn() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&stream(message_start()));
        usage.observe(&text_delta("The quick "));
        usage.observe(&text_delta("brown fo"));
        usage.observe(&text_delta("x"));
        assert_eq!(usage.take(), 4);
    }

    #[test]
    fn counts_thinking_deltas() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&stream(RuntimeStreamEvent::ContentBlockDelta {
            index: 0,
            delta: RuntimeContentDelta::Thinking {
                thinking: "let me think".into(),
            },
        }));
        assert_eq!(usage.take(), 3);
    }

    #[test]
    fn ignores_tool_input_json() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&stream(RuntimeStreamEvent::ContentBlockDelta {
            index: 0,
            delta: RuntimeContentDelta::InputJson {
                partial_json: "{\"path\": \"src/main.rs\"}".into(),
            },
        }));
        assert_eq!(usage.take(), 0);
    }

    #[test]
    fn counts_full_assistant_messages_when_nothing_streamed() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&assistant(vec![RuntimeContentBlock::Text {
            text: "one two three".into(),
        }]));
        assert_eq!(usage.take(), 3);
    }

    #[test]
    fn does_not_double_count_a_streamed_message_replayed_in_full() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&stream(message_start()));
        usage.observe(&text_delta("one two three"));
        usage.observe(&assistant(vec![RuntimeContentBlock::Text {
            text: "one two three".into(),
        }]));
        assert_eq!(usage.take(), 3);
    }

    #[test]
    fn a_new_message_cycle_re_enables_full_message_counting() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&text_delta("streamed words here"));
        usage.observe(&stream(message_start()));
        usage.observe(&assistant(vec![RuntimeContentBlock::Text {
            text: "and four more words".into(),
        }]));
        assert_eq!(usage.take(), 7);
    }

    #[test]
    fn does_not_fuse_words_across_two_blocks_of_one_message() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&assistant(vec![
            RuntimeContentBlock::Thinking {
                thinking: "planning".into(),
            },
            RuntimeContentBlock::Text {
                text: "answer".into(),
            },
        ]));
        assert_eq!(usage.take(), 2);
    }

    #[test]
    fn does_not_fuse_words_across_two_streamed_blocks() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&text_delta("first"));
        usage.observe(&stream(RuntimeStreamEvent::ContentBlockStop { index: 0 }));
        usage.observe(&text_delta("second"));
        assert_eq!(usage.take(), 2);
    }

    #[test]
    fn a_subagent_stream_does_not_suppress_the_root_agents_full_message() {
        let mut usage = TurnWordUsage::default();
        // A subagent streams while the root agent is mid-turn...
        usage.observe(&stream_from(Some("toolu_1"), message_start()));
        usage.observe(&stream_from(
            Some("toolu_1"),
            RuntimeStreamEvent::ContentBlockDelta {
                index: 0,
                delta: RuntimeContentDelta::Text {
                    text: "sub agent output".into(),
                },
            },
        ));
        // ...and the root agent then delivers a whole (never-streamed) message.
        usage.observe(&assistant(vec![RuntimeContentBlock::Text {
            text: "root agent answer here".into(),
        }]));

        assert_eq!(usage.take(), 7, "both streams must be counted in full");
    }

    #[test]
    fn a_subagents_own_streamed_message_is_still_deduplicated() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&stream_from(Some("toolu_1"), message_start()));
        usage.observe(&stream_from(
            Some("toolu_1"),
            RuntimeStreamEvent::ContentBlockDelta {
                index: 0,
                delta: RuntimeContentDelta::Text {
                    text: "one two three".into(),
                },
            },
        ));
        usage.observe(&assistant_from(
            Some("toolu_1"),
            vec![RuntimeContentBlock::Text {
                text: "one two three".into(),
            }],
        ));

        assert_eq!(usage.take(), 3, "the replay is the same stream's own text");
    }

    #[test]
    fn interleaved_streams_do_not_fuse_words_together() {
        let mut usage = TurnWordUsage::default();
        // "fo" and "x" belong to the root agent's block 0; the subagent delta
        // lands between them and must not join onto either.
        usage.observe(&text_delta("fo"));
        usage.observe(&stream_from(
            Some("toolu_1"),
            RuntimeStreamEvent::ContentBlockDelta {
                index: 0,
                delta: RuntimeContentDelta::Text { text: "bar".into() },
            },
        ));
        usage.observe(&text_delta("x"));

        assert_eq!(usage.take(), 2, "\"fox\" and \"bar\"");
    }

    #[test]
    fn concurrent_blocks_of_one_message_keep_separate_word_carries() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&stream(message_start()));
        usage.observe(&text_delta("he"));
        usage.observe(&stream(RuntimeStreamEvent::ContentBlockDelta {
            index: 1,
            delta: RuntimeContentDelta::Thinking {
                thinking: "pon".into(),
            },
        }));
        usage.observe(&text_delta("llo"));
        usage.observe(&stream(RuntimeStreamEvent::ContentBlockDelta {
            index: 1,
            delta: RuntimeContentDelta::Thinking {
                thinking: "der".into(),
            },
        }));

        assert_eq!(usage.take(), 2, "\"hello\" and \"ponder\"");
    }

    #[test]
    fn a_reused_block_index_after_stop_starts_a_fresh_word() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&text_delta("fo"));
        usage.observe(&stream(RuntimeStreamEvent::ContentBlockStop { index: 0 }));
        usage.observe(&text_delta("x"));

        assert_eq!(usage.take(), 2);
    }

    #[test]
    fn a_new_cycle_clears_the_previous_cycles_open_blocks() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&text_delta("fo"));
        usage.observe(&stream(message_start()));
        usage.observe(&text_delta("x"));

        assert_eq!(usage.take(), 2, "a new message cannot continue an old word");
    }

    #[test]
    fn take_resets_every_stream() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&text_delta("root words"));
        usage.observe(&stream_from(
            Some("toolu_1"),
            RuntimeStreamEvent::ContentBlockDelta {
                index: 0,
                delta: RuntimeContentDelta::Text {
                    text: "sub words".into(),
                },
            },
        ));
        assert_eq!(usage.take(), 4);
        assert_eq!(usage.take(), 0);
    }

    #[test]
    fn take_resets_the_accumulator() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&text_delta("one two"));
        assert_eq!(usage.take(), 2);
        assert_eq!(usage.take(), 0);
    }
}
