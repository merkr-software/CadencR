use serde_json::Value;

use super::super::event_json::{metadata, runtime_stream_event, thread_id};
use super::super::event_state::IndexState;
use crate::domain::agents::adapter::{
    RuntimeContentDelta, RuntimeEvent, RuntimeEventKind, RuntimeStreamEvent,
};

pub(super) fn turn_started_event(params: Value, model: Option<&str>) -> Option<RuntimeEvent> {
    Some(RuntimeEvent::new(
        metadata(
            thread_id(&params),
            serde_json::json!({
                "type": "stream_event",
                "session_id": thread_id(&params),
                "event": { "type": "message_start", "message": { "model": model } }
            }),
        ),
        RuntimeEventKind::StreamEvent {
            event: RuntimeStreamEvent::MessageStart {
                model: model.map(ToOwned::to_owned),
                input_tokens: None,
            },
            parent_tool_use_id: None,
        },
    ))
}

pub(super) fn result_event(params: Value) -> RuntimeEvent {
    RuntimeEvent::new(
        metadata(
            thread_id(&params),
            serde_json::json!({ "type": "result", "session_id": thread_id(&params) }),
        ),
        RuntimeEventKind::Result,
    )
}

pub(super) fn text_delta_event(
    params: Value,
    _model: Option<&str>,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let text = params
        .get("delta")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let index = params
        .get("itemId")
        .and_then(Value::as_str)
        .map(|item_id| index_state.index_for(item_id))
        .unwrap_or(0);
    let event = RuntimeStreamEvent::ContentBlockDelta {
        index,
        delta: RuntimeContentDelta::Text { text },
    };
    let sid = thread_id(&params).to_string();
    vec![runtime_stream_event(&sid, event)]
}

#[cfg(test)]
mod tests {
    use super::super::super::event_state::IndexState;
    use super::super::notification_events;
    use crate::domain::agents::adapter::RuntimeStreamEvent;
    use serde_json::json;

    #[test]
    fn agent_message_start_and_delta_share_content_index() {
        let mut indexes = IndexState::default();
        let started = notification_events(
            "item/started",
            json!({
                "threadId": "thread",
                "item": { "type": "agentMessage", "id": "msg_1" }
            }),
            None,
            &mut indexes,
        );
        let delta = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread",
                "itemId": "msg_1",
                "delta": "hello"
            }),
            None,
            &mut indexes,
        );

        let start_index = match started[0].stream_event() {
            Some(RuntimeStreamEvent::ContentBlockStart { index, .. }) => *index,
            other => panic!("expected content start, got {other:?}"),
        };
        let delta_index = match delta[0].stream_event() {
            Some(RuntimeStreamEvent::ContentBlockDelta { index, .. }) => *index,
            other => panic!("expected content delta, got {other:?}"),
        };
        assert_eq!(start_index, delta_index);
    }
}
