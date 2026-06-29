use serde_json::Value;

use crate::domain::agents::adapter::{
    RuntimeAssistantMessage, RuntimeCompactMetadata, RuntimeContentBlock, RuntimeContentDelta,
    RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeInitEvent, RuntimeMcpServerStatus,
    RuntimeResultError, RuntimeStreamEvent, RuntimeTurnStartedSource, RuntimeUsage,
    RuntimeUserContentBlock, RuntimeUserMessage,
};

pub(super) fn context_window_for_model_from_raw(raw: &Value, model: &str) -> Option<u64> {
    let model_usage = raw.get("modelUsage")?.as_object()?;
    if let Some(context_window) = model_usage
        .get(model)
        .and_then(|entry| entry.get("contextWindow"))
        .and_then(Value::as_u64)
    {
        return Some(context_window);
    }

    if model_usage.len() == 1 {
        return model_usage
            .values()
            .next()
            .and_then(|entry| entry.get("contextWindow"))
            .and_then(Value::as_u64);
    }

    None
}

/// Early context-window hint from the init message's *resolved* model id, used
/// to scale the live usage bar before the turn's authoritative
/// `Result.modelUsage.contextWindow` arrives (init carries no window field).
///
/// Recognizes only the `[1m]` marker (the 1M-context beta), which is 1,000,000
/// tokens on every backend — Anthropic, Bedrock, Vertex alike. Any other id
/// returns `None` and defers to the CLI's authoritative `Result`; we never
/// guess a size that could override a real value or be wrong for a
/// custom/proxy/Bedrock-pinned model. `contains` (not `ends_with`) because
/// Bedrock/Vertex ids affix region/routing (`us.anthropic.…-sonnet-4-5[1m]`).
fn init_model_context_window(model: &str) -> Option<u64> {
    model.contains("[1m]").then_some(1_000_000)
}

