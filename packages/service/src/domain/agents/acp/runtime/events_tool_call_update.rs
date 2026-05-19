use super::events_stream_blocks::EventIndexer;
use super::events_tool_call::{other_event, MappedUpdate};
use super::events_tool_call_input::synthesize_input_delta_event;
use super::events_tool_call_parent::parent_tool_use_id;
use super::events_tool_call_update_result::push_tool_result;
use super::provider_hooks::AcpProviderHooks;
use super::stream_events::stream_stop_event;
use crate::domain::agents::adapter::RuntimeEventMetadata;
use serde_json::Value;
pub fn map_tool_call_update(
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
    let status = body.get("status").and_then(Value::as_str).unwrap_or("");
    if indexer.is_tool_call_suppressed(tool_call_id) {
        return MappedUpdate { events: vec![] };
    }
    let mut events = Vec::new();
    let index = indexer.index_for_tool(tool_call_id);
    let parent = parent_tool_use_id(body);
    if indexer.tool_name_for(tool_call_id) == Some("AskUserQuestion") {
        if let Some(event) = hooks.tool_call_update_override(
            tool_call_id,
            body,
            status,
            &metadata,
            parent.as_deref(),
            indexer,
        ) {
            return MappedUpdate {
                events: vec![event],
            };
        }
    }
    if let Some(delta_event) = synthesize_input_delta_event(
        tool_call_id,
        index,
        body,
        parent.clone(),
        indexer,
        metadata.clone(),
        hooks,
    ) {
        events.push(delta_event);
    }
    push_tool_result(
        body,
        tool_call_id,
        status,
        parent.clone(),
        metadata.clone(),
        hooks,
        indexer,
        &mut events,
    );
    if matches!(status, "completed" | "failed") {
        let event = stream_stop_event(
            metadata.session_id.as_deref().unwrap_or(""),
            index,
            parent.as_deref(),
        );
        events.push(event);
    } else if events.is_empty() {
        events.push(other_event(metadata.clone()));
    }
    if status == "completed" {
        let tool_name = indexer
            .tool_name_for(tool_call_id)
            .map(ToOwned::to_owned)
            .unwrap_or_default();
        let extra = hooks.synthesize_tool_call_completion(
            tool_call_id,
            &tool_name,
            body,
            status,
            &metadata,
            indexer,
        );
        events.extend(extra);
    }
    MappedUpdate { events }
}
#[cfg(test)]
mod tests {
    use super::map_tool_call_update;
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::adapter::{
        RuntimeEventMetadata, RuntimePermissionMode, RuntimeStreamEvent, RuntimeUserContentBlock,
    };
    use serde_json::{json, Value};
    struct PlainHooks;
    #[async_trait::async_trait]
    impl AcpProviderHooks for PlainHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }
        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
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
    fn completed_update_emits_result_then_stop() {
        let mut idx = EventIndexer::default();
        let _ = idx.index_for_tool("t-1");
        let result = map_tool_call_update(
            &json!({
                "toolCallId": "t-1",
                "status": "completed",
                "content": [ { "type": "text", "text": "ok" } ]
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 2);
        assert!(result.events[0].user_message().is_some());
        assert!(matches!(
            result.events[1].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStop { .. })
        ));
    }
    #[test]
    fn failed_update_marks_tool_result_as_error() {
        let mut idx = EventIndexer::default();
        let _ = idx.index_for_tool("t-2");
        let result = map_tool_call_update(
            &json!({
                "toolCallId": "t-2",
                "status": "failed",
                "content": [ { "type": "text", "text": "boom" } ]
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        let user = result.events[0].user_message().unwrap();
        match &user.content[0] {
            RuntimeUserContentBlock::ToolResult { is_error, .. } => assert!(*is_error),
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn in_progress_update_with_content_emits_result_but_no_stop() {
        let mut idx = EventIndexer::default();
        let _ = idx.index_for_tool("t-progress");
        let result = map_tool_call_update(
            &json!({
                "toolCallId": "t-progress",
                "status": "in_progress",
                "content": [ { "type": "text", "text": "halfway" } ]
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        assert!(result.events.iter().any(|e| e.user_message().is_some()));
        assert!(!result.events.iter().any(|e| matches!(
            e.stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStop { .. })
        )));
    }
    #[test]
    fn update_without_status_does_not_auto_stop() {
        let mut idx = EventIndexer::default();
        let _ = idx.index_for_tool("t-no-status");
        let result = map_tool_call_update(
            &json!({
                "toolCallId": "t-no-status",
                "content": [ { "type": "text", "text": "tick" } ]
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        assert!(!result.events.iter().any(|e| matches!(
            e.stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStop { .. })
        )));
    }
    #[test]
    fn update_with_raw_output_preserves_json_shape() {
        let mut idx = EventIndexer::default();
        let _ = idx.index_for_tool("t-raw-out");
        let result = map_tool_call_update(
            &json!({
                "toolCallId": "t-raw-out",
                "status": "completed",
                "rawOutput": { "ok": true, "items": [1, 2, 3] }
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        let user = result
            .events
            .iter()
            .find_map(|e| e.user_message())
            .expect("user message");
        match &user.content[0] {
            RuntimeUserContentBlock::ToolResult { content, .. } => {
                assert_eq!(content["ok"], true);
                assert_eq!(content["items"][2], 3);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn generic_tool_update_with_late_raw_input_emits_input_delta() {
        let mut idx = EventIndexer::default();
        idx.record_tool_name("t-read", "Read");
        let _ = idx.index_for_tool("t-read");
        let result = map_tool_call_update(
            &json!({
                "toolCallId": "t-read",
                "status": "completed",
                "rawInput": { "file_path": "packages/service/src/main.rs" },
                "content": [ { "type": "text", "text": "file contents" } ]
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        let partial = result
            .events
            .iter()
            .find_map(|event| match event.stream_event()? {
                RuntimeStreamEvent::ContentBlockDelta { delta, .. } => match delta {
                    crate::domain::agents::adapter::RuntimeContentDelta::InputJson {
                        partial_json,
                    } => Some(partial_json.as_str()),
                    _ => None,
                },
                _ => None,
            });
        assert_eq!(
            partial,
            Some(r#"{"file_path":"packages/service/src/main.rs"}"#)
        );
    }
    struct SynthesisHooks;
    #[async_trait::async_trait]
    impl AcpProviderHooks for SynthesisHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }
        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }
        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            None
        }
        fn suppresses_raw_output(&self, tool_name: &str) -> bool {
            tool_name == "Suppressed"
        }
        fn synthesize_tool_call_completion(
            &self,
            tool_call_id: &str,
            tool_name: &str,
            _body: &Value,
            _status: &str,
            metadata: &RuntimeEventMetadata,
            _indexer: &mut EventIndexer,
        ) -> Vec<crate::domain::agents::adapter::RuntimeEvent> {
            if tool_name != "Suppressed" {
                return Vec::new();
            }
            vec![crate::domain::agents::adapter::RuntimeEvent::new(
                metadata.clone(),
                crate::domain::agents::adapter::RuntimeEventKind::AssistantMessage {
                    message: crate::domain::agents::adapter::RuntimeAssistantMessage {
                        model: None,
                        content: vec![crate::domain::agents::adapter::RuntimeContentBlock::Text {
                            text: "synth".to_string(),
                        }],
                    },
                    parent_tool_use_id: Some(tool_call_id.to_string()),
                },
            )]
        }
    }
    #[test]
    fn suppresses_raw_output_drops_default_tool_result_for_marked_tools() {
        let mut idx = EventIndexer::default();
        idx.record_tool_name("t-supp", "Suppressed");
        let result = map_tool_call_update(
            &json!({
                "toolCallId": "t-supp",
                "status": "completed",
                "rawOutput": { "noisy": "json" }
            }),
            &mut idx,
            metadata(),
            &SynthesisHooks,
        );
        assert!(
            result.events.iter().all(|e| e.user_message().is_none()),
            "rawOutput tool_result should be suppressed"
        );
        assert!(
            result
                .events
                .iter()
                .any(|e| e.parent_tool_use_id() == Some("t-supp")),
            "synthesised completion event should be appended"
        );
    }
    #[test]
    fn unsuppressed_tools_still_emit_raw_output_and_completion_hook_does_not_fire() {
        let mut idx = EventIndexer::default();
        idx.record_tool_name("t-keep", "Bash");
        let result = map_tool_call_update(
            &json!({
                "toolCallId": "t-keep",
                "status": "completed",
                "rawOutput": { "ok": true }
            }),
            &mut idx,
            metadata(),
            &SynthesisHooks,
        );
        let user = result
            .events
            .iter()
            .find_map(|e| e.user_message())
            .expect("user message present for non-suppressed tool");
        match &user.content[0] {
            RuntimeUserContentBlock::ToolResult { content, .. } => {
                assert_eq!(content["ok"], true);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn update_inherits_parent_tool_use_id_from_parent_tool_call_id() {
        let mut idx = EventIndexer::default();
        let _ = idx.index_for_tool("child-x");
        let result = map_tool_call_update(
            &json!({
                "toolCallId": "child-x",
                "parentToolCallId": "task-parent",
                "status": "completed",
                "content": [ { "type": "text", "text": "done" } ]
            }),
            &mut idx,
            metadata(),
            &PlainHooks,
        );
        for event in &result.events {
            assert_eq!(event.parent_tool_use_id(), Some("task-parent"));
        }
    }
}
