//! Sub-agent facts for Cursor's task tool (`taskToolCall`, mapped to `Agent`).
//!
//! cursor-agent 2026.10.22 (`src/acp/*` in its bundle) reports a finished
//! task as a `completed` `tool_call_update` whatever happened, with
//! `rawOutput` `{durationMs, isBackground}` on success or `{error}` on
//! failure, then sends a `cursor/task` notification
//! `{toolCallId, description, prompt, subagentType, model, agentId,
//! durationMs}` where `subagentType` is a known type string, `"unspecified"`,
//! or `{custom: name}`.

use serde_json::Value;

use crate::domain::agents::acp::runtime::events_tool_call_subagent::failure_reason;
use crate::domain::agents::adapter::{
    non_empty_str, RuntimeEvent, RuntimeSubagentPatch, RuntimeSubagentStatus, RuntimeSubagentUpdate,
};

/// The real terminal status hidden behind Cursor's always-`completed` update.
pub(super) fn completion_events(
    tool_call_id: &str,
    tool_name: &str,
    body: &Value,
) -> Vec<RuntimeEvent> {
    if tool_name != "Agent" {
        return Vec::new();
    }
    let raw_output = body.get("rawOutput");
    let field = |key: &str| raw_output.and_then(|output| output.get(key));
    let mut patch = RuntimeSubagentPatch::default();
    if field("error").is_some_and(|error| !error.is_null()) {
        patch.status = Some(RuntimeSubagentStatus::Failed);
        patch.status_reason = failure_reason(body);
    } else if field("isBackground").and_then(Value::as_bool) == Some(true) {
        // Launched in the background: the tool call returned, the agent runs on.
        patch.status = Some(RuntimeSubagentStatus::Running);
        patch.background = Some(true);
    } else if raw_output.is_some() {
        patch.status = Some(RuntimeSubagentStatus::Completed);
        patch.duration_ms = field("durationMs").and_then(Value::as_u64);
    }
    if patch.is_empty() {
        return Vec::new();
    }
    vec![RuntimeEvent::subagent_signal(vec![
        RuntimeSubagentUpdate::new(tool_call_id, patch),
    ])]
}

/// What `cursor/task` says about the sub-agent beyond the `Agent` tool_use
/// it becomes, whose input already gives the tracker its description, prompt
/// and type. `None` without a real `toolCallId`: the transcript block then
/// falls back to a synthetic id that names no sub-agent.
pub(super) fn task_notification_update(params: &Value) -> Option<RuntimeSubagentUpdate> {
    let tool_call_id = params
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())?;
    let text = |key: &str| params.get(key).and_then(non_empty_str);
    let model = text("model");
    let patch = RuntimeSubagentPatch {
        model_resolved: model.is_some(),
        model,
        child_session_id: text("agentId"),
        duration_ms: params.get("durationMs").and_then(Value::as_u64),
        ..RuntimeSubagentPatch::default()
    };
    (!patch.is_empty()).then(|| RuntimeSubagentUpdate::new(tool_call_id, patch))
}

/// `"explore"`, `{custom: "reviewer"}` → the agent's name; `"unspecified"`
/// names none.
pub(super) fn subagent_type(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let name = value
        .as_str()
        .or_else(|| value.get("custom").and_then(Value::as_str))?
        .trim();
    (!name.is_empty() && name != "unspecified").then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::{completion_events, subagent_type, task_notification_update};
    use crate::domain::agents::adapter::RuntimeSubagentStatus;
    use serde_json::json;

    fn patch_of(body: serde_json::Value) -> crate::domain::agents::adapter::RuntimeSubagentPatch {
        let events = completion_events("tool-task-1", "Agent", &body);
        assert_eq!(events.len(), 1);
        assert!(events[0].is_subagent_signal_only());
        assert_eq!(events[0].subagent_updates()[0].tool_use_id, "tool-task-1");
        events[0].subagent_updates()[0].patch.clone()
    }

    #[test]
    fn error_output_fails_despite_the_completed_status() {
        let patch = patch_of(json!({
            "toolCallId": "tool-task-1",
            "status": "completed",
            "rawOutput": { "error": "Subagent hit the usage limit" }
        }));
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(
            patch.status_reason.as_deref(),
            Some("Subagent hit the usage limit")
        );
    }

    #[test]
    fn success_reports_duration_and_background_keeps_running() {
        let done = patch_of(json!({
            "status": "completed",
            "rawOutput": { "durationMs": 42_500, "isBackground": false }
        }));
        assert_eq!(done.status, Some(RuntimeSubagentStatus::Completed));
        assert_eq!(done.duration_ms, Some(42_500));
        let background = patch_of(json!({
            "status": "completed",
            "rawOutput": { "isBackground": true }
        }));
        assert_eq!(background.status, Some(RuntimeSubagentStatus::Running));
        assert_eq!(background.background, Some(true));
        assert_eq!(background.duration_ms, None);
    }

    #[test]
    fn ordinary_tools_and_bare_updates_add_nothing() {
        assert!(
            completion_events("t", "Bash", &json!({ "rawOutput": { "error": "x" } })).is_empty()
        );
        assert!(completion_events("t", "Agent", &json!({ "status": "completed" })).is_empty());
    }

    #[test]
    fn task_notification_describes_the_run() {
        let update = task_notification_update(&json!({
            "toolCallId": "tool-task-1",
            "description": "Explore auth",
            "prompt": "Map the auth flow",
            "subagentType": { "custom": "reviewer" },
            "model": "composer-2.5",
            "agentId": "agent-7f3",
            "durationMs": 1200
        }))
        .expect("update");
        assert_eq!(update.tool_use_id, "tool-task-1");
        let patch = update.patch;
        // The `Agent` tool_use carries these to the tracker.
        assert_eq!(patch.agent_type, None);
        assert_eq!(patch.description, None);
        assert_eq!(patch.prompt, None);
        assert_eq!(patch.model.as_deref(), Some("composer-2.5"));
        assert!(patch.model_resolved);
        assert_eq!(patch.child_session_id.as_deref(), Some("agent-7f3"));
        assert_eq!(patch.duration_ms, Some(1200));
    }

    #[test]
    fn task_notification_without_a_tool_call_id_patches_nothing() {
        assert!(task_notification_update(&json!({ "description": "Explore" })).is_none());
        assert!(task_notification_update(&json!({ "toolCallId": " ", "prompt": "p" })).is_none());
        assert!(
            task_notification_update(&json!({ "toolCallId": "t", "description": "Explore" }))
                .is_none()
        );
    }

    #[test]
    fn subagent_type_names_known_custom_and_unspecified() {
        assert_eq!(
            subagent_type(Some(&json!("explore"))).as_deref(),
            Some("explore")
        );
        assert_eq!(
            subagent_type(Some(&json!({ "custom": "qa" }))).as_deref(),
            Some("qa")
        );
        assert_eq!(subagent_type(Some(&json!("unspecified"))), None);
        assert_eq!(subagent_type(None), None);
    }
}
