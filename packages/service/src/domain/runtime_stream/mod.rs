use crate::domain::agents::adapter::{AgentRuntimeAdapter, RuntimeEvent, RuntimePermissionRequest};
use crate::domain::ws_session::protocol::PermissionRequestPayload;

mod subagent_window;
mod usage_state;

pub(crate) use usage_state::{RuntimeUsageSnapshot, RuntimeUsageState};

pub(crate) fn permission_request_payload(
    request: RuntimePermissionRequest,
) -> PermissionRequestPayload {
    PermissionRequestPayload {
        request_id: request.request_id,
        tool_name: request.tool_name,
        tool_input: request.tool_input,
        description: request.description,
        pattern: request.pattern,
        preview: request.preview,
        options: request.options.into_iter().map(Into::into).collect(),
    }
}

pub(crate) fn capture_runtime_session_id(
    runtime_event: &RuntimeEvent,
    current_runtime_session_id: Option<&str>,
) -> Option<String> {
    if current_runtime_session_id.is_some() {
        return None;
    }
    runtime_event
        .session_id()
        .filter(|runtime_session_id| !runtime_session_id.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn update_context_window(
    runtime_adapter: Option<&dyn AgentRuntimeAdapter>,
    runtime_event: &RuntimeEvent,
    active_model: Option<&str>,
) -> Option<u64> {
    runtime_adapter
        .and_then(|adapter| adapter.context_window_for_event(runtime_event, active_model))
        .or_else(|| {
            runtime_event
                .context_window()
                .or_else(|| runtime_event.init().and_then(|init| init.context_window))
        })
}

pub(crate) async fn persist_usage(
    runtime_event: &RuntimeEvent,
    db_session_id: i64,
    write_pool: &sqlx::SqlitePool,
) -> Result<bool, sqlx::Error> {
    let Some(usage) = runtime_event.usage() else {
        return Ok(false);
    };
    if usage.is_zero() {
        return Ok(false);
    }
    crate::domain::ws_session::persistence::WsSessionPersistence::update_token_usage(
        write_pool,
        db_session_id,
        usage.input_tokens,
        usage.output_tokens,
    )
    .await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{capture_runtime_session_id, permission_request_payload, update_context_window};
    use crate::domain::agents::adapter::{
        RuntimeContentBlock, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
        RuntimeInitEvent, RuntimePermissionDecision, RuntimePermissionOption,
        RuntimePermissionRequest,
    };
    use crate::domain::agents::claude_code::CLAUDE_CODE_ADAPTER;

    #[test]
    fn permission_request_payload_preserves_options() {
        let payload = permission_request_payload(RuntimePermissionRequest {
            request_id: "req-1".into(),
            tool_use_id: None,
            tool_name: "Read".into(),
            tool_input: json!({ "path": "/tmp/file" }),
            description: Some("read a file".into()),
            pattern: Some("Read(/tmp/*)".into()),
            preview: Some("preview".into()),
            options: vec![RuntimePermissionOption {
                decision: RuntimePermissionDecision::AllowOnce,
                option_id: None,
                label: "Allow once".into(),
                description: "Allow this read".into(),
                collect_feedback: false,
            }],
        });

        assert_eq!(payload.request_id, "req-1");
        assert_eq!(payload.tool_name, "Read");
        assert_eq!(payload.options.len(), 1);
    }

    #[test]
    fn capture_runtime_session_id_uses_existing_session_as_capture_state() {
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("sess-123".into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "stream_event" }),
            },
            RuntimeEventKind::AssistantMessage {
                message: crate::domain::agents::adapter::RuntimeAssistantMessage {
                    model: None,
                    content: vec![RuntimeContentBlock::Other],
                },
                parent_tool_use_id: None,
            },
        );

        assert_eq!(
            capture_runtime_session_id(&event, None),
            Some("sess-123".into())
        );
        assert_eq!(capture_runtime_session_id(&event, Some("sess-123")), None);
    }

    #[test]
    fn update_context_window_reads_metadata_context_window() {
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: None,
                usage: None,
                context_window: Some(1_000_000),
                raw: json!({ "type": "result" }),
            },
            RuntimeEventKind::Result,
        );

        assert_eq!(update_context_window(None, &event, None), Some(1_000_000));
    }

    #[test]
    fn update_context_window_reads_opencode_init_value() {
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: None,
                usage: None,
                context_window: None,
                raw: json!({ "type": "init" }),
            },
            RuntimeEventKind::Init(RuntimeInitEvent {
                model: Some("claude-opus-4-6".into()),
                mcp_servers: vec![],
                context_window: Some(123_456),
            }),
        );

        assert_eq!(update_context_window(None, &event, None), Some(123_456));
    }

    #[test]
    fn update_context_window_uses_active_model_from_raw_json() {
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: None,
                usage: None,
                context_window: Some(1_000_000),
                raw: json!({
                    "type": "result",
                    "modelUsage": {
                        "claude-opus-4-7[1m]": { "contextWindow": 1_000_000 },
                        "claude-sonnet-4-6": { "contextWindow": 200_000 }
                    }
                }),
            },
            RuntimeEventKind::Result,
        );

        assert_eq!(
            update_context_window(Some(&CLAUDE_CODE_ADAPTER), &event, None),
            Some(1_000_000)
        );
        assert_eq!(
            update_context_window(
                Some(&CLAUDE_CODE_ADAPTER),
                &event,
                Some("claude-sonnet-4-6"),
            ),
            Some(200_000)
        );
        assert_eq!(
            update_context_window(
                Some(&CLAUDE_CODE_ADAPTER),
                &event,
                Some("claude-opus-4-7[1m]"),
            ),
            Some(1_000_000)
        );
    }

    #[test]
    fn update_context_window_uses_single_claude_model_when_alias_does_not_match() {
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: None,
                usage: None,
                context_window: Some(1_000_000),
                raw: json!({
                    "type": "result",
                    "modelUsage": {
                        "claude-opus-4-7[1m]": { "contextWindow": 1_000_000 }
                    }
                }),
            },
            RuntimeEventKind::Result,
        );

        assert_eq!(
            update_context_window(Some(&CLAUDE_CODE_ADAPTER), &event, Some("default")),
            Some(1_000_000)
        );
    }

    #[test]
    fn update_context_window_returns_none_when_event_has_no_authoritative_value() {
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("s1".into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "stream_event" }),
            },
            RuntimeEventKind::AssistantMessage {
                message: crate::domain::agents::adapter::RuntimeAssistantMessage {
                    model: None,
                    content: vec![RuntimeContentBlock::Other],
                },
                parent_tool_use_id: None,
            },
        );

        assert_eq!(update_context_window(None, &event, None), None);
    }
}
