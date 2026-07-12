use serde_json::{json, Value};

use crate::domain::agents::adapter::{
    RuntimeCompactMetadata, RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent,
    RuntimeEventKind, RuntimeEventMetadata, RuntimeStreamEvent,
};

pub(super) fn metadata(session_id: &str, raw: Value) -> RuntimeEventMetadata {
    RuntimeEventMetadata {
        session_id: Some(session_id.to_string()),
        raw,
        ..RuntimeEventMetadata::default()
    }
}

pub(super) fn thread_id(params: &Value) -> &str {
    params
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or("codex")
}

pub(super) fn stream_raw(
    session_id: &str,
    parent_tool_use_id: Option<&str>,
    event: Value,
) -> Value {
    json!({
        "type": "stream_event",
        "session_id": session_id,
        "parent_tool_use_id": parent_tool_use_id,
        "event": event,
    })
}

pub(super) fn stream_event_raw(
    session_id: &str,
    parent_tool_use_id: Option<&str>,
    event: &RuntimeStreamEvent,
) -> Value {
    let raw_event = match event {
        RuntimeStreamEvent::MessageStart { model, .. } => {
            json!({ "type": "message_start", "message": { "model": model } })
        }
        RuntimeStreamEvent::ContentBlockStart { index, block } => json!({
            "type": "content_block_start",
            "index": index,
            "content_block": content_block_json(block),
        }),
        RuntimeStreamEvent::ContentBlockDelta { index, delta } => json!({
            "type": "content_block_delta",
            "index": index,
            "delta": delta_json(delta),
        }),
        RuntimeStreamEvent::ContentBlockStop { index } => {
            json!({ "type": "content_block_stop", "index": index })
        }
        RuntimeStreamEvent::Other => json!({ "type": "unknown" }),
    };
    stream_raw(session_id, parent_tool_use_id, raw_event)
}

pub(super) fn runtime_stream_event(session_id: &str, event: RuntimeStreamEvent) -> RuntimeEvent {
    RuntimeEvent::new(
        metadata(session_id, stream_event_raw(session_id, None, &event)),
        RuntimeEventKind::StreamEvent {
            event,
            parent_tool_use_id: None,
        },
    )
}

pub(super) fn user_raw(
    session_id: &str,
    parent_tool_use_id: Option<&str>,
    content: Vec<Value>,
) -> Value {
    json!({
        "type": "user",
        "session_id": session_id,
        "parent_tool_use_id": parent_tool_use_id,
        "message": { "content": content },
    })
}

pub(super) fn compact_raw(session_id: &str, metadata: Value) -> Value {
    json!({
        "type": "system",
        "subtype": "compact_boundary",
        "session_id": session_id,
        "compact_metadata": metadata,
    })
}

pub(super) fn compact_event(params: Value) -> RuntimeEvent {
    let sid = thread_id(&params).to_string();
    let item = params.get("item").unwrap_or(&Value::Null);
    let trigger = item
        .get("trigger")
        .or_else(|| params.get("trigger"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let pre_tokens = item
        .get("preTokens")
        .or_else(|| params.get("preTokens"))
        .and_then(Value::as_u64);
    let compact_metadata = RuntimeCompactMetadata {
        trigger,
        pre_tokens,
    };
    RuntimeEvent::new(
        metadata(
            &sid,
            compact_raw(
                &sid,
                json!({
                    "trigger": compact_metadata.trigger.clone(),
                    "pre_tokens": compact_metadata.pre_tokens,
                }),
            ),
        ),
        RuntimeEventKind::CompactBoundary {
            metadata: Some(compact_metadata),
        },
    )
}

pub(super) fn input_json_delta_event(
    params: Value,
    item_id: &str,
    partial_json: String,
    index_state: &mut super::event_state::IndexState,
) -> Vec<RuntimeEvent> {
    let event = RuntimeStreamEvent::ContentBlockDelta {
        index: index_state.index_for(item_id),
        delta: RuntimeContentDelta::InputJson { partial_json },
    };
    let sid = thread_id(&params).to_string();
    vec![RuntimeEvent::new(
        metadata(&sid, stream_event_raw(&sid, None, &event)),
        RuntimeEventKind::StreamEvent {
            event,
            parent_tool_use_id: None,
        },
    )]
}

pub(super) fn content_block_json(block: &RuntimeContentBlock) -> Value {
    match block {
        RuntimeContentBlock::Text { text } => json!({ "type": "text", "text": text }),
        RuntimeContentBlock::Thinking { thinking } => {
            json!({ "type": "thinking", "thinking": thinking })
        }
        RuntimeContentBlock::ToolUse { id, name, input } => {
            json!({ "type": "tool_use", "id": id, "name": name, "input": input })
        }
        RuntimeContentBlock::Other => json!({ "type": "unknown" }),
    }
}

pub(super) fn delta_json(delta: &RuntimeContentDelta) -> Value {
    match delta {
        RuntimeContentDelta::Text { text } => json!({ "type": "text_delta", "text": text }),
        RuntimeContentDelta::Thinking { thinking } => {
            json!({ "type": "thinking_delta", "thinking": thinking })
        }
        RuntimeContentDelta::InputJson { partial_json } => {
            json!({ "type": "input_json_delta", "partial_json": partial_json })
        }
    }
}
