use serde_json::Value;

pub(super) use super::event_command_execution::{
    command_execution_events, command_output_delta_event,
};
use super::event_inputs::{
    collab_tool_input, collab_tool_name, dynamic_tool_input, dynamic_tool_name, file_input,
};
use super::event_json::{
    compact_event, input_json_delta_event, metadata, runtime_stream_event, thread_id, user_raw,
};
use super::event_mcp_items::mcp_tool_item;
use super::event_payloads::{
    parse_file_patch_updated_params, parse_item_params, parse_tool_json_delta_params,
};
use super::event_plan_item::plan_item;
use super::event_reasoning::reasoning_item_event;
use super::event_state::IndexState;
use super::event_subagent_activity::subagent_activity_events;
use super::event_subagents::{
    agent_tool_block, synthesize_subagent_messages, synthesize_subagent_prompt,
};
use crate::domain::agents::adapter::{
    RuntimeContentBlock, RuntimeEvent, RuntimeEventKind, RuntimeStreamEvent,
    RuntimeTurnStartedSource, RuntimeUserContentBlock, RuntimeUserMessage,
};

fn item(params: &Value) -> Option<&Value> {
    params.get("item")
}

pub(super) fn item_type(params: &Value) -> Option<&str> {
    item(params)
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
}

fn item_id(item: &Value) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .unwrap_or("codex_item")
        .to_string()
}

pub(super) fn item_events(
    params: Value,
    completed: bool,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let parsed = match parse_item_params(params) {
        Ok(params) => params,
        Err(error) => {
            tracing::warn!(%error, "malformed Codex item event");
            return Vec::new();
        }
    };
    let item_value = parsed.item.as_value();
    let item_type = parsed.item.item_type.clone();
    if item_type == "subAgentActivity" {
        return subagent_activity_events(parsed.thread_id(), &parsed.item, index_state);
    }
    let params = parsed.into_raw();
    match item_type.as_str() {
        "agentMessage" => text_item(params, completed, index_state),
        // Codex has emitted both casings while the plan item API is settling.
        "plan" | "Plan" => plan_item(params, completed, index_state),
        "reasoning" => reasoning_item_event(params, completed, index_state),
        "commandExecution" => command_execution_events(params, completed, index_state),
        "fileChange" => tool_item(params, "ApplyPatch", file_input, completed, index_state),
        "mcpToolCall" => mcp_tool_item(params, completed, index_state),
        "dynamicToolCall" => {
            let name = dynamic_tool_name(&item_value);
            tool_item(params, &name, dynamic_tool_input, completed, index_state)
        }
        "collabAgentToolCall" => {
            let name = collab_tool_name(&item_value);
            // Record the new sub-agent thread BEFORE delegating, so that any
            // events that arrive for the spawned thread between `item/started`
            // and `item/completed` get their `parent_tool_use_id` stamped via
            // `notification_events`' post-processing.
            record_subagent_thread_for_collab_call(&item_value, &name, index_state);
            if name == "Agent" {
                return spawn_agent_collab_events(params, completed, index_state);
            }
            // Snapshot params/item before consuming `params` for `tool_item`
            // so we can extract any agentsStates messages on completion (the
            // wait/close collab tool_results carry the sub-agent's final
            // output here, not on a separate stream).
            let params_snapshot = if completed {
                Some(params.clone())
            } else {
                None
            };
            let mut events = tool_item(params, &name, collab_tool_input, completed, index_state);
            if let Some(params_snapshot) = params_snapshot {
                if let Some(item_snapshot) = params_snapshot.get("item") {
                    events.extend(synthesize_subagent_messages(
                        &params_snapshot,
                        item_snapshot,
                        index_state,
                    ));
                }
            }
            events
        }
        "contextCompaction" => {
            if completed {
                vec![compact_event(params)]
            } else {
                vec![context_compaction_started_event(params)]
            }
        }
        _ => Vec::new(),
    }
}

fn context_compaction_started_event(params: Value) -> RuntimeEvent {
    let sid = thread_id(&params).to_string();
    RuntimeEvent::turn_started_signal(Some(sid), RuntimeTurnStartedSource::ContextCompaction, None)
}

pub(super) fn tool_json_delta_event(
    params: Value,
    field: &str,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let params = match parse_tool_json_delta_params(params) {
        Ok(params) => params,
        Err(error) => {
            tracing::warn!(%error, "malformed Codex tool JSON delta event");
            return Vec::new();
        }
    };
    let value = params.delta_value();
    let partial_json = serde_json::to_string(&serde_json::json!({ field: value }))
        .unwrap_or_else(|_| "{}".to_string());
    input_json_delta_event(params.raw(), &params.item_id, partial_json, index_state)
}

pub(super) fn file_patch_updated_event(
    params: Value,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let params = match parse_file_patch_updated_params(params) {
        Ok(params) => params,
        Err(error) => {
            tracing::warn!(%error, "malformed Codex file patch update event");
            return Vec::new();
        }
    };
    let raw_params = params.raw();
    let item_id = params.item_id.clone();
    let input = file_input(&serde_json::json!({
        "changes": params.changes_value().unwrap_or(Value::Null),
    }));
    let partial_json = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
    input_json_delta_event(raw_params, &item_id, partial_json, index_state)
}

