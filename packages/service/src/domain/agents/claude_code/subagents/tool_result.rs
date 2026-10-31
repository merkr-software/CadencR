//! The Agent tool's structured result: the `tool_use_result` the CLI puts on
//! the user message that carries the carrier's tool_result.
//!
//! Shapes (CLI 2.1.312 Agent tool `call()` returns; `AgentOutput` in the agent
//! SDK 0.3.156 `sdk-tools.d.ts` lacks `resolvedModel`):
//!
//! - background launch ack: `{isAsync: true, status: "async_launched", agentId,
//!   description, resolvedModel, modelsUsed?, prompt, outputFile,
//!   canReadOutputFile, canContinueAgent}` — also what a foreground agent
//!   returns when it is moved to the background mid-run.
//! - remote launch ack: `{status: "remote_launched", taskId, sessionUrl,
//!   description, prompt, outputFile}`.
//! - foreground completion: `{status: "completed", prompt, agentId, agentType,
//!   content: [{type: "text", text}], resolvedModel, modelsUsed?,
//!   totalDurationMs, totalTokens, totalToolUseCount, usage, toolStats}`.

use serde_json::Value;

use crate::domain::agents::adapter::{
    non_empty_str, subagent_result_text, summarize_subagent_result, RuntimeSubagentPatch,
    RuntimeSubagentStatus,
};

#[derive(Debug, Clone, PartialEq)]
pub(super) enum AgentToolResult {
    /// The tool returned at launch while the agent keeps running detached.
    Launched(RuntimeSubagentPatch),
    /// The agent ran to completion inside the tool call.
    Completed(RuntimeSubagentPatch),
    /// Not a shape we read (an error string, a teammate spawn…).
    Other,
}

pub(super) fn parse_agent_tool_result(value: &Value) -> AgentToolResult {
    match value.get("status").and_then(Value::as_str) {
        Some("async_launched") => AgentToolResult::Launched(RuntimeSubagentPatch {
            child_session_id: text(value, "agentId"),
            ..launched_patch(text(value, "resolvedModel"))
        }),
        Some("remote_launched") => AgentToolResult::Launched(RuntimeSubagentPatch {
            child_session_id: text(value, "taskId"),
            ..launched_patch(None)
        }),
        Some("completed") => AgentToolResult::Completed(RuntimeSubagentPatch {
            agent_type: text(value, "agentType"),
            child_session_id: text(value, "agentId"),
            model_resolved: text(value, "resolvedModel").is_some(),
            model: text(value, "resolvedModel"),
            duration_ms: value.get("totalDurationMs").and_then(Value::as_u64),
            total_tokens: value.get("totalTokens").and_then(Value::as_u64),
            tool_use_count: value.get("totalToolUseCount").and_then(Value::as_u64),
            result_summary: summarize_subagent_result(&report_text(value.get("content"))),
            ..RuntimeSubagentPatch::default()
        }),
        _ => AgentToolResult::Other,
    }
}

/// A launch ack is not a completion: the agent runs on in the background.
fn launched_patch(resolved_model: Option<String>) -> RuntimeSubagentPatch {
    RuntimeSubagentPatch {
        status: Some(RuntimeSubagentStatus::Running),
        background: Some(true),
        model_resolved: resolved_model.is_some(),
        model: resolved_model,
        ..RuntimeSubagentPatch::default()
    }
}

fn report_text(content: Option<&Value>) -> String {
    content.map(subagent_result_text).unwrap_or_default()
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(non_empty_str)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse_agent_tool_result, AgentToolResult};
    use crate::domain::agents::adapter::RuntimeSubagentStatus;

    #[test]
    fn async_launch_ack_keeps_the_agent_running_in_background() {
        let result = parse_agent_tool_result(&json!({
            "isAsync": true, "status": "async_launched", "agentId": "a8f3c2",
            "description": "Audit codex", "resolvedModel": "claude-haiku-5-5",
            "prompt": "Look at codex", "outputFile": "/tmp/tasks/a8f3c2.output",
            "canReadOutputFile": true, "canContinueAgent": true
        }));
        let AgentToolResult::Launched(patch) = result else {
            panic!("expected a launch ack, got {result:?}");
        };
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Running));
        assert_eq!(patch.background, Some(true));
        assert_eq!(patch.child_session_id.as_deref(), Some("a8f3c2"));
        assert_eq!(patch.model.as_deref(), Some("claude-haiku-5-5"));
        assert!(patch.model_resolved);
        assert_eq!(patch.result_summary, None);
    }

    #[test]
    fn async_launch_ack_without_model_reports_none() {
        let AgentToolResult::Launched(patch) = parse_agent_tool_result(&json!({
            "status": "async_launched", "agentId": "a1", "description": "d", "prompt": "p",
            "outputFile": ""
        })) else {
            panic!("expected a launch ack");
        };
        assert_eq!(patch.model, None);
        assert!(!patch.model_resolved);
    }

    #[test]
    fn remote_launch_ack_uses_the_task_id() {
        let AgentToolResult::Launched(patch) = parse_agent_tool_result(&json!({
            "status": "remote_launched", "taskId": "r7k2", "sessionUrl": "https://claude.ai/code/s",
            "description": "Remote audit", "prompt": "p", "outputFile": "/tmp/r7k2"
        })) else {
            panic!("expected a launch ack");
        };
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Running));
        assert_eq!(patch.background, Some(true));
        assert_eq!(patch.child_session_id.as_deref(), Some("r7k2"));
    }

    #[test]
    fn foreground_completion_carries_totals_and_report() {
        let result = parse_agent_tool_result(&json!({
            "status": "completed", "prompt": "Look at codex", "agentId": "a8f3c2",
            "agentType": "Explore",
            "content": [{ "type": "text", "text": "Found 3 issues" }],
            "resolvedModel": "claude-haiku-5-5", "totalDurationMs": 4210,
            "totalTokens": 18342, "totalToolUseCount": 7,
            "usage": { "input_tokens": 10, "output_tokens": 20,
                "cache_creation_input_tokens": null, "cache_read_input_tokens": null,
                "server_tool_use": null, "service_tier": null, "cache_creation": null },
            "canContinueAgent": true
        }));
        let AgentToolResult::Completed(patch) = result else {
            panic!("expected a completion, got {result:?}");
        };
        // The derived tool_result status stands; the provider adds the facts.
        assert_eq!(patch.status, None);
        assert_eq!(patch.agent_type.as_deref(), Some("Explore"));
        assert_eq!(patch.child_session_id.as_deref(), Some("a8f3c2"));
        assert_eq!(patch.model.as_deref(), Some("claude-haiku-5-5"));
        assert!(patch.model_resolved);
        assert_eq!(patch.duration_ms, Some(4210));
        assert_eq!(patch.total_tokens, Some(18342));
        assert_eq!(patch.tool_use_count, Some(7));
        assert_eq!(patch.result_summary.as_deref(), Some("Found 3 issues"));
    }

    #[test]
    fn errors_and_other_shapes_are_not_read() {
        assert_eq!(
            parse_agent_tool_result(&json!("Error: agent type not found")),
            AgentToolResult::Other
        );
        assert_eq!(
            parse_agent_tool_result(&json!({"status": "teammate_spawned", "agentId": "t1"})),
            AgentToolResult::Other
        );
    }
}
