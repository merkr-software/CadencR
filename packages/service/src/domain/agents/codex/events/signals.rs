use serde_json::Value;

use super::super::event_json::{metadata, runtime_stream_event, thread_id};
use super::super::event_state::IndexState;
use crate::domain::agents::adapter::{
    RuntimeContentDelta, RuntimeEvent, RuntimeEventKind, RuntimeResultError, RuntimeStreamEvent,
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

/// The model Codex rerouted a turn to (`model/rerouted`), e.g. when a request
/// is moved off the model the turn started on.
pub(in super::super) fn rerouted_model(params: &Value) -> Option<&str> {
    params
        .get("toModel")
        .or_else(|| params.get("to_model"))
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
}

/// A reroute starts the turn's next message on the model Codex reports.
pub(super) fn model_rerouted_event(params: Value) -> Option<RuntimeEvent> {
    let model = rerouted_model(&params)?.to_string();
    turn_started_event(params, Some(&model))
}

pub(super) fn result_event(params: Value) -> RuntimeEvent {
    let error = params.get("turn").and_then(|turn| {
        let error = turn.get("error").filter(|error| !error.is_null());
        if error.is_none() && turn.get("status").and_then(Value::as_str) != Some("failed") {
            return None;
        }
        Some(RuntimeResultError {
            code: "CODEX_TURN_FAILED".to_string(),
            message: error
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .filter(|message| !message.is_empty())
                .unwrap_or("Codex turn failed without error details")
                .to_string(),
        })
    });
    RuntimeEvent::new(
        metadata(
            thread_id(&params),
            serde_json::json!({ "type": "result", "session_id": thread_id(&params) }),
        ),
        RuntimeEventKind::Result,
    )
    .with_result_error(error)
}

pub(super) fn child_error_event(params: Value, parent: &str) -> Option<RuntimeEvent> {
    let sid = thread_id(&params).to_string();
    let result = result_event(params);
    let error = result.result_error()?;
    Some(RuntimeEvent::new(
        metadata(
            &sid,
            serde_json::json!({"type":"error", "message":error.message, "parent_tool_use_id":parent}),
        ),
        RuntimeEventKind::ProviderError {
            message: error.message.clone(),
            code: Some(error.code.clone()),
            parent_tool_use_id: Some(parent.to_string()),
        },
    ))
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
    #[test]
    fn failed_turn_preserves_error_and_legacy_success_stays_successful() {
        use super::result_event;
        for params in [
            json!({}),
            json!({"turn":{"status":"completed","error":null}}),
            json!({"turn":{"status":"interrupted"}}),
        ] {
            assert!(result_event(params).result_error().is_none());
        }
        let error = result_event(
            json!({"turn":{"status":"failed","error":{"message":"Selected model is at capacity"}}}),
        );
        assert_eq!(
            error.result_error().unwrap().message,
            "Selected model is at capacity"
        );
        assert!(result_event(json!({"turn":{"status":"failed"}}))
            .result_error()
            .is_some());
    }
    #[test]
    fn child_failure_is_nested_and_never_a_root_result() {
        let error = super::child_error_event(
            json!({"threadId":"child","turn":{"status":"failed","error":{"message":"capacity"}}}),
            "spawn",
        )
        .unwrap();
        assert!(!error.is_result());
        assert_eq!(error.parent_tool_use_id(), Some("spawn"));
        assert_eq!(error.provider_error().unwrap().message, "capacity");
    }

    #[test]
    fn a_reroute_starts_the_next_message_on_the_reported_model() {
        let mut indexes = IndexState::default();
        let events = notification_events(
            "model/rerouted",
            json!({ "threadId": "thread", "fromModel": "gpt-5.5", "toModel": "gpt-5.5-mini" }),
            Some("gpt-5.5"),
            &mut indexes,
        );
        assert!(matches!(
            events[0].stream_event(),
            Some(RuntimeStreamEvent::MessageStart { model: Some(model), .. }) if model == "gpt-5.5-mini"
        ));
        let malformed = notification_events(
            "model/rerouted",
            json!({ "threadId": "thread" }),
            None,
            &mut indexes,
        );
        assert!(malformed.is_empty());
    }
}