fn text_item(params: Value, completed: bool, index_state: &mut IndexState) -> Vec<RuntimeEvent> {
    content_item(
        params,
        RuntimeContentBlock::Text {
            text: String::new(),
        },
        completed,
        index_state,
    )
}

fn content_item(
    params: Value,
    block: RuntimeContentBlock,
    completed: bool,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let Some(item) = item(&params) else {
        return Vec::new();
    };
    let sid = thread_id(&params).to_string();
    let index = index_state.index_for(&item_id(item));
    let event = if completed {
        RuntimeStreamEvent::ContentBlockStop { index }
    } else {
        RuntimeStreamEvent::ContentBlockStart { index, block }
    };
    vec![runtime_stream_event(&sid, event)]
}

fn tool_item(
    params: Value,
    name: &str,
    input_fn: fn(&Value) -> Value,
    completed: bool,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let input = {
        let Some(item) = item(&params) else {
            return Vec::new();
        };
        input_fn(item)
    };
    tool_item_with_input(params, name, input, completed, index_state)
}

fn tool_item_with_input(
    params: Value,
    name: &str,
    input: Value,
    completed: bool,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let Some(item) = item(&params) else {
        return Vec::new();
    };
    let item_id = item_id(item);
    let id = index_state.canonical_id(&item_id);
    if completed {
        let mut events = Vec::new();
        if !index_state.has_index(&item_id) {
            let sid = thread_id(&params).to_string();
            let block = RuntimeContentBlock::ToolUse {
                id: id.clone(),
                name: name.to_string(),
                input: input.clone(),
            };
            events.push(stream_start_event(
                &sid,
                index_state.index_for(&item_id),
                block,
            ));
        }
        if index_state.record_result(&id) {
            events.push(tool_result_event(&params, id, input));
        }
        return events;
    }
    if index_state.has_index(&item_id) {
        return Vec::new();
    }
    let sid = thread_id(&params).to_string();
    let block = RuntimeContentBlock::ToolUse {
        id: id.clone(),
        name: name.to_string(),
        input,
    };
    vec![stream_start_event(
        &sid,
        index_state.index_for(&item_id),
        block,
    )]
}

pub(super) fn stream_start_event(
    session_id: &str,
    index: u64,
    block: RuntimeContentBlock,
) -> RuntimeEvent {
    runtime_stream_event(
        session_id,
        RuntimeStreamEvent::ContentBlockStart { index, block },
    )
}

fn tool_result_event(params: &Value, id: String, input: Value) -> RuntimeEvent {
    let is_error = input.get("error").is_some_and(|error| !error.is_null());
    tool_result_event_with_error(params, id, input, is_error)
}

pub(super) fn tool_result_event_with_error(
    params: &Value,
    id: String,
    content: Value,
    is_error: bool,
) -> RuntimeEvent {
    let sid = thread_id(params).to_string();
    RuntimeEvent::new(
        metadata(
            &sid,
            user_raw(
                &sid,
                None,
                vec![serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "is_error": is_error,
                    "content": content,
                })],
            ),
        ),
        RuntimeEventKind::UserMessage {
            message: RuntimeUserMessage {
                content: vec![RuntimeUserContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    is_error,
                    content,
                }],
            },
            parent_tool_use_id: None,
        },
    )
}

/// Specialized `spawn_agent` collab handler with cleaned input and no JSON-dump result.
fn spawn_agent_collab_events(
    params: Value,
    completed: bool,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let Some(item) = item(&params) else {
        return Vec::new();
    };
    let item_id = item_id(item);
    let canonical_id = index_state.canonical_id(&item_id);
    let session_id = thread_id(&params).to_string();

    let mut events = Vec::new();
    if !index_state.has_index(&item_id) {
        let block = agent_tool_block(&canonical_id, item);
        events.push(stream_start_event(
            &session_id,
            index_state.index_for(&item_id),
            block,
        ));
    }
    if let Some(prompt_event) =
        synthesize_subagent_prompt(&session_id, &canonical_id, item, index_state)
    {
        events.push(prompt_event);
    }
    if completed {
        // Lock the canonical id so a late raw function_call_output (which
        // arrives on the same call_id) can't sneak the bookkeeping JSON
        // back in through the raw path's tool_result emission.
        index_state.record_result(&canonical_id);
        events.extend(synthesize_subagent_messages(&params, item, index_state));
    }
    events
}

/// Record every spawned threadId under the spawning `Agent` call's id.
fn record_subagent_thread_for_collab_call(
    item: &Value,
    canonical_tool_name: &str,
    index_state: &mut IndexState,
) {
    if canonical_tool_name != "Agent" {
        return;
    }
    let raw_id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("codex_item");
    // Pre-resolve the canonical id so every harvested threadId points at
    // the same tool_use_id the frontend uses to nest child blocks.
    let canonical = index_state.canonical_id(raw_id);

    if let Some(new_thread_id) = item.get("newThreadId").and_then(Value::as_str) {
        index_state.record_subagent_thread(new_thread_id, &canonical);
    }
    if let Some(receivers) = item.get("receiverThreadIds").and_then(Value::as_array) {
        for receiver in receivers {
            if let Some(tid) = receiver.as_str() {
                index_state.record_subagent_thread(tid, &canonical);
            }
        }
    }
    if let Some(states) = item.get("agentsStates").and_then(Value::as_object) {
        for tid in states.keys() {
            index_state.record_subagent_thread(tid, &canonical);
        }
    }
}
