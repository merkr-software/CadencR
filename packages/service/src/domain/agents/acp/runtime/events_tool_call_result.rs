//! Tool-result event builders for ACP `tool_call_update` payloads.
//!
//! Two flavours, depending on whether the agent supplied a structured
//! `content[]` array (legacy / FE-rendered shape) or a literal `rawOutput`
//! blob (preserved verbatim per ACP schema, used by replay/raw-debug).
//! Split out of `events_tool_call.rs` to keep that file under the
//! 400-line ceiling.

use serde_json::{json, Value};

use crate::domain::agents::adapter::{
    RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeUserContentBlock,
    RuntimeUserMessage,
};

use super::provider_hooks::AcpProviderHooks;

pub(super) fn tool_result_event(
    tool_call_id: &str,
    content: &[Value],
    is_error: bool,
    metadata: RuntimeEventMetadata,
    hooks: &dyn AcpProviderHooks,
) -> RuntimeEvent {
    let payload = hooks.flatten_tool_result_content(content);
    build(tool_call_id, payload, is_error, metadata)
}

/// Build a tool-result event from an ACP `rawOutput` payload. Unlike
/// [`tool_result_event`], this preserves the JSON shape verbatim — no
/// flatten/unwrap — so downstream consumers (replay, raw-debug panel) see
/// the exact bytes the agent emitted.
pub(super) fn tool_result_event_from_raw_output(
    tool_call_id: &str,
    raw_output: Value,
    is_error: bool,
    metadata: RuntimeEventMetadata,
) -> RuntimeEvent {
    build(tool_call_id, raw_output, is_error, metadata)
}

fn build(
    tool_call_id: &str,
    content: Value,
    is_error: bool,
    metadata: RuntimeEventMetadata,
) -> RuntimeEvent {
    // The WS bridge ships `metadata.raw` to the FE verbatim. The FE's
    // `processSdkMessage` switches on `msg.type` and only knows
    // `stream_event`, `assistant`, `user`, `system`, `result`. ACP's raw
    // `session/update` shape has no `type` field and would be silently
    // dropped, so reshape into the Claude-style `user` envelope here.
    let session_id = metadata.session_id.clone().unwrap_or_default();
    let claude_raw = json!({
        "type": "user",
        "session_id": session_id,
        "parent_tool_use_id": Value::Null,
        "message": {
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_call_id,
                "is_error": is_error,
                "content": content.clone(),
            }],
        }
    });
    let metadata = RuntimeEventMetadata {
        raw: claude_raw,
        ..metadata
    };
    RuntimeEvent::new(
        metadata,
        RuntimeEventKind::UserMessage {
            message: RuntimeUserMessage {
                content: vec![RuntimeUserContentBlock::ToolResult {
                    tool_use_id: Some(tool_call_id.to_string()),
                    is_error,
                    content,
                }],
            },
            parent_tool_use_id: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::tool_result_event_from_raw_output;
    use crate::domain::agents::adapter::{RuntimeEventMetadata, RuntimeUserContentBlock};
    use serde_json::json;

    #[test]
    fn raw_output_preserves_object_shape() {
        let event = tool_result_event_from_raw_output(
            "t-1",
            json!({ "ok": true, "n": 7 }),
            false,
            RuntimeEventMetadata::default(),
        );
        let user = event.user_message().unwrap();
        match &user.content[0] {
            RuntimeUserContentBlock::ToolResult { content, .. } => {
                assert_eq!(content["ok"], true);
                assert_eq!(content["n"], 7);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn raw_output_marks_failure_when_is_error_true() {
        let event = tool_result_event_from_raw_output(
            "t-2",
            json!("boom"),
            true,
            RuntimeEventMetadata::default(),
        );
        match &event.user_message().unwrap().content[0] {
            RuntimeUserContentBlock::ToolResult { is_error, .. } => assert!(*is_error),
            other => panic!("unexpected: {other:?}"),
        }
    }
}
