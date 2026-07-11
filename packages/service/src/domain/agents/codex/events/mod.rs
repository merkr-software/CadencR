use serde_json::Value;

mod signals;
mod subagents;
// Overflow tests for the `collabAgentToolCall` wire path. Split out of the
// inline test module only to keep every file under the 400-line cap.
#[cfg(test)]
mod subagents_collab;

use self::signals::{result_event, text_delta_event, turn_started_event};
use self::subagents::apply_subagent_parent_tool_use_id;
use super::event_items::{
    command_output_delta_event, file_patch_updated_event, item_events, tool_json_delta_event,
};
use super::event_json::compact_event;
use super::event_plan::plan_updated_event;
use super::event_raw::raw_response_item_events;
use super::event_reasoning::reasoning_delta_event;
use super::event_state::IndexState;
use super::event_subagent_routes::register_thread_started_route;
use super::event_usage::usage_event;
use crate::domain::agents::adapter::RuntimeEvent;

pub fn notification_events(
    method: &str,
    params: Value,
    model: Option<&str>,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    // Codex multi-agent v2 announces a child thread separately from the raw
    // `spawn_agent` function call. Join those notifications before routing
    // this event so the child's very first streamed item is nested correctly.
    register_thread_started_route(method, &params, index_state);

    let subagent_parent_tool_use_id = if index_state.has_any_subagents() {
        params
            .get("threadId")
            .and_then(Value::as_str)
            .and_then(|thread_id| index_state.subagent_parent_tool_use_id(thread_id))
            .map(ToOwned::to_owned)
    } else {
        None
    };

    if method == "turn/completed" && subagent_parent_tool_use_id.is_some() {
        return Vec::new();
    }

    let mut events = dispatch_notification(method, params, model, index_state);
    if let Some(parent_tool_use_id) = subagent_parent_tool_use_id {
        apply_subagent_parent_tool_use_id(&mut events, &parent_tool_use_id);
    }
    events
}

fn dispatch_notification(
    method: &str,
    params: Value,
    model: Option<&str>,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    match method {
        "turn/started" => turn_started_event(params, model).into_iter().collect(),
        "turn/completed" => vec![result_event(params)],
        "thread/tokenUsage/updated" => vec![usage_event(params)],
        "thread/compacted" => vec![compact_event(params)],
        "turn/plan/updated" => vec![plan_updated_event(params, index_state)],
        "item/commandExecution/outputDelta" | "command/exec/outputDelta" => {
            command_output_delta_event(params, index_state)
        }
        "item/fileChange/outputDelta" => tool_json_delta_event(params, "output", index_state),
        "item/fileChange/patchUpdated" => file_patch_updated_event(params, index_state),
        "item/mcpToolCall/progress" => tool_json_delta_event(params, "progress", index_state),
        "item/started" => item_events(params, false, index_state),
        "item/completed" => item_events(params, true, index_state),
        "rawResponseItem/completed" => raw_response_item_events(params, index_state),
        "item/agentMessage/delta" => text_delta_event(params, model, index_state),
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            reasoning_delta_event(params, model, index_state)
        }
        _ => Vec::new(),
    }
}

