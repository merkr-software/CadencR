mod classification;
mod mapping;
mod token_usage;

use serde_json::Value;

use crate::domain::agents::adapter::{RuntimeEvent, RuntimeEventMetadata, RuntimeUsage};
use classification::classify_message;
pub(super) use mapping::{
    context_window_for_model_from_raw, init_model_context_window, model_usage_windows,
};
use token_usage::claude_token_usage;

pub(super) fn normalize_event(msg: claude_agent_sdk_rs::SdkMessage) -> RuntimeEvent {
    let background_agent = super::background_agents::background_agent_signal(&msg);
    let token_usage = claude_token_usage(&msg);
    let provider_message_id = match &msg {
        claude_agent_sdk_rs::SdkMessage::Assistant { message, .. } => Some(message.id.clone()),
        _ => None,
    };
    let raw = serde_json::to_value(&msg).unwrap_or(Value::Null);
    let metadata = RuntimeEventMetadata {
        session_id: msg.session_id().map(ToOwned::to_owned),
        usage: msg.usage().map(|usage| RuntimeUsage {
            input_tokens: usage.total_input_tokens(),
            output_tokens: usage.output_tokens,
        }),
        context_window: msg.result_context_window(),
        raw,
    };

    let (kind, result_error) = classify_message(msg);

    RuntimeEvent::new(metadata, kind)
        .with_background_agent(background_agent)
        .with_result_error(result_error)
        .with_token_usage(token_usage)
        .with_provider_message_id(provider_message_id)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::normalize_event;
    use crate::domain::agents::adapter::{RuntimeContentDelta, RuntimeStreamEvent};

    #[test]
    fn normalize_event_maps_stream_text_delta() {
        let message: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "stream_event",
            "uuid": "u1",
            "session_id": "s1",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": "hello" }
            }
        }))
        .expect("valid stream event");

        let event = normalize_event(message);
        match event.stream_event() {
            Some(RuntimeStreamEvent::ContentBlockDelta {
                index,
                delta: RuntimeContentDelta::Text { text },
            }) => {
                assert_eq!(*index, 0);
                assert_eq!(text, "hello");
            }
            other => panic!("unexpected stream mapping: {other:?}"),
        }
    }

    #[test]
    fn normalize_event_exposes_typed_assistant_message_identity() {
        let message: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "assistant",
            "uuid": "event-1",
            "session_id": "session-1",
            "parent_tool_use_id": null,
            "message": {
                "id": "assistant-1",
                "content": [],
                "model": "claude-opus",
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 10, "output_tokens": 2 }
            }
        }))
        .unwrap();

        assert_eq!(
            normalize_event(message).provider_message_id(),
            Some("assistant-1")
        );
    }

    #[test]
    fn normalize_event_preserves_raw_for_an_unrecognized_message_type() {
        // A `type` the SDK has never seen falls back to `SdkMessage::Unknown`.
        // The adapter must keep the raw payload (via `RuntimeEventKind::Unknown`)
        // so the stream reader can surface it instead of dropping it silently.
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "some_future_message",
            "session_id": "s1",
            "detail": "important content"
        }))
        .expect("unknown types deserialize infallibly");
        assert!(matches!(msg, claude_agent_sdk_rs::SdkMessage::Unknown(_)));

        let event = normalize_event(msg);
        let raw = event
            .unknown_message()
            .expect("unrecognized message must surface its raw payload");
        assert_eq!(raw["type"], "some_future_message");
        assert_eq!(raw["detail"], "important content");
    }

    #[test]
    fn normalize_event_does_not_surface_unknown_system_messages_as_errors() {
        // The run-in-background agent protocol (issue #58) and any untyped
        // `system` subtype arrive as `SdkMessage::Unknown` by design. They are
        // operational metadata and must NOT become visible `UNKNOWN_MESSAGE`
        // errors — otherwise every background-agent run would spam the
        // conversation. They stay silent (`Other`) while still driving
        // background-agent tracking via the independently-derived signal.
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "system", "subtype": "task_started", "uuid": "u", "session_id": "s",
            "task_id": "task-abc", "task_type": "local_agent"
        }))
        .expect("unknown system subtype deserializes infallibly");
        assert!(matches!(msg, claude_agent_sdk_rs::SdkMessage::Unknown(_)));

        let event = normalize_event(msg);
        assert!(
            event.unknown_message().is_none(),
            "an unknown `system` message must not surface as a visible error"
        );
        assert!(
            event.background_agent_signal().is_some(),
            "the background-agent signal must still be derived from the raw message"
        );
    }

    #[test]
    fn normalize_event_surfaces_unknown_non_system_messages() {
        // The counterpart to the `system` carve-out above: a message whose
        // `type` the SDK models no schema for — and which is NOT operational
        // `system` metadata — must reach the conversation verbatim rather than
        // vanish. This is the whole point of the raw-preserving `Unknown`
        // fallback: the "stopped mid-message with no reason" class.
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "some_future_message_type", "session_id": "s", "payload": { "text": "hi" }
        }))
        .expect("unknown message deserializes infallibly");
        assert!(matches!(msg, claude_agent_sdk_rs::SdkMessage::Unknown(_)));

        let event = normalize_event(msg);
        let raw = event
            .unknown_message()
            .expect("an unknown non-system message must surface verbatim");
        assert_eq!(raw["type"], "some_future_message_type");
        assert_eq!(raw["payload"]["text"], "hi");
    }

    #[test]
    fn normalize_event_turns_compacting_status_into_manual_compact_start() {
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "system",
            "subtype": "status",
            "status": "compacting",
            "session_id": "s1",
            "uuid": "st1"
        }))
        .unwrap();
        let event = normalize_event(msg);
        assert_eq!(
            event.turn_started_source(),
            Some(crate::domain::agents::adapter::RuntimeTurnStartedSource::ManualCompact)
        );
        let raw = event.raw_json();
        assert_eq!(raw["type"], "system");
        assert_eq!(raw["subtype"], "status");
        assert_eq!(raw["status"], "compacting");
    }

    #[test]
    fn normalize_event_extracts_context_window_from_result() {
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "result",
            "subtype": "success",
            "uuid": "r",
            "session_id": "s",
            "duration_ms": 10,
            "duration_api_ms": 5,
            "is_error": false,
            "num_turns": 1,
            "result": "ok",
            "total_cost_usd": 0.0,
            "usage": { "input_tokens": 1, "output_tokens": 1 },
            "permission_denials": [],
            "modelUsage": {
                "claude-opus-4-7[1m]": {
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "cacheReadInputTokens": 30,
                    "cacheCreationInputTokens": 5,
                    "contextWindow": 1000000
                }
            }
        }))
        .unwrap();
        let event = normalize_event(msg);
        assert_eq!(event.context_window(), Some(1_000_000));
    }

    fn init_message(model: &str) -> claude_agent_sdk_rs::SdkMessage {
        serde_json::from_value(json!({
            "type": "system",
            "subtype": "init",
            "uuid": "u-init",
            "session_id": "s-init",
            "claude_code_version": "2.0.75",
            "cwd": "/tmp",
            "tools": [],
            "mcp_servers": [],
            "model": model,
            "permissionMode": "default",
            "slash_commands": [],
            "output_style": "default"
        }))
        .expect("valid init event")
    }

    #[test]
    fn normalize_event_resolves_1m_context_window_from_init_model() {
        // Regression: the usage bar divided by the session's stale 200k
        // default for the whole first turn of a 1M-context model, climbing
        // to 100% until the turn's Result corrected the window.
        let event = normalize_event(init_message("claude-fable-5[1m]"));
        let init = event.init().expect("init kind");
        assert_eq!(init.context_window, Some(1_000_000));
        assert_eq!(init.model.as_deref(), Some("claude-fable-5[1m]"));
    }

    #[test]
    fn normalize_event_resolves_1m_window_for_bedrock_vertex_style_id() {
        // Under Bedrock/Vertex the resolved id carries region/routing affixes,
        // so the `[1m]` marker is not at the end. The 1M beta is still 1M
        // tokens on every backend, so the hint must fire regardless of affix.
        let event = normalize_event(init_message("us.anthropic.claude-sonnet-4-5[1m]"));
        assert_eq!(
            event.init().expect("init kind").context_window,
            Some(1_000_000)
        );
    }

    #[test]
    fn normalize_event_resolves_1m_window_for_natively_1m_model_without_marker() {
        // The CLI reports `claude-fable-5` on init even when Cadencr passes
        // `claude-fable-5[1m]`, because 1M is Fable's default and there is no
        // beta to mark. Keying only off `[1m]` left every Fable turn with no
        // window at all, so the bar divided by whatever the session last
        // persisted (200k in the common case) and read ~5x too high until the
        // turn's Result landed.
        let event = normalize_event(init_message("claude-fable-5"));
        assert_eq!(
            event.init().expect("init kind").context_window,
            Some(1_000_000)
        );
    }

    #[test]
    fn normalize_event_leaves_context_window_unresolved_without_1m_marker() {
        // No guess for plain ids: a hardcoded 200k would override a window
        // learned from a previous turn's Result, and would be wrong for a
        // Bedrock-pinned or custom/proxy model. Defer to the CLI's Result.
        let event = normalize_event(init_message("us.anthropic.claude-sonnet-4-5"));
        assert_eq!(event.init().expect("init kind").context_window, None);
    }

    #[test]
    fn normalize_event_maps_api_error_assistant_to_provider_error() {
        // Regression: a 529 arrives as a synthetic assistant message
        // (`model: "<synthetic>"`, `isApiErrorMessage: true`). It used to be
        // dropped because the full-assistant-message path only reconciles
        // ToolUse blocks. It must now surface as a ProviderError carrying the
        // human-readable text and an HTTP-status-derived code.
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "assistant",
            "uuid": "u-err",
            "session_id": "s-err",
            "message": {
                "id": "syn",
                "model": "<synthetic>",
                "stop_reason": "stop_sequence",
                "content": [{ "type": "text", "text": "API Error: 529 Overloaded." }]
            },
            "error": "server_error",
            "isApiErrorMessage": true,
            "apiErrorStatus": 529
        }))
        .expect("valid api error assistant");

        let event = normalize_event(msg);
        let error = event.provider_error().expect("provider error kind");
        assert_eq!(error.message, "API Error: 529 Overloaded.");
        assert_eq!(error.code, Some("API_ERROR_529"));
        // It must NOT also look like a normal assistant message.
        assert!(event.assistant_message().is_none());
    }

    #[test]
    fn normalize_event_api_error_falls_back_to_error_category_when_no_text() {
        // When the CLI sends no text content, the surfaced message falls back
        // to the `error` category string so it's never empty.
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "assistant",
            "uuid": "u-err",
            "session_id": "s-err",
            "message": { "id": "syn", "model": "<synthetic>", "content": [] },
            "error": "server_error",
            "isApiErrorMessage": true
        }))
        .expect("valid api error assistant");

        let event = normalize_event(msg);
        let error = event.provider_error().expect("provider error kind");
        assert_eq!(error.message, "server_error");
        // No HTTP status -> generic code.
        assert_eq!(error.code, Some("API_ERROR"));
    }

    #[test]
    fn normalize_event_keeps_plain_assistant_message() {
        // A normal assistant message (no API-error markers) is unaffected.
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "assistant",
            "uuid": "u",
            "session_id": "s",
            "message": {
                "id": "m",
                "model": "claude-opus-4-8",
                "content": [{ "type": "text", "text": "Done." }]
            }
        }))
        .expect("valid assistant");

        let event = normalize_event(msg);
        assert!(event.provider_error().is_none());
        assert!(event.assistant_message().is_some());
    }

    #[test]
    fn normalize_event_keeps_text_when_assistant_has_unknown_block() {
        // Regression for CLI schema drift: an assistant message carrying a
        // novel content block (here `server_tool_use`) must still map to an
        // assistant message with its text intact — the unknown sibling degrades
        // to `Other` instead of sinking the whole message into `Unknown`/`Other`
        // (which would silently drop the agent's reply).
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "assistant",
            "uuid": "u",
            "session_id": "s",
            "message": {
                "id": "m",
                "model": "claude-opus-4-8",
                "content": [
                    { "type": "text", "text": "partial answer" },
                    { "type": "server_tool_use", "id": "x", "name": "web_search", "input": {} }
                ]
            }
        }))
        .expect("valid assistant");

        let event = normalize_event(msg);
        let message = event.assistant_message().expect("assistant message kind");
        assert!(message.content.iter().any(|block| matches!(
            block,
            crate::domain::agents::adapter::RuntimeContentBlock::Text { text } if text == "partial answer"
        )));
    }

    #[test]
    fn normalize_event_maps_result_to_result_kind() {
        let message: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "result",
            "subtype": "success",
            "uuid": "u2",
            "session_id": "s2",
            "duration_ms": 1,
            "duration_api_ms": 1,
            "is_error": false,
            "num_turns": 1,
            "result": "ok",
            "total_cost_usd": 0.0,
            "usage": { "input_tokens": 1, "output_tokens": 1 }
        }))
        .expect("valid result event");

        let event = normalize_event(message);
        assert!(event.is_result());
        assert!(
            event.result_error().is_none(),
            "a successful result must carry no error detail"
        );
    }

    #[test]
    fn normalize_event_surfaces_error_detail_from_a_failing_result() {
        // Issue #78: Claude Code (notably on Bedrock) can end a turn with an
        // error result and no other output. The mapping must keep it a Result
        // (so the turn still completes) AND carry the failure detail so the
        // reader can surface it instead of a silent stop.
        let message: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "result",
            "subtype": "error_during_execution",
            "uuid": "u3",
            "session_id": "s3",
            "duration_ms": 1,
            "duration_api_ms": 1,
            "is_error": true,
            "num_turns": 1,
            "result": "Bedrock throttled the request",
            "stop_reason": "error",
            "total_cost_usd": 0.0,
            "usage": { "input_tokens": 1, "output_tokens": 0 }
        }))
        .expect("valid error result event");

        let event = normalize_event(message);
        assert!(event.is_result(), "an error result is still a turn end");
        let error = event
            .result_error()
            .expect("a failing result must carry error detail");
        assert_eq!(error.code, "ERROR_DURING_EXECUTION");
        assert!(
            error.message.contains("Bedrock throttled the request"),
            "message should include the CLI's human-readable detail: {}",
            error.message
        );
        assert!(
            error.message.contains("error_during_execution"),
            "message should name the failing subtype: {}",
            error.message
        );
    }
}
