//! Authoritative Codex sub-agent spawn activities.
//!
//! A resumed thread may not emit experimental raw response items. In that
//! case `subAgentActivity` is the only spawn event: its item id is the
//! `spawn_agent` call id and its `agentThreadId` identifies the child stream.

use serde_json::Value;

use super::event_json::runtime_stream_event;
use super::event_payloads::CodexItem;
use super::event_state::IndexState;
use super::event_subagents::agent_tool_block;
use crate::domain::agents::adapter::{RuntimeEvent, RuntimeStreamEvent};

pub(super) fn subagent_activity_events(
    parent_thread_id: Option<&str>,
    item: &CodexItem,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    if item.fields.get("kind").and_then(Value::as_str) != Some("started") {
        return Vec::new();
    }
    let Some(parent_thread_id) = required(parent_thread_id, "threadId") else {
        return Vec::new();
    };
    let Some(activity_id) = required(item.id.as_deref(), "item.id") else {
        return Vec::new();
    };
    let Some(child_thread_id) = required(item.agent_thread_id.as_deref(), "agentThreadId") else {
        return Vec::new();
    };

    // This direct id-to-id join works both with and without the raw spawn
    // event. If rawResponseItem arrived first, `has_index` deduplicates the
    // Agent block while the child route is still refreshed authoritatively.
    let parent_tool_use_id = index_state.canonical_id(activity_id);
    index_state.record_subagent_thread(child_thread_id, &parent_tool_use_id);
    if index_state.has_index(&parent_tool_use_id) {
        return Vec::new();
    }

    let block = agent_tool_block(&parent_tool_use_id, &item.as_value());
    let event = RuntimeStreamEvent::ContentBlockStart {
        index: index_state.index_for(&parent_tool_use_id),
        block,
    };
    vec![runtime_stream_event(parent_thread_id, event)]
}

fn required<'a>(value: Option<&'a str>, field: &str) -> Option<&'a str> {
    let value = value.filter(|value| !value.is_empty());
    if value.is_none() {
        tracing::warn!(field, "malformed Codex subAgentActivity event");
    }
    value
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::event_state::IndexState;
    use super::super::events::notification_events;

    #[test]
    fn resumed_thread_activity_creates_parent_and_routes_without_raw_events() {
        let mut indexes = IndexState::default();
        indexes.should_reset_for_turn_started("thread_root");

        let activity = notification_events(
            "item/started",
            json!({
                "threadId": "thread_root",
                "turnId": "root_turn",
                "item": {
                    "type": "subAgentActivity",
                    "id": "call_spawn",
                    "kind": "started",
                    "agentPath": "/root/quality_review",
                    "agentThreadId": "thread_child"
                }
            }),
            None,
            &mut indexes,
        );

        let block = activity[0].stream_event().expect("Agent block");
        let crate::domain::agents::adapter::RuntimeStreamEvent::ContentBlockStart { block, .. } =
            block
        else {
            panic!("expected content block start");
        };
        let crate::domain::agents::adapter::RuntimeContentBlock::ToolUse { id, name, .. } = block
        else {
            panic!("expected tool use");
        };
        assert_eq!(id, "call_spawn");
        assert_eq!(name, "Agent");

        let child = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_child",
                "itemId": "child_message",
                "delta": "reviewing"
            }),
            None,
            &mut indexes,
        );
        assert_eq!(child[0].parent_tool_use_id(), Some("call_spawn"));
    }

    #[test]
    fn activity_uses_raw_spawn_canonical_call_id() {
        let mut indexes = IndexState::default();
        indexes.should_reset_for_turn_started("thread_root");
        notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call",
                    "id": "raw_spawn_item",
                    "call_id": "call_spawn",
                    "name": "spawn_agent",
                    "arguments": "{}"
                }
            }),
            None,
            &mut indexes,
        );

        let activity = notification_events(
            "item/started",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "subAgentActivity",
                    "id": "raw_spawn_item",
                    "kind": "started",
                    "agentPath": "/root/quality_review",
                    "agentThreadId": "thread_child"
                }
            }),
            None,
            &mut indexes,
        );
        assert!(
            activity.is_empty(),
            "raw spawn already emitted the Agent block"
        );

        let child = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_child",
                "itemId": "child_message",
                "delta": "reviewing"
            }),
            None,
            &mut indexes,
        );
        assert_eq!(child[0].parent_tool_use_id(), Some("call_spawn"));
    }
}
