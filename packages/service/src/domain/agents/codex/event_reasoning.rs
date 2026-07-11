use serde_json::Value;

use super::event_json::{runtime_stream_event, thread_id};
use super::event_state::IndexState;
use crate::domain::agents::adapter::{
    RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent, RuntimeStreamEvent,
};

pub(super) fn reasoning_delta_event(
    params: Value,
    _model: Option<&str>,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
    let cleaned = index_state.reasoning_delta_without_marker(item_id, delta);
    if cleaned.is_empty() {
        return Vec::new();
    }
    let session_id = thread_id(&params);
    let event = if index_state.has_index(item_id) {
        RuntimeStreamEvent::ContentBlockDelta {
            index: index_state.index_for(item_id),
            delta: RuntimeContentDelta::Thinking { thinking: cleaned },
        }
    } else {
        RuntimeStreamEvent::ContentBlockStart {
            index: index_state.index_for(item_id),
            block: RuntimeContentBlock::Thinking { thinking: cleaned },
        }
    };
    vec![runtime_stream_event(session_id, event)]
}

pub(super) fn reasoning_item_event(
    params: Value,
    completed: bool,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    if !completed {
        return Vec::new();
    }
    let Some(item_id) = params
        .get("item")
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
    else {
        return Vec::new();
    };
    let pending = index_state.take_reasoning_pending(item_id);
    let block_started = index_state.has_index(item_id);
    if !block_started && pending.is_none() {
        return Vec::new();
    }
    let session_id = thread_id(&params);
    let index = index_state.index_for(item_id);
    let mut events = Vec::with_capacity(2);
    if let Some(thinking) = pending {
        let event = if block_started {
            RuntimeStreamEvent::ContentBlockDelta {
                index,
                delta: RuntimeContentDelta::Thinking { thinking },
            }
        } else {
            RuntimeStreamEvent::ContentBlockStart {
                index,
                block: RuntimeContentBlock::Thinking { thinking },
            }
        };
        events.push(runtime_stream_event(session_id, event));
    }
    events.push(runtime_stream_event(
        session_id,
        RuntimeStreamEvent::ContentBlockStop { index },
    ));
    events
}

#[cfg(test)]
mod tests {
    use super::super::event_state::IndexState;
    use super::super::events::notification_events;
    use crate::domain::agents::adapter::{
        RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent, RuntimeStreamEvent,
    };
    use serde_json::json;

    fn thinking_content(events: &[RuntimeEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event.stream_event() {
                Some(RuntimeStreamEvent::ContentBlockStart {
                    block: RuntimeContentBlock::Thinking { thinking },
                    ..
                })
                | Some(RuntimeStreamEvent::ContentBlockDelta {
                    delta: RuntimeContentDelta::Thinking { thinking },
                    ..
                }) => Some(thinking.as_str()),
                _ => None,
            })
            .collect()
    }

    fn delta(method: &str, text: &str, indexes: &mut IndexState) -> Vec<RuntimeEvent> {
        notification_events(
            method,
            json!({
                "threadId": "thread",
                "itemId": "reasoning_1",
                "delta": text
            }),
            None,
            indexes,
        )
    }

    fn summary_delta(
        summary_index: u64,
        text: &str,
        indexes: &mut IndexState,
    ) -> Vec<RuntimeEvent> {
        notification_events(
            "item/reasoning/summaryTextDelta",
            json!({
                "threadId": "thread",
                "itemId": "reasoning_1",
                "summaryIndex": summary_index,
                "delta": text
            }),
            None,
            indexes,
        )
    }

    fn complete(indexes: &mut IndexState) -> Vec<RuntimeEvent> {
        notification_events(
            "item/completed",
            json!({
                "threadId": "thread",
                "item": { "type": "reasoning", "id": "reasoning_1" }
            }),
            None,
            indexes,
        )
    }

    #[test]
    fn summary_delta_starts_clean_thinking_block() {
        let mut indexes = IndexState::default();
        let events = summary_delta(0, "**Planning**\n\n<!-- -->", &mut indexes);

        assert_eq!(thinking_content(&events), "**Planning**\n\n");
        assert!(matches!(
            events[0].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart { .. })
        ));
    }

    #[test]
    fn multiple_summary_parts_preserve_paragraphs_in_order() {
        let mut indexes = IndexState::default();
        let mut events = summary_delta(
            0,
            "**Comparing event paths**\n\nFirst detail.",
            &mut indexes,
        );
        events.extend(summary_delta(
            1,
            "\n\n**Checking persistence**\n\nSecond detail.",
            &mut indexes,
        ));

        assert_eq!(
            thinking_content(&events),
            "**Comparing event paths**\n\nFirst detail.\n\n\
             **Checking persistence**\n\nSecond detail."
        );
    }

    #[test]
    fn marker_only_delta_does_not_start_thinking_block() {
        let mut indexes = IndexState::default();
        assert!(delta("item/reasoning/textDelta", "<!-- -->", &mut indexes).is_empty());
        assert!(complete(&mut indexes).is_empty());
    }

    #[test]
    fn item_start_does_not_emit_empty_thinking_block() {
        let mut indexes = IndexState::default();
        let events = notification_events(
            "item/started",
            json!({
                "threadId": "thread",
                "item": { "type": "reasoning", "id": "reasoning_1" }
            }),
            None,
            &mut indexes,
        );
        assert!(events.is_empty());
    }

    #[test]
    fn later_text_is_emitted_as_delta_for_started_block() {
        let mut indexes = IndexState::default();
        let first = delta("item/reasoning/textDelta", "first", &mut indexes);
        let second = delta("item/reasoning/textDelta", " second", &mut indexes);

        assert!(matches!(
            first[0].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart { .. })
        ));
        assert!(matches!(
            second[0].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockDelta { .. })
        ));
        assert_eq!(thinking_content(&[first, second].concat()), "first second");
    }

    #[test]
    fn marker_is_cleaned_at_every_split_boundary() {
        const MARKER: &str = "<!-- -->";
        for split in 1..MARKER.len() {
            let mut indexes = IndexState::default();
            let mut events = delta(
                "item/reasoning/textDelta",
                &format!("summary\n\n{}", &MARKER[..split]),
                &mut indexes,
            );
            events.extend(delta(
                "item/reasoning/textDelta",
                &MARKER[split..],
                &mut indexes,
            ));
            assert_eq!(thinking_content(&events), "summary\n\n", "split {split}");
        }
    }

    #[test]
    fn whitespace_only_chunks_are_preserved() {
        let mut indexes = IndexState::default();
        let events = delta("item/reasoning/textDelta", "\n\n", &mut indexes);
        assert_eq!(thinking_content(&events), "\n\n");
    }

    #[test]
    fn completion_flushes_unmatched_marker_prefix_before_stop() {
        let mut indexes = IndexState::default();
        let mut events = delta(
            "item/reasoning/textDelta",
            "comparison ends with <",
            &mut indexes,
        );
        events.extend(complete(&mut indexes));

        assert_eq!(thinking_content(&events), "comparison ends with <");
        assert!(matches!(
            events.last().and_then(RuntimeEvent::stream_event),
            Some(RuntimeStreamEvent::ContentBlockStop { .. })
        ));
    }
}
