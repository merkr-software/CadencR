mod classification;
mod mapping;
mod token_usage;

use serde_json::Value;
use tracing::warn;

use crate::domain::agents::adapter::{RuntimeEvent, RuntimeEventMetadata, RuntimeUsage};
use classification::classify_message;
pub(super) use mapping::{context_window_for_model_from_raw, model_usage_windows};
use token_usage::claude_token_usage;

pub(super) fn normalize_event(msg: claude_agent_sdk_rs::SdkMessage) -> RuntimeEvent {
    let background_agent = super::background_agents::background_agent_signal(&msg);
    let background_tasks = super::background_agents::background_task_count(&msg);
    let token_usage = claude_token_usage(&msg);
    let provider_message_id = match &msg {
        claude_agent_sdk_rs::SdkMessage::Assistant { message, .. } => Some(message.id.clone()),
        _ => None,
    };
    // Every SDK variant serializes to its wire payload (raw-preserving variants
    // as the payload itself), so this only fails on a broken SDK invariant.
    let raw = serde_json::to_value(&msg).unwrap_or_else(|error| {
        warn!(%error, "claude adapter: SDK message did not serialize; raw payload unavailable");
        Value::Null
    });
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

    let event = RuntimeEvent::new(metadata, kind)
        .with_background_agent(background_agent)
        .with_background_task_count(background_tasks)
        .with_result_error(result_error)
        .with_token_usage(token_usage)
        .with_provider_message_id(provider_message_id);
    let scheduled_wakeup = super::scheduled_wakeup::scheduled_wakeup(&event);
    event.with_scheduled_wakeup(scheduled_wakeup)
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
    fn normalize_event_keeps_task_lifecycle_frames_out_of_the_conversation() {
        // The run-in-background agent protocol (issue #58) is typed by the SDK
        // as `TaskLifecycle`. Those frames are operational metadata and must
        // NOT become visible `UNKNOWN_MESSAGE` errors, while still driving
        // background-agent tracking — and their raw payload must survive.
        let msg: claude_agent_sdk_rs::SdkMessage = serde_json::from_value(json!({
            "type": "system", "subtype": "task_started", "uuid": "u", "session_id": "s",
            "task_id": "task-abc", "task_type": "local_agent"
        }))
        .expect("task frames deserialize infallibly");
        assert!(matches!(
            msg,
            claude_agent_sdk_rs::SdkMessage::TaskLifecycle(_)
        ));

        let event = normalize_event(msg);
        assert!(event.unknown_message().is_none());
        assert!(event.is_operational_only());
        assert!(event.background_agent_signal().is_some());
        assert_eq!(event.session_id(), Some("s"));
        let raw = event.raw_json();
        assert_eq!(raw["type"], "system");
        assert_eq!(raw["subtype"], "task_started");
        assert_eq!(raw["task_id"], "task-abc");
    }

    #[test]
    fn normalize_event_counts_background_tasks_with_raw_preserved() {
        let msg = claude_agent_sdk_rs::SdkMessage::from_raw(json!({
            "type": "system", "subtype": "background_tasks_changed", "uuid": "u",
            "session_id": "s", "tasks": [{ "task_id": "a" }, { "task_id": "b" }]
        }));
        let event = normalize_event(msg);
        assert_eq!(event.background_task_count(), Some(2));
        assert!(event.unknown_message().is_none());
        assert_eq!(event.raw_json()["subtype"], "background_tasks_changed");
    }

    #[test]
    fn normalize_event_keeps_untyped_system_subtypes_silent() {
        let event = normalize_event(claude_agent_sdk_rs::SdkMessage::from_raw(json!({
            "type": "system", "subtype": "api_retry", "session_id": "s", "attempt": 1
        })));
        assert!(event.unknown_message().is_none());
        assert!(event.is_operational_only());
        assert_eq!(event.raw_json()["subtype"], "api_retry");
    }

    #[test]
    fn normalize_event_ends_the_turn_on_a_drifted_result() {
        // Counters renamed, nulled or retyped by a future CLI must cost those
        // counters only: the turn still ends, and successfully.
        let event = normalize_event(claude_agent_sdk_rs::SdkMessage::from_raw(json!({
            "type": "result", "subtype": "success", "session_id": "s",
            "is_error": false, "duration_api_ms": null, "total_cost_usd": "0.1",
            "usage": { "inputTokens": 1 },
            "permission_denials": [{ "tool_name": "Bash", "input": {} }]
        })));
        assert!(event.is_result());
        assert!(event.result_error().is_none());
        assert_eq!(event.raw_json()["type"], "result");
    }

    #[test]
    fn normalize_event_ends_the_turn_with_a_visible_error_on_a_malformed_result() {
        let msg = claude_agent_sdk_rs::SdkMessage::from_raw(json!({
            "type": "result", "subtype": null, "session_id": "s",
            "result": "Bedrock throttled the request"
        }));
        assert!(matches!(msg, claude_agent_sdk_rs::SdkMessage::Malformed(_)));

        let event = normalize_event(msg);
        assert!(event.is_result(), "a malformed result still ends the turn");
        assert!(event.unknown_message().is_none());
        assert_eq!(event.session_id(), Some("s"));
        let error = event.result_error().expect("visible error");
        assert_eq!(error.code, "MALFORMED_RESULT");
        assert!(
            error.message.contains("Bedrock throttled the request"),
            "{}",
            error.message
        );
        assert_eq!(event.raw_json()["result"], "Bedrock throttled the request");
    }

    #[test]
    fn normalize_event_ends_the_turn_quietly_on_a_malformed_successful_result() {
        let event = normalize_event(claude_agent_sdk_rs::SdkMessage::from_raw(json!({
            "type": "result", "session_id": "s", "is_error": false
        })));
        assert!(event.is_result());
        assert!(event.result_error().is_none());
    }

    #[test]
    fn normalize_event_surfaces_malformed_conversation_messages_with_raw() {
        // A known non-system kind failing its schema renders like an unknown
        // message (visible, raw kept) rather than vanishing.
        let event = normalize_event(claude_agent_sdk_rs::SdkMessage::from_raw(json!({
            "type": "assistant", "session_id": "s", "message": { "content": "text" }
        })));
        let raw = event.unknown_message().expect("visible malformed message");
        assert_eq!(raw["type"], "assistant");
        assert_eq!(event.raw_json()["message"]["content"], "text");
    }

    #[test]
    fn normalize_event_drops_malformed_system_messages_silently() {
        let event = normalize_event(claude_agent_sdk_rs::SdkMessage::from_raw(json!({
            "type": "system", "subtype": "compact_boundary", "session_id": "s"
        })));
        assert!(event.unknown_message().is_none());
        assert!(event.is_operational_only());
    }

    #[test]
    fn normalize_event_keeps_the_rate_limit_wire_tag_in_raw() {
        let event = normalize_event(claude_agent_sdk_rs::SdkMessage::from_raw(json!({
            "type": "rate_limit_event", "uuid": "u", "session_id": "s",
            "rate_limit_info": { "status": "allowed" }
        })));
        assert_eq!(event.raw_json()["type"], "rate_limit_event");
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
        // The event's own raw (diagnostics, raw consumers) is never `null`.
        assert_eq!(event.raw_json()["payload"]["text"], "hi");
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
    fn normalize_event_never_guesses_a_window_from_the_init_model_id() {
        // The CLI reports no window on init, and an id is not a window: the
        // `[1m]` marker is absent for natively-1M models (Fable, Opus 5.5) and
        // a hardcoded family list lags every new model. The adapter answers
        // from windows the CLI actually reported instead.
        for model in [
            "claude-fable-5[1m]",
            "us.anthropic.claude-sonnet-4-5[1m]",
            "claude-opus-5-5",
            "us.anthropic.claude-sonnet-4-5",
        ] {
            let event = normalize_event(init_message(model));
            let init = event.init().expect("init kind");
            assert_eq!(init.model.as_deref(), Some(model));
            assert_eq!(init.context_window, None, "{model}");
        }
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