pub fn turn_id_from_started(params: &Value) -> Option<String> {
    params
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::super::event_state::IndexState;
    use super::notification_events;
    use crate::domain::agents::adapter::{
        RuntimeEvent, RuntimeStreamEvent, RuntimeUserContentBlock,
    };
    use serde_json::json;

    fn map_events(method: &str, params: serde_json::Value) -> Vec<RuntimeEvent> {
        let mut indexes = IndexState::default();
        notification_events(method, params, None, &mut indexes)
    }

    #[test]
    fn tool_completion_without_start_emits_call_then_result() {
        let events = map_events(
            "item/completed",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd",
                    "command": "pwd",
                    "status": "completed"
                }
            }),
        );
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart { .. })
        ));
        assert!(events[1].user_message().is_some());
    }

    #[test]
    fn command_action_item_does_not_emit_completed_bash_fallback() {
        let mut indexes = IndexState::default();
        let started = notification_events(
            "item/started",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd",
                    "command": "/bin/zsh -lc 'cat /etc/hosts'",
                    "commandActions": [{ "type": "read", "path": "/etc/hosts" }]
                }
            }),
            None,
            &mut indexes,
        );
        let completed = notification_events(
            "item/completed",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd",
                    "command": "/bin/zsh -lc 'cat /etc/hosts'",
                    "status": "completed"
                }
            }),
            None,
            &mut indexes,
        );

        assert!(matches!(
            started[0].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart {
                block: crate::domain::agents::adapter::RuntimeContentBlock::ToolUse { name, .. },
                ..
            }) if name == "Read"
        ));
        assert!(completed.is_empty());
    }

    #[test]
    fn tool_start_emits_tool_use() {
        let events = map_events(
            "item/started",
            json!({
                "threadId": "thread",
                "item": { "type": "fileChange", "id": "patch", "changes": [] }
            }),
        );
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart { .. })
        ));
    }

    #[test]
    fn command_output_delta_without_visible_command_is_suppressed() {
        let events = map_events(
            "item/commandExecution/outputDelta",
            json!({
                "threadId": "thread",
                "itemId": "cmd",
                "delta": "new chunk",
                "aggregatedOutput": "old\nnew chunk"
            }),
        );

        assert!(events.is_empty());
    }

    #[test]
    fn turn_plan_updated_emits_todowrite_tool() {
        let events = map_events(
            "turn/plan/updated",
            json!({
                "threadId": "thread",
                "turnId": "turn_1",
                "plan": [
                    { "step": "Read code", "status": "completed" },
                    { "step": "Patch code", "status": "inProgress" }
                ]
            }),
        );

        let Some(RuntimeStreamEvent::ContentBlockStart { block, .. }) = events[0].stream_event()
        else {
            panic!("expected TodoWrite start");
        };
        let crate::domain::agents::adapter::RuntimeContentBlock::ToolUse { name, input, .. } =
            block
        else {
            panic!("expected tool use");
        };
        assert_eq!(name, "TodoWrite");
        assert_eq!(input["todos"][0]["status"], "completed");
        assert_eq!(input["todos"][1]["status"], "in_progress");
    }

    #[test]
    fn plan_item_emits_visible_approval_gate() {
        let events = map_events(
            "item/completed",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "Plan",
                    "id": "plan_1",
                    "text": "## Proposed plan"
                }
            }),
        );

        assert_eq!(events.len(), 2);
        let Some(RuntimeStreamEvent::ContentBlockStart { block, .. }) = events[0].stream_event()
        else {
            panic!("expected ExitPlanMode block");
        };
        let crate::domain::agents::adapter::RuntimeContentBlock::ToolUse {
            id, name, input, ..
        } = block
        else {
            panic!("expected tool use");
        };
        assert_eq!(id, "codex_plan_approval_plan_1");
        assert_eq!(name, "ExitPlanMode");
        assert_eq!(input["plan"], "## Proposed plan");
        assert_eq!(events[1].raw_json()["type"], "codex_permission_request");
        assert_eq!(
            events[1].raw_json()["request_id"],
            "codex_plan_approval_plan_1"
        );
        assert_eq!(events[1].raw_json()["tool_name"], "ExitPlanMode");
    }

    #[test]
    fn plan_start_waits_for_completed_text() {
        let events = map_events(
            "item/started",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "Plan",
                    "id": "plan_1"
                }
            }),
        );

        assert!(events.is_empty());
    }

    #[test]
    fn context_compaction_start_does_not_emit_divider() {
        let events = map_events(
            "item/started",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "contextCompaction",
                    "id": "compact_1"
                }
            }),
        );

        assert_eq!(events.len(), 1);
        assert!(!events[0].is_compact_boundary());
    }

    #[test]
    fn context_compaction_start_emits_provider_turn_started_signal() {
        let events = map_events(
            "item/started",
            json!({
                "threadId": "thread",
                "turnId": "turn_compact",
                "item": {
                    "type": "contextCompaction",
                    "id": "compact_1"
                }
            }),
        );

        assert_eq!(events.len(), 1);
        assert_eq!(
            crate::domain::session_status::provider_signal_for_event(&events[0]),
            Some(crate::domain::session_status::ProviderSignal::TurnStarted)
        );
        assert!(events[0].stream_event().is_none());
        assert!(!events[0].is_compact_boundary());
    }

    #[test]
    fn context_compaction_completion_emits_single_divider_with_metadata() {
        let events = map_events(
            "item/completed",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "contextCompaction",
                    "id": "compact_1",
                    "trigger": "manual",
                    "preTokens": 90_000
                }
            }),
        );

        assert_eq!(events.len(), 1);
        assert!(events[0].is_compact_boundary());
        let metadata = events[0].compact_metadata().expect("compact metadata");
        assert_eq!(metadata.trigger.as_deref(), Some("manual"));
        assert_eq!(metadata.pre_tokens, Some(90_000));
    }

    #[test]
    fn null_mcp_error_is_successful_tool_result() {
        let events = map_events(
            "item/completed",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "mcpToolCall",
                    "id": "tool",
                    "server": "cadencr-browser",
                    "tool": "browser_open_url",
                    "error": null,
                    "result": { "ok": true }
                }
            }),
        );
        let message = events
            .iter()
            .find_map(RuntimeEvent::user_message)
            .expect("expected tool result");
        let RuntimeUserContentBlock::ToolResult { is_error, .. } = &message.content[0] else {
            panic!("expected tool result block");
        };
        assert!(!is_error);
    }
}
