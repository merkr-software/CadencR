//! Per-source streaming-block synthesizer used by the OpenCode ACP
//! sub-agent listener.
//!
//! Originally shared by both the removed long-lived transport (cumulative-message polling) and the ACP sub-agent listener. With the long-lived transport gone,
//! the only consumer is `acp/upstream_workaround/subagent_listener.rs`,
//! which polls each child session's full message list and feeds every
//! `MessagePart` through `ingest_part` to emit just the new
//! `ContentBlockStart` / `ContentBlockDelta` events.

mod part_blocks;

use std::collections::{BTreeSet, HashMap};

use crate::domain::agents::adapter::{RuntimeContentDelta, RuntimeEvent};

use self::part_blocks::{
    delta_is_empty, empty_runtime_block_for_part, part_block_from_message_part, PartBlock,
};
use crate::domain::agents::acp::runtime::stream_events::{stream_delta_event, stream_start_event};

pub struct StreamSynthesizer {
    next_index: u64,
    part_index: HashMap<String, u64>,
    part_text: HashMap<String, String>,
    part_blocks: HashMap<String, PartBlock>,
    open_indices: BTreeSet<u64>,
}

impl StreamSynthesizer {
    pub fn new(_model: Option<String>) -> Self {
        Self {
            next_index: 0,
            part_index: HashMap::new(),
            part_text: HashMap::new(),
            part_blocks: HashMap::new(),
            open_indices: BTreeSet::new(),
        }
    }

    pub fn assign_index(&mut self, part_id: &str) -> u64 {
        if let Some(index) = self.part_index.get(part_id) {
            return *index;
        }
        let index = self.next_index;
        self.next_index += 1;
        self.part_index.insert(part_id.to_string(), index);
        index
    }

    pub fn ensure_index(&mut self, part_id: &str) -> (u64, bool) {
        if let Some(index) = self.part_index.get(part_id) {
            return (*index, false);
        }
        (self.assign_index(part_id), true)
    }

    pub fn mark_open(&mut self, index: u64) {
        self.open_indices.insert(index);
    }

    pub fn compute_delta(&mut self, part_id: &str, text: &str) -> String {
        let previous = self.part_text.get(part_id).cloned().unwrap_or_default();
        let delta = if text.starts_with(&previous) {
            text[previous.len()..].to_string()
        } else {
            text.to_string()
        };
        self.part_text.insert(part_id.to_string(), text.to_string());
        delta
    }

    pub fn ingest_part(
        &mut self,
        session_id: &str,
        part: &opencode_sdk_rs::MessagePart,
        parent_tool_use_id: Option<&str>,
    ) -> Vec<RuntimeEvent> {
        let part_id = match part {
            opencode_sdk_rs::MessagePart::Text { id, .. }
            | opencode_sdk_rs::MessagePart::Thinking { id, .. }
            | opencode_sdk_rs::MessagePart::ToolUse { id, .. }
            | opencode_sdk_rs::MessagePart::ToolResult { id, .. } => id.as_str(),
            opencode_sdk_rs::MessagePart::StepFinish { .. } => return Vec::new(),
            opencode_sdk_rs::MessagePart::Other(_) => return Vec::new(),
        };
        if part_id.is_empty() {
            return Vec::new();
        }

        let (index, is_new) = self.ensure_index(part_id);
        let mut output = Vec::new();

        if is_new {
            self.part_blocks
                .insert(part_id.to_string(), part_block_from_message_part(part));
            self.mark_open(index);
            output.push(stream_start_event(
                session_id,
                index,
                empty_runtime_block_for_part(part),
                parent_tool_use_id,
            ));
        }

        let Some(delta) = self.part_delta(part_id, part) else {
            return output;
        };
        if delta_is_empty(&delta) {
            return output;
        }

        if !is_new {
            self.mark_open(index);
        }
        output.push(stream_delta_event(
            session_id,
            index,
            delta,
            parent_tool_use_id,
        ));
        output
    }

    /// The client appends input deltas, so only an extension of what it holds
    /// can go out. A pending tool's empty `{}` is held back: the real input
    /// that follows is not an extension of it, and `{}{…}` would leave the
    /// tool unreadable until it ends. A rewritten input waits for the end too.
    fn input_delta(&mut self, part_id: &str, input: &serde_json::Value) -> Option<String> {
        if input.is_null() || input.as_object().is_some_and(serde_json::Map::is_empty) {
            return None;
        }
        let as_json = serde_json::to_string(input).unwrap_or_default();
        let previous = self
            .part_text
            .get(part_id)
            .map(String::as_str)
            .unwrap_or("");
        if !as_json.starts_with(previous) {
            return None;
        }
        Some(self.compute_delta(part_id, &as_json))
    }