/// Human-readable text for an API-error assistant message: the joined text
/// blocks (e.g. "API Error: 529 Overloaded…"). Falls back to the synthetic
/// `error` category string, then a generic message, when the CLI sent no text.
fn api_error_text(
    content: &[claude_agent_sdk_rs::types::ContentBlock],
    error: Option<&str>,
) -> String {
    let text = content
        .iter()
        .filter_map(|block| match block {
            claude_agent_sdk_rs::types::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        error
            .unwrap_or("The agent reported an API error.")
            .to_string()
    } else {
        text
    }
}

fn map_content_block(block: &claude_agent_sdk_rs::types::ContentBlock) -> RuntimeContentBlock {
    match block {
        claude_agent_sdk_rs::types::ContentBlock::Text { text } => {
            RuntimeContentBlock::Text { text: text.clone() }
        }
        claude_agent_sdk_rs::types::ContentBlock::Thinking { thinking, .. } => {
            RuntimeContentBlock::Thinking {
                thinking: thinking.clone(),
            }
        }
        claude_agent_sdk_rs::types::ContentBlock::ToolUse { id, name, input } => {
            RuntimeContentBlock::ToolUse {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }
        }
        _ => RuntimeContentBlock::Other,
    }
}

fn map_stream_event(event: &claude_agent_sdk_rs::StreamEventData) -> RuntimeStreamEvent {
    match event {
        claude_agent_sdk_rs::StreamEventData::MessageStart { message } => {
            RuntimeStreamEvent::MessageStart {
                model: Some(message.model.clone()),
                input_tokens: message
                    .usage
                    .as_ref()
                    .map(|usage| usage.total_input_tokens()),
            }
        }
        claude_agent_sdk_rs::StreamEventData::ContentBlockStart {
            index,
            content_block,
        } => RuntimeStreamEvent::ContentBlockStart {
            index: u64::from(*index),
            block: map_content_block(content_block),
        },
        claude_agent_sdk_rs::StreamEventData::ContentBlockDelta { index, delta } => {
            match delta {
                claude_agent_sdk_rs::types::ContentDelta::TextDelta { text } => {
                    RuntimeStreamEvent::ContentBlockDelta {
                        index: u64::from(*index),
                        delta: RuntimeContentDelta::Text { text: text.clone() },
                    }
                }
                claude_agent_sdk_rs::types::ContentDelta::ThinkingDelta { thinking } => {
                    RuntimeStreamEvent::ContentBlockDelta {
                        index: u64::from(*index),
                        delta: RuntimeContentDelta::Thinking {
                            thinking: thinking.clone(),
                        },
                    }
                }
                claude_agent_sdk_rs::types::ContentDelta::InputJsonDelta { partial_json } => {
                    RuntimeStreamEvent::ContentBlockDelta {
                        index: u64::from(*index),
                        delta: RuntimeContentDelta::InputJson {
                            partial_json: partial_json.clone(),
                        },
                    }
                }
                // An unknown delta type carries nothing we can render; treat the
                // whole event as `Other` rather than fabricating a delta.
                claude_agent_sdk_rs::types::ContentDelta::Other => RuntimeStreamEvent::Other,
            }
        }
        claude_agent_sdk_rs::StreamEventData::ContentBlockStop { index } => {
            RuntimeStreamEvent::ContentBlockStop {
                index: u64::from(*index),
            }
        }
        _ => RuntimeStreamEvent::Other,
    }
}

fn map_user_message(message: &Value) -> RuntimeUserMessage {
    let content = message
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    if item.get("type").and_then(Value::as_str) == Some("tool_result") {
                        RuntimeUserContentBlock::ToolResult {
                            tool_use_id: item
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned),
                            is_error: item
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            content: item.get("content").cloned().unwrap_or(Value::Null),
                        }
                    } else {
                        RuntimeUserContentBlock::Other
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    RuntimeUserMessage { content }
}

pub(super) fn normalize_event(msg: claude_agent_sdk_rs::SdkMessage) -> RuntimeEvent {
    let background_agent = super::background_agents::background_agent_signal(&msg);
    let metadata = RuntimeEventMetadata {
        session_id: msg.session_id().map(ToOwned::to_owned),
        usage: msg.usage().map(|usage| RuntimeUsage {
            input_tokens: usage.input_tokens
                + usage.cache_creation_input_tokens.unwrap_or(0)
                + usage.cache_read_input_tokens.unwrap_or(0),
            output_tokens: usage.output_tokens,
        }),
        context_window: msg.result_context_window(),
        raw: serde_json::to_value(&msg).unwrap_or(Value::Null),
    };

    // Populated by a failing (`is_error`) `Result`; see `RuntimeResultError`.
    let mut result_error: Option<RuntimeResultError> = None;

    let kind = match msg {
        claude_agent_sdk_rs::SdkMessage::System(system) => match system {
            claude_agent_sdk_rs::messages::SystemMessage::Init {
                model, mcp_servers, ..
            } => {
                let context_window = init_model_context_window(&model);
                RuntimeEventKind::Init(RuntimeInitEvent {
                    model: Some(model),
                    mcp_servers: mcp_servers
                        .into_iter()
                        .map(|server| RuntimeMcpServerStatus {
                            name: server.name,
                            status: server.status,
                        })
                        .collect(),
                    context_window,
                })
            }
            claude_agent_sdk_rs::messages::SystemMessage::CompactBoundary {
                compact_metadata,
                ..
            } => RuntimeEventKind::CompactBoundary {
                metadata: Some(RuntimeCompactMetadata {
                    trigger: Some(compact_metadata.trigger),
                    pre_tokens: Some(compact_metadata.pre_tokens),
                }),
            },
            status @ claude_agent_sdk_rs::messages::SystemMessage::Status { .. } => {
                if status.is_compaction_started() {
                    RuntimeEventKind::TurnStarted {
                        source: RuntimeTurnStartedSource::ManualCompact,
                    }
                } else {
                    RuntimeEventKind::Other
                }
            }
        },
        claude_agent_sdk_rs::SdkMessage::Assistant {
            message,
            parent_tool_use_id,
            error,
            is_api_error_message,
            api_error_status,
            ..
        } if is_api_error_message => RuntimeEventKind::ProviderError {
            message: api_error_text(&message.content, error.as_deref()),
            code: Some(
                api_error_status
                    .map(|status| format!("API_ERROR_{status}"))
                    .unwrap_or_else(|| "API_ERROR".to_string()),
            ),
            parent_tool_use_id,
        },
        claude_agent_sdk_rs::SdkMessage::Assistant {
            message,
            parent_tool_use_id,
            ..
        } => RuntimeEventKind::AssistantMessage {
            message: RuntimeAssistantMessage {
                model: Some(message.model),
                content: message.content.iter().map(map_content_block).collect(),
            },
            parent_tool_use_id,
        },
        claude_agent_sdk_rs::SdkMessage::User {
            message,
            parent_tool_use_id,
            ..
        } => RuntimeEventKind::UserMessage {
            message: map_user_message(&message),
            parent_tool_use_id,
        },
        claude_agent_sdk_rs::SdkMessage::StreamEvent {
            event,
            parent_tool_use_id,
            ..
        } => RuntimeEventKind::StreamEvent {
            event: map_stream_event(&event),
            parent_tool_use_id,
        },
        claude_agent_sdk_rs::SdkMessage::ToolUseSummary { data, .. } => {
            RuntimeEventKind::ToolUseSummary { data }
        }
        claude_agent_sdk_rs::SdkMessage::Result {
            is_error,
            ref subtype,
            ref result,
            ref errors,
            ref stop_reason,
            ..
        } => {
            if is_error {
                result_error = Some(build_result_error(
                    subtype,
                    result.as_deref(),
                    errors.as_deref(),
                    stop_reason.as_deref(),
                ));
            }
            RuntimeEventKind::Result
        }
        // A message type the SDK has never seen. Keep the raw payload so the
        // stream reader can surface it to the conversation instead of dropping
        // it silently — the silent-stop users couldn't diagnose. EXCEPT
        // `system` messages: those are operational metadata, not conversation
        // content, and the run-in-background agent protocol (issue #58) emits
        // `system/task_started` / `system/task_notification` that arrive here
        // as Unknown by design. Surfacing those as visible errors would spam
        // the conversation on every background-agent run, so an unknown
        // `system` subtype stays silent (`Other`) like every other operational
        // message; only genuinely-unknown NON-system messages reach the user.
        claude_agent_sdk_rs::SdkMessage::Unknown(raw) => {
            if raw.get("type").and_then(Value::as_str) == Some("system") {
                RuntimeEventKind::Other
            } else {
                RuntimeEventKind::Unknown { raw }
            }
        }
        _ => RuntimeEventKind::Other,
    };

    RuntimeEvent::new(metadata, kind)
        .with_background_agent(background_agent)
        .with_result_error(result_error)
}

/// Assemble a [`RuntimeResultError`] from a failing Claude Code `Result`.
/// `code` is the upper-cased subtype (e.g. `ERROR_DURING_EXECUTION`) so the
/// failure mode is identifiable; the message prefers the CLI's human-readable
/// `result` text, then any `errors`, and appends a `stop_reason` when present.
fn build_result_error(
    subtype: &str,
    result: Option<&str>,
    errors: Option<&[String]>,
    stop_reason: Option<&str>,
) -> RuntimeResultError {
    let code = if subtype.is_empty() {
        "AGENT_ERROR".to_string()
    } else {
        subtype.to_uppercase()
    };
    let detail = result
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            errors
                .filter(|list| !list.is_empty())
                .map(|list| list.join("; "))
        });
    let mut message = match detail {
        Some(detail) => format!("Claude Code ended the turn with an error ({subtype}): {detail}"),
        None => format!("Claude Code ended the turn with an error ({subtype})."),
    };
    if let Some(reason) = stop_reason
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
    {
        message.push_str(&format!(" [stop reason: {reason}]"));
    }
    RuntimeResultError { code, message }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{build_result_error, context_window_for_model_from_raw, normalize_event};
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
                "claude-opus-4-7[1m]": { "contextWindow": 1000000 }
            }
        }))
        .unwrap();
        let event = normalize_event(msg);
        assert_eq!(event.context_window(), Some(1_000_000));
    }

    #[test]
    fn context_window_for_model_from_raw_uses_single_entry_for_default_alias() {
        let raw = json!({
            "type": "result",
            "modelUsage": {
                "claude-opus-4-7[1m]": { "contextWindow": 1_000_000 }
            }
        });

        assert_eq!(
            context_window_for_model_from_raw(&raw, "default"),
            Some(1_000_000)
        );
    }

    fn init_message(model: &str) -> claude_agent_sdk_rs::SdkMessage {
        // Real wire shape: the CLI emits `permissionMode` in camelCase.
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

    #[test]
    fn build_result_error_falls_back_to_a_generic_message_without_detail() {
        // A failing result with no human-readable text must still produce a
        // surfaceable message rather than an empty one.
        let error = build_result_error("error_max_turns", None, None, None);
        assert_eq!(error.code, "ERROR_MAX_TURNS");
        assert!(error.message.contains("error_max_turns"));
    }
}
