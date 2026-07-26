use crate::domain::agents::adapter::{RuntimeContentDelta, RuntimeEvent, RuntimeStreamEvent};

mod counter;
mod streams;

use counter::block_text;
pub use counter::count_words;
use streams::TurnStreams;

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
    streams: TurnStreams,
}

impl TurnWordUsage {
    pub fn observe(&mut self, event: &RuntimeEvent) {
        let stream = event.parent_tool_use_id();

        if let Some(stream_event) = event.stream_event() {
            self.observe_stream_event(stream, stream_event);
            return;
        }
        let Some(message) = event.assistant_message() else {
            return;
        };
        if self.streams.get_mut(stream).streamed_this_cycle() {
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

    fn observe_stream_event(&mut self, stream: Option<&str>, event: &RuntimeStreamEvent) {
        match event {
            RuntimeStreamEvent::MessageStart { .. } => self.streams.get_mut(stream).start_cycle(),
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
            RuntimeStreamEvent::ContentBlockStop { index } => {
                self.streams.get_mut(stream).close_block(*index)
            }
            RuntimeStreamEvent::Other => {}
        }
    }

    fn push_streamed(&mut self, stream: Option<&str>, index: u64, text: &str) {
        if text.is_empty() {
            return;
        }
        self.words += self.streams.get_mut(stream).push_streamed(index, text);
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

    /// Drain the words counted so far *without* ending the turn.
    ///
    /// Unlike [`take`](Self::take) this keeps the per-stream bookkeeping, so a
    /// cycle that already streamed still suppresses the full message that
    /// replays it and an open block keeps its mid-word carry. That is what
    /// makes it safe to bank a long turn's words while it is still running,
    /// instead of holding all of them until the turn ends — and losing them if
    /// the process is stopped mid-turn.
    pub fn drain(&mut self) -> u64 {
        std::mem::take(&mut self.words)
    }

    /// Words counted since the last [`take`](Self::take). Lets the caller
    /// notice the moment a batch starts, which is when it must capture what the
    /// words will be attributed to.
    pub fn pending(&self) -> u64 {
        self.words
    }
}

#[cfg(test)]
mod tests {
    use super::TurnWordUsage;
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
    fn banking_a_running_turn_still_suppresses_the_replayed_full_message() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&stream(message_start()));
        usage.observe(&text_delta("one two three"));

        // The turn is still streaming: the words are banked, the dedup state is
        // not — otherwise the full message below would be counted twice.
        assert_eq!(usage.drain(), 3);

        usage.observe(&assistant(vec![RuntimeContentBlock::Text {
            text: "one two three".into(),
        }]));
        assert_eq!(usage.take(), 0);
    }

    #[test]
    fn banking_mid_block_does_not_split_a_word_in_two() {
        let mut usage = TurnWordUsage::default();
        usage.observe(&text_delta("half"));

        assert_eq!(usage.drain(), 1, "the word is counted when it starts");

        usage.observe(&text_delta("way there"));
        assert_eq!(usage.take(), 1, "'halfway' is not counted a second time");
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