    fn part_delta(
        &mut self,
        part_id: &str,
        part: &opencode_sdk_rs::MessagePart,
    ) -> Option<RuntimeContentDelta> {
        match part {
            opencode_sdk_rs::MessagePart::Text { text, .. } => {
                let delta = self.compute_delta(part_id, text);
                Some(RuntimeContentDelta::Text { text: delta })
            }
            opencode_sdk_rs::MessagePart::Thinking { thinking, .. } => {
                let delta = self.compute_delta(part_id, thinking);
                Some(RuntimeContentDelta::Thinking { thinking: delta })
            }
            opencode_sdk_rs::MessagePart::ToolUse { input, .. } => self
                .input_delta(part_id, input)
                .map(|partial_json| RuntimeContentDelta::InputJson { partial_json }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StreamSynthesizer;
    use crate::domain::agents::adapter::RuntimeStreamEvent;
    use serde_json::json;

    #[test]
    fn synthesizer_delta_handles_cumulative_updates() {
        let mut synth = StreamSynthesizer::new(None);
        let first = synth.compute_delta("part-1", "hello");
        let second = synth.compute_delta("part-1", "hello world");
        assert_eq!(first, "hello");
        assert_eq!(second, " world");
    }

    #[test]
    fn ingest_part_emits_start_and_delta_for_first_updated_text_part() {
        let mut synth = StreamSynthesizer::new(None);
        let events = synth.ingest_part(
            "ses_1",
            &opencode_sdk_rs::MessagePart::Text {
                id: "part_1".to_string(),
                text: "hello".to_string(),
            },
            None,
        );

        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart { .. })
        ));
        assert!(matches!(
            events[1].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockDelta {
                delta: crate::domain::agents::adapter::RuntimeContentDelta::Text { text },
                ..
            }) if text == "hello"
        ));
    }

    /// What the client holds for a tool: the concatenated input deltas.
    fn streamed_input(events: &[crate::domain::agents::adapter::RuntimeEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event.stream_event() {
                Some(RuntimeStreamEvent::ContentBlockDelta {
                    delta:
                        crate::domain::agents::adapter::RuntimeContentDelta::InputJson { partial_json },
                    ..
                }) => Some(partial_json.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_pending_tool_streams_its_input_once_it_has_one() {
        let mut synth = StreamSynthesizer::new(None);
        let mut events = Vec::new();
        for input in [json!({}), json!({ "command": "sleep 8 && cat README.md" })] {
            events.extend(synth.ingest_part(
                "ses_child",
                &opencode_sdk_rs::MessagePart::ToolUse {
                    id: "part_1".to_string(),
                    tool_id: "call_1".to_string(),
                    name: "Bash".to_string(),
                    input,
                },
                Some("task_1"),
            ));
        }
        let held: serde_json::Value = serde_json::from_str(&streamed_input(&events)).unwrap();
        assert_eq!(held["command"], "sleep 8 && cat README.md");
    }

    #[test]
    fn a_rewritten_input_is_not_appended_to_the_streamed_one() {
        let mut synth = StreamSynthesizer::new(None);
        let _ = synth.ingest_part(
            "ses_1",
            &opencode_sdk_rs::MessagePart::ToolUse {
                id: "part_1".to_string(),
                tool_id: "call_1".to_string(),
                name: "Bash".to_string(),
                input: json!({ "command": "ls" }),
            },
            None,
        );

        let events = synth.ingest_part(
            "ses_1",
            &opencode_sdk_rs::MessagePart::ToolUse {
                id: "part_1".to_string(),
                tool_id: "call_1".to_string(),
                name: "Bash".to_string(),
                input: json!({ "command": "ls -la" }),
            },
            None,
        );

        assert!(streamed_input(&events).is_empty());
    }

    #[test]
    fn child_stream_events_preserve_parent_tool_use_id() {
        let mut synth = StreamSynthesizer::new(None);
        let events = synth.ingest_part(
            "ses_child",
            &opencode_sdk_rs::MessagePart::ToolUse {
                id: "part_1".to_string(),
                tool_id: "call_1".to_string(),
                name: "Read".to_string(),
                input: json!({ "file_path": "src/main.ts" }),
            },
            Some("task_1"),
        );

        assert!(events
            .iter()
            .all(|event| event.parent_tool_use_id() == Some("task_1")));
    }
}
