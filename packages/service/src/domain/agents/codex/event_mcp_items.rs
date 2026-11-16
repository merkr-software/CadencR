use serde_json::Value;

use super::event_inputs::{mcp_input, mcp_tool_name};
use super::event_items::{item_failed, stream_start_event, tool_result_event_with_error};
use super::event_json::thread_id;
use super::event_state::IndexState;
use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeEvent};

pub(super) fn mcp_tool_item(
    params: Value,
    completed: bool,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let Some(item) = params.get("item") else {
        return Vec::new();
    };
    let item_id = item_id(item);
    let id = index_state.canonical_id(&item_id);
    if completed {
        return completed_mcp_events(&params, item, &item_id, id, index_state);
    }
    if index_state.has_index(&item_id) {
        return Vec::new();
    }
    vec![mcp_start_event(
        &params,
        &item_id,
        id,
        mcp_tool_name(item),
        mcp_input(item),
        index_state,
    )]
}

fn completed_mcp_events(
    params: &Value,
    item: &Value,
    item_id: &str,
    id: String,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let mut events = Vec::new();
    let mut fallback = None;
    if !index_state.has_index(item_id) {
        let input = mcp_input(item);
        fallback = Some(input.clone());
        events.push(mcp_start_event(
            params,
            item_id,
            id.clone(),
            mcp_tool_name(item),
            input,
            index_state,
        ));
    }
    if index_state.record_result(&id) {
        events.push(tool_result_event_with_error(
            params,
            id,
            mcp_result_content(item, fallback.as_ref()),
            item_failed(item),
        ));
    }
    events
}

fn mcp_start_event(
    params: &Value,
    item_id: &str,
    id: String,
    name: String,
    input: Value,
    index_state: &mut IndexState,
) -> RuntimeEvent {
    let block = RuntimeContentBlock::ToolUse { id, name, input };
    stream_start_event(thread_id(params), index_state.index_for(item_id), block)
}

fn mcp_result_content(item: &Value, fallback: Option<&Value>) -> Value {
    let error = item.get("error").filter(|error| !error.is_null());
    if let Some(error) = error {
        return serde_json::json!({ "error": error });
    }
    item.get("result")
        .or_else(|| item.get("output"))
        .cloned()
        .unwrap_or_else(|| fallback.cloned().unwrap_or_else(|| mcp_input(item)))
}

fn item_id(item: &Value) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .unwrap_or("codex_item")
        .to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::mcp_tool_item;
    use crate::domain::agents::adapter::{RuntimeEvent, RuntimeUserContentBlock};
    use crate::domain::agents::codex::event_state::IndexState;

    fn tool_result(events: &[RuntimeEvent]) -> &RuntimeUserContentBlock {
        let message = events
            .iter()
            .find_map(RuntimeEvent::user_message)
            .expect("tool result message");
        &message.content[0]
    }

    #[test]
    fn mcp_failed_status_is_an_error_result() {
        let mut indexes = IndexState::default();
        let events = mcp_tool_item(
            json!({
                "threadId": "thread",
                "item": {
                    "type": "mcpToolCall",
                    "id": "tool",
                    "server": "cadencr-browser",
                    "tool": "browser_screenshot",
                    "status": "failed",
                    "error": null
                }
            }),
            true,
            &mut indexes,
        );

        let RuntimeUserContentBlock::ToolResult { is_error, .. } = tool_result(&events) else {
            panic!("expected tool result");
        };
        assert!(is_error);
    }

    #[test]
    fn mcp_success_result_uses_tool_result_payload() {
        let mut indexes = IndexState::default();
        let events = mcp_tool_item(
            json!({
                "threadId": "thread",
                "item": {
                    "type": "mcpToolCall",
                    "id": "tool",
                    "server": "cadencr-browser",
                    "tool": "browser_screenshot",
                    "result": { "session_id": 42 },
                    "error": null
                }
            }),
            true,
            &mut indexes,
        );

        let RuntimeUserContentBlock::ToolResult {
            is_error, content, ..
        } = tool_result(&events)
        else {
            panic!("expected tool result");
        };
        assert!(!is_error);
        assert_eq!(content, &json!({ "session_id": 42 }));
    }

    #[test]
    fn mcp_error_result_is_marked_error_and_visible() {
        let mut indexes = IndexState::default();
        let events = mcp_tool_item(
            json!({
                "threadId": "thread",
                "item": {
                    "type": "mcpToolCall",
                    "id": "tool",
                    "server": "cadencr-browser",
                    "tool": "browser_screenshot",
                    "error": "no such table: features"
                }
            }),
            true,
            &mut indexes,
        );

        let RuntimeUserContentBlock::ToolResult {
            is_error, content, ..
        } = tool_result(&events)
        else {
            panic!("expected tool result");
        };
        assert!(*is_error);
        assert_eq!(content, &json!({ "error": "no such table: features" }));
    }
}
