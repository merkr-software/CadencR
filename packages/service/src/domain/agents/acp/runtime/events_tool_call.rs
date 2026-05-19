use super::events_stream_blocks::EventIndexer;
use super::events_tool_call_input::is_empty_value;
use super::events_tool_call_parent::parent_tool_use_id;
use super::provider_hooks::AcpProviderHooks;
use super::stream_events::stream_start_event;
use crate::domain::agents::adapter::{
    RuntimeContentBlock, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
};
use serde_json::Value;
pub struct MappedUpdate {
    pub events: Vec<RuntimeEvent>,
}
pub fn map_tool_call_start(
    body: &Value,
    indexer: &mut EventIndexer,
    metadata: RuntimeEventMetadata,
    hooks: &dyn AcpProviderHooks,
) -> MappedUpdate {
    let Some(tool_call_id) = body
        .get("toolCallId")
        .or_else(|| body.get("toolUseId"))
        .and_then(Value::as_str)
    else {
        return MappedUpdate {
            events: vec![other_event(metadata)],
        };
    };
    let raw_tool_name = body
        .get("toolName")
        .or_else(|| body.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let tool_name = hooks.normalize_tool_name(raw_tool_name);
    let raw = body
        .get("rawInput")
        .filter(|v| !is_empty_value(v))
        .or_else(|| body.get("toolInput"))
        .cloned()
        .unwrap_or(Value::Null);
    let is_empty_raw = is_empty_value(&raw);
    if tool_name == "TodoWrite" && indexer.has_plan_todowrite_emitted() && is_empty_raw {
        indexer.suppress_tool_call(tool_call_id);
        return MappedUpdate { events: vec![] };
    }
    indexer.record_tool_name(tool_call_id, &tool_name);
    hooks.record_tool_call_start(tool_call_id, &tool_name);
    let input = hooks.normalize_tool_input(&tool_name, raw);
    if !is_empty_value(&input) {
        indexer.record_tool_input(tool_call_id, input.clone());
    }
    let parent = parent_tool_use_id(body);
    if let Some(event) = hooks.tool_call_start_override(
        tool_call_id,
        &tool_name,
        &input,
        &metadata,
        parent.as_deref(),
        indexer,
    ) {
        return MappedUpdate {
            events: vec![event],
        };
    }
    if tool_name == "AskUserQuestion" {
        return MappedUpdate { events: vec![] };
    }
    let index = indexer.index_for_tool(tool_call_id);
    let block = RuntimeContentBlock::ToolUse {
        id: tool_call_id.to_string(),
        name: tool_name,
        input,
    };
    let event = stream_start_event(
        metadata.session_id.as_deref().unwrap_or(""),
        index,
        block,
        parent.as_deref(),
    );
    MappedUpdate {
        events: vec![event],
    }
}
pub fn other_event(metadata: RuntimeEventMetadata) -> RuntimeEvent {
    RuntimeEvent::new(metadata, RuntimeEventKind::Other)
}
#[cfg(test)]
mod tests {
    use super::map_tool_call_start;
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::events_tool_call_update::map_tool_call_update;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::adapter::{
        RuntimeContentBlock, RuntimeEventMetadata, RuntimePermissionMode, RuntimeStreamEvent,
    };
    use serde_json::{json, Value};
    struct PlainHooks;
    #[async_trait::async_trait]
    impl AcpProviderHooks for PlainHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }
        fn normalize_tool_input(&self, _tool_name: &str, input: Value) -> Value {
            input
        }
        fn flatten_tool_result_content(&self, blocks: &[Value]) -> Value {
            let texts: Option<Vec<String>> = blocks
                .iter()
                .map(|b| {
                    b.get("type").and_then(Value::as_str).and_then(|kind| {
                        if kind == "text" {
                            b.get("text").and_then(Value::as_str).map(ToOwned::to_owned)
                        } else {
                            None
                        }
                    })
                })
                .collect();
            if let Some(texts) = texts {
                if !texts.is_empty() {
                    return Value::String(texts.join("\n"));
                }
            }
            json!(blocks)
        }
        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            None
        }
    }
    fn metadata() -> RuntimeEventMetadata {
        RuntimeEventMetadata {
            raw: json!({}),
            ..RuntimeEventMetadata::default()
        }
    }
    #[test]
    fn start_emits_content_block_start_with_tool_use() {
        let mut idx = EventIndexer::default();
        let result = map_tool_call_start(
            &json!({ "toolCallId": "t-1", "toolName": "Bash", "toolInput": { "command": "ls" } }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        match result.events[0].stream_event().unwrap() {
            RuntimeStreamEvent::ContentBlockStart {
                block: RuntimeContentBlock::ToolUse { id, name, input },
                ..
            } => {
                assert_eq!(id, "t-1");
                assert_eq!(name, "Bash");
                assert_eq!(input["command"], "ls");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn start_raw_envelope_is_claude_shaped_for_frontend_dispatch() {
        let mut idx = EventIndexer::default();
        let result = map_tool_call_start(
            &json!({
                "toolCallId": "call_abc",
                "title": "bash",
                "rawInput": {
                    "command": "ls",
                    "description": "list",
                    "timeout": 120000,
                    "workdir": "/tmp",
                },
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        let raw = result.events[0].raw_json();
        assert_eq!(raw["type"], "stream_event");
        assert_eq!(raw["event"]["type"], "content_block_start");
        assert_eq!(raw["event"]["content_block"]["type"], "tool_use");
        assert_eq!(raw["event"]["content_block"]["name"], "bash");
        assert_eq!(raw["event"]["content_block"]["input"]["command"], "ls");
    }
    #[test]
    fn start_without_tool_call_id_falls_back_to_other() {
        let mut idx = EventIndexer::default();
        let result = map_tool_call_start(
            &json!({ "toolName": "Bash" }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        assert!(result.events[0].stream_event().is_none());
    }
    #[test]
    fn start_preserves_parent_tool_use_id_from_nested_acp_call() {
        let mut idx = EventIndexer::default();
        let result = map_tool_call_start(
            &json!({
                "toolCallId": "child-1",
                "parentToolCallId": "parent-1",
                "toolName": "Bash",
                "toolInput": {}
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        assert_eq!(result.events[0].parent_tool_use_id(), Some("parent-1"));
        assert_eq!(
            result.events[0].raw_json()["parent_tool_use_id"],
            "parent-1"
        );
    }
    #[test]
    fn pending_first_sight_emits_content_block_start_only() {
        let mut idx = EventIndexer::default();
        let result = map_tool_call_start(
            &json!({
                "toolCallId": "t-pending",
                "toolName": "Bash",
                "status": "pending",
                "toolInput": { "command": "echo hi" }
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        assert!(matches!(
            result.events[0].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart { .. })
        ));
    }
    #[test]
    fn start_routes_raw_input_through_normalize_hook() {
        let mut idx = EventIndexer::default();
        let result = map_tool_call_start(
            &json!({
                "toolCallId": "t-raw",
                "toolName": "Bash",
                "rawInput": { "foo": 1, "nested": { "bar": [1, 2] } }
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        match result.events[0].stream_event().unwrap() {
            RuntimeStreamEvent::ContentBlockStart {
                block: RuntimeContentBlock::ToolUse { input, .. },
                ..
            } => {
                assert_eq!(input["foo"], 1);
                assert_eq!(input["nested"]["bar"][0], 1);
                assert_eq!(input["nested"]["bar"][1], 2);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn start_falls_back_to_tool_input_when_raw_input_empty() {
        let mut idx = EventIndexer::default();
        let result = map_tool_call_start(
            &json!({
                "toolCallId": "t-bash",
                "toolName": "Bash",
                "rawInput": {},
                "toolInput": { "command": "ls -la" }
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        match result.events[0].stream_event().unwrap() {
            RuntimeStreamEvent::ContentBlockStart {
                block: RuntimeContentBlock::ToolUse { input, .. },
                ..
            } => {
                assert_eq!(input["command"], "ls -la");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn start_does_not_propagate_sub_agent_session_id_as_parent() {
        let mut idx = EventIndexer::default();
        let result = map_tool_call_start(
            &json!({
                "toolCallId": "child-sas",
                "subAgentSessionId": "sub-session-9",
                "toolName": "Bash",
                "toolInput": {}
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        assert!(result.events[0].parent_tool_use_id().is_none());
    }
    #[test]
    fn nested_chain_sets_child_parent_to_parent_tool_use_id() {
        let mut idx = EventIndexer::default();
        let parent_start = map_tool_call_start(
            &json!({
                "toolCallId": "task-parent",
                "toolName": "Task",
                "toolInput": { "prompt": "do thing" }
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        let parent_id = match parent_start.events[0].stream_event().unwrap() {
            RuntimeStreamEvent::ContentBlockStart {
                block: RuntimeContentBlock::ToolUse { id, .. },
                ..
            } => id.clone(),
            other => panic!("unexpected: {other:?}"),
        };
        assert!(parent_start.events[0].parent_tool_use_id().is_none());
        let child_start = map_tool_call_start(
            &json!({
                "toolCallId": "child-bash",
                "parentToolCallId": parent_id.clone(),
                "toolName": "Bash",
                "toolInput": { "command": "ls" }
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        assert_eq!(
            child_start.events[0].parent_tool_use_id(),
            Some(parent_id.as_str())
        );
        let child_done = map_tool_call_update(
            &json!({
                "toolCallId": "child-bash",
                "parentToolCallId": parent_id.clone(),
                "status": "completed",
                "content": [ { "type": "text", "text": "done" } ]
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        for event in &child_done.events {
            assert_eq!(event.parent_tool_use_id(), Some(parent_id.as_str()));
        }
    }
}
