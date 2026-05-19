use super::events_stream_blocks::EventIndexer;
use super::provider_hooks::AcpProviderHooks;
use super::stream_events::stream_delta_event;
use crate::domain::agents::adapter::{RuntimeContentDelta, RuntimeEvent, RuntimeEventMetadata};
use serde_json::{json, Value};
pub(super) fn is_structured_input_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "Write"
            | "Edit"
            | "MultiEdit"
            | "NotebookEdit"
            | "ApplyPatch"
            | "Bash"
            | "Task"
            | "Agent"
            | "TodoWrite"
    )
}
pub(super) fn synthesize_input_delta_event(
    tool_call_id: &str,
    index: u64,
    body: &Value,
    parent_tool_use_id: Option<String>,
    indexer: &mut EventIndexer,
    metadata: RuntimeEventMetadata,
    hooks: &dyn AcpProviderHooks,
) -> Option<RuntimeEvent> {
    let tool_name = indexer.tool_name_for(tool_call_id)?.to_string();
    let raw_input = body
        .get("rawInput")
        .filter(|v| !is_empty_value(v))
        .or_else(|| body.get("toolInput"))
        .cloned();
    let derived_input = match raw_input {
        Some(value) if !is_empty_value(&value) => value,
        _ if is_structured_input_tool(&tool_name) => derive_input_from_content(&tool_name, body)?,
        _ => return None,
    };
    let normalized = hooks.normalize_tool_input(&tool_name, derived_input);
    indexer.record_tool_input(tool_call_id, normalized.clone());
    let partial_json = serde_json::to_string(&normalized).ok()?;
    let event = stream_delta_event(
        metadata.session_id.as_deref().unwrap_or(""),
        index,
        RuntimeContentDelta::InputJson { partial_json },
        parent_tool_use_id.as_deref(),
    );
    Some(event)
}
pub(super) fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Object(map) => map.is_empty(),
        Value::Array(arr) => arr.is_empty(),
        _ => false,
    }
}
pub(super) fn derive_input_from_content(tool_name: &str, body: &Value) -> Option<Value> {
    if matches!(tool_name, "Task" | "Agent") {
        return derive_subagent_input_from_content(body);
    }
    if !matches!(tool_name, "Write" | "Edit" | "MultiEdit" | "ApplyPatch") {
        return None;
    }
    let content = body.get("content").and_then(Value::as_array)?;
    let diffs: Vec<DiffEntry> = content.iter().filter_map(extract_diff_entry).collect();
    if diffs.is_empty() {
        return None;
    }
    if tool_name == "MultiEdit" {
        let file_path = diffs[0].path.clone();
        let edits: Vec<Value> = diffs
            .into_iter()
            .map(|d| {
                json!({
                    "old_string": d.old_text,
                    "new_string": d.new_text,
                })
            })
            .collect();
        return Some(json!({
            "file_path": file_path,
            "edits": edits,
        }));
    }
    let first = diffs.into_iter().next()?;
    if tool_name == "Write" {
        return Some(json!({
            "file_path": first.path,
            "content": first.new_text,
        }));
    }
    Some(json!({
        "file_path": first.path,
        "old_string": first.old_text,
        "new_string": first.new_text,
    }))
}
fn derive_subagent_input_from_content(body: &Value) -> Option<Value> {
    let content = body.get("content").and_then(Value::as_array)?;
    for entry in content {
        if let Some(input) = subagent_input_from_entry(entry) {
            return Some(input);
        }
    }
    None
}
fn subagent_input_from_entry(entry: &Value) -> Option<Value> {
    if let (Some(description), Some(prompt)) = (
        entry.get("description").and_then(Value::as_str),
        entry.get("prompt").and_then(Value::as_str),
    ) {
        return Some(json!({
            "description": description,
            "prompt": prompt,
        }));
    }
    let kind = entry.get("type").and_then(Value::as_str)?;
    match kind {
        "text" => entry
            .get("text")
            .and_then(Value::as_str)
            .map(subagent_input_from_text),
        "content" => entry.get("content").and_then(subagent_input_from_entry),
        _ => None,
    }
}
fn subagent_input_from_text(text: &str) -> Value {
    let description = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Sub-agent")
        .to_string();
    json!({
        "description": description,
        "prompt": text,
    })
}
struct DiffEntry {
    path: String,
    old_text: String,
    new_text: String,
}
fn extract_diff_entry(entry: &Value) -> Option<DiffEntry> {
    if entry.get("type").and_then(Value::as_str) != Some("diff") {
        return None;
    }
    let path = entry
        .get("path")
        .or_else(|| entry.get("filePath"))
        .and_then(Value::as_str)?
        .to_string();
    let old_text = entry
        .get("oldText")
        .or_else(|| entry.get("old_string"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let new_text = entry
        .get("newText")
        .or_else(|| entry.get("new_string"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(DiffEntry {
        path,
        old_text,
        new_text,
    })
}
#[cfg(test)]
mod tests {
    use super::{
        derive_input_from_content, is_empty_value, is_structured_input_tool,
        synthesize_input_delta_event,
    };
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::adapter::{
        RuntimeContentDelta, RuntimeEventMetadata, RuntimePermissionMode, RuntimeStreamEvent,
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
            json!(blocks)
        }
        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            None
        }
    }
    #[test]
    fn is_structured_input_tool_recognises_diff_and_bash_tools() {
        for name in ["Write", "Edit", "Bash"] {
            assert!(is_structured_input_tool(name), "{name}");
        }
        assert!(!is_structured_input_tool("Read"));
    }
    #[test]
    fn is_empty_value_treats_empty_objects_and_arrays_as_empty() {
        assert!(is_empty_value(&Value::Null));
        assert!(is_empty_value(&json!({})));
        assert!(is_empty_value(&json!([])));
    }
    #[test]
    fn derive_input_from_diff_content_synthesises_write_input() {
        let body = json!({
            "content": [
                { "type": "diff", "path": "/x/acp-test.txt", "oldText": "", "newText": "hello" }
            ]
        });
        let derived = derive_input_from_content("Write", &body).unwrap();
        assert_eq!(derived["file_path"], "/x/acp-test.txt");
        assert_eq!(derived["content"], "hello");
        assert!(derived.get("old_string").is_none());
    }
    #[test]
    fn derive_input_from_diff_content_synthesises_edit_input() {
        let body = json!({
            "content": [
                { "type": "diff", "path": "/x/file.txt", "oldText": "a", "newText": "b" }
            ]
        });
        let derived = derive_input_from_content("Edit", &body).unwrap();
        assert_eq!(derived["file_path"], "/x/file.txt");
        assert_eq!(derived["old_string"], "a");
        assert_eq!(derived["new_string"], "b");
    }
    #[test]
    fn derive_input_from_diff_content_collects_all_multi_edit_entries() {
        let body = json!({
            "content": [
                { "type": "diff", "path": "/x/file.txt", "oldText": "a", "newText": "b" },
                { "type": "diff", "path": "/x/file.txt", "oldText": "c", "newText": "d" },
            ]
        });
        let derived = derive_input_from_content("MultiEdit", &body).unwrap();
        assert_eq!(derived["file_path"], "/x/file.txt");
        let edits = derived["edits"].as_array().expect("edits array");
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0]["old_string"], "a");
        assert_eq!(edits[0]["new_string"], "b");
        assert_eq!(edits[1]["old_string"], "c");
        assert_eq!(edits[1]["new_string"], "d");
    }
    #[test]
    fn derive_input_returns_none_for_non_file_tools() {
        let body = json!({
            "content": [
                { "type": "diff", "path": "/x", "newText": "x" }
            ]
        });
        assert!(derive_input_from_content("Bash", &body).is_none());
        assert!(derive_input_from_content("Read", &body).is_none());
    }
    #[test]
    fn derive_input_pulls_description_and_prompt_for_task() {
        let body = json!({
            "content": [
                { "description": "Explore backend", "prompt": "Look at packages/service" }
            ]
        });
        let derived = derive_input_from_content("Task", &body).expect("derived");
        assert_eq!(derived["description"], "Explore backend");
        assert_eq!(derived["prompt"], "Look at packages/service");
        let derived = derive_input_from_content("Agent", &body).expect("derived");
        assert_eq!(derived["description"], "Explore backend");
    }
    #[test]
    fn derive_input_synthesises_task_input_from_text_block() {
        let body = json!({
            "content": [
                { "type": "text", "text": "Explore backend\n\nDetails follow…" }
            ]
        });
        let derived = derive_input_from_content("Task", &body).expect("derived");
        assert_eq!(derived["description"], "Explore backend");
        assert_eq!(derived["prompt"], "Explore backend\n\nDetails follow…");
    }
    #[test]
    fn derive_input_unwraps_opencode_content_envelope_for_task() {
        let body = json!({
            "content": [
                { "type": "content", "content": { "type": "text", "text": "Spawn explore" } }
            ]
        });
        let derived = derive_input_from_content("Task", &body).expect("derived");
        assert_eq!(derived["description"], "Spawn explore");
        assert_eq!(derived["prompt"], "Spawn explore");
    }
    #[test]
    fn derive_input_returns_none_for_task_with_diff_only_content() {
        let body = json!({
            "content": [
                { "type": "diff", "path": "/x", "newText": "x" }
            ]
        });
        assert!(derive_input_from_content("Task", &body).is_none());
    }
    #[test]
    fn synthesize_returns_none_when_tool_name_is_unrecorded() {
        let mut idx = EventIndexer::default();
        let body = json!({ "toolInput": { "command": "ls" } });
        assert!(synthesize_input_delta_event(
            "t-1",
            0,
            &body,
            None,
            &mut idx,
            RuntimeEventMetadata::default(),
            &PlainHooks,
        )
        .is_none());
    }
    #[test]
    fn synthesize_returns_none_for_non_structured_tools_without_raw_input() {
        let mut idx = EventIndexer::default();
        idx.record_tool_name("t-2", "Read");
        let body = json!({ "content": [{ "type": "text", "text": "file" }] });
        assert!(synthesize_input_delta_event(
            "t-2",
            0,
            &body,
            None,
            &mut idx,
            RuntimeEventMetadata::default(),
            &PlainHooks,
        )
        .is_none());
    }
    #[test]
    fn synthesize_emits_input_json_delta_from_explicit_tool_input() {
        let mut idx = EventIndexer::default();
        idx.record_tool_name("t-3", "Bash");
        let body = json!({ "toolInput": { "command": "ls -la" } });
        let event = synthesize_input_delta_event(
            "t-3",
            7,
            &body,
            None,
            &mut idx,
            RuntimeEventMetadata::default(),
            &PlainHooks,
        )
        .expect("event");
        match event.stream_event().unwrap() {
            RuntimeStreamEvent::ContentBlockDelta {
                index,
                delta: RuntimeContentDelta::InputJson { partial_json },
            } => {
                assert_eq!(*index, 7);
                let parsed: Value = serde_json::from_str(partial_json).unwrap();
                assert_eq!(parsed["command"], "ls -la");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn synthesize_falls_back_to_diff_content_for_write() {
        let mut idx = EventIndexer::default();
        idx.record_tool_name("t-4", "Write");
        let body = json!({
            "toolInput": {},
            "content": [
                { "type": "diff", "path": "/repo/file.txt", "newText": "hello" }
            ]
        });
        let event = synthesize_input_delta_event(
            "t-4",
            3,
            &body,
            None,
            &mut idx,
            RuntimeEventMetadata::default(),
            &PlainHooks,
        )
        .expect("event");
        match event.stream_event().unwrap() {
            RuntimeStreamEvent::ContentBlockDelta {
                delta: RuntimeContentDelta::InputJson { partial_json },
                ..
            } => {
                let parsed: Value = serde_json::from_str(partial_json).unwrap();
                assert_eq!(parsed["file_path"], "/repo/file.txt");
                assert_eq!(parsed["content"], "hello");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
}
