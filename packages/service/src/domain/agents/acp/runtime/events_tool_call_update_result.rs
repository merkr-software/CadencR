use super::events_stream_blocks::EventIndexer;
use super::events_tool_call_result::{tool_result_event, tool_result_event_from_raw_output};
use super::provider_hooks::AcpProviderHooks;
use crate::domain::agents::adapter::{RuntimeEvent, RuntimeEventMetadata};
use serde_json::Value;

pub fn push_tool_result(
    body: &Value,
    tool_call_id: &str,
    status: &str,
    parent: Option<String>,
    metadata: RuntimeEventMetadata,
    hooks: &dyn AcpProviderHooks,
    indexer: &mut EventIndexer,
    events: &mut Vec<RuntimeEvent>,
) {
    let suppressed = indexer
        .tool_name_for(tool_call_id)
        .map(|name| hooks.suppresses_raw_output(name))
        .unwrap_or(false);
    if suppressed {
        return;
    }
    if push_terminal_result(
        body,
        tool_call_id,
        status,
        parent.as_deref(),
        &metadata,
        indexer,
        events,
    ) {
        return;
    }
    if let Some(raw_output) = body.get("rawOutput").cloned() {
        let is_error = matches!(status, "failed");
        let mut event =
            tool_result_event_from_raw_output(tool_call_id, raw_output, is_error, metadata);
        event.set_parent_tool_use_id(parent);
        events.push(event);
        return;
    }
    let Some(content) = body.get("content").and_then(Value::as_array) else {
        return;
    };
    if content.is_empty() {
        return;
    }
    let is_error = matches!(status, "failed");
    let mut event = tool_result_event(tool_call_id, content, is_error, metadata, hooks);
    event.set_parent_tool_use_id(parent);
    events.push(event);
}

fn push_terminal_result(
    body: &Value,
    tool_call_id: &str,
    status: &str,
    parent: Option<&str>,
    metadata: &RuntimeEventMetadata,
    indexer: &mut EventIndexer,
    events: &mut Vec<RuntimeEvent>,
) -> bool {
    let terminal = body.get("_meta");
    let delta = terminal
        .and_then(|meta| meta.get("terminal_output"))
        .and_then(|output| output.get("data"))
        .and_then(Value::as_str);
    let terminal_exit = terminal.and_then(|meta| meta.get("terminal_exit"));
    let exit_code = terminal_exit
        .and_then(|exit| exit.get("exit_code"))
        .and_then(Value::as_i64);
    let signal = terminal_exit
        .and_then(|exit| exit.get("signal"))
        .and_then(Value::as_i64);
    let completed = matches!(status, "completed" | "failed");
    let accumulated = indexer.has_terminal_output(tool_call_id);
    if delta.is_none() && terminal_exit.is_none() && !(completed && accumulated) {
        return false;
    }
    if let Some(delta) = delta {
        indexer.append_terminal_output(tool_call_id, delta);
    }
    if !completed && terminal_exit.is_none() {
        return true;
    }
    let (mut output, truncated) = indexer
        .take_terminal_output(tool_call_id)
        .unwrap_or_default();
    if truncated {
        output.push_str("\n[terminal output truncated]");
    }
    let is_error =
        status == "failed" || exit_code.is_some_and(|code| code != 0) || signal.is_some();
    let mut event = tool_result_event_from_raw_output(
        tool_call_id,
        Value::String(output),
        is_error,
        metadata.clone(),
    );
    event.set_parent_tool_use_id(parent.map(ToOwned::to_owned));
    events.push(event);
    true
}
