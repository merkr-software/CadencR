//! Sub-agent facts carried by OpenCode's terminal `task` tool update.
//!
//! OpenCode suppresses the task tool's raw output (see `adapter.rs`), so the
//! shared tracker never sees a tool_result for it. Its terminal
//! `tool_call_update` still carries everything the registry needs
//! (`tool/task.ts`, `acp/tool.ts` in opencode 1.19):
//!
//! - completed: `rawOutput = {output, metadata}` where `output` is
//!   `<task id="…" state="completed|running">…<task_result>…</task_result></task>`
//!   and `metadata = {parentSessionId, sessionId, model: {providerID, modelID},
//!   background?, jobId?}`. A background launch (or a foreground task promoted
//!   to the background) completes the tool call at once with `state="running"`.
//! - failed: `rawOutput = {error, metadata}`; the shared runtime records the
//!   failure and its reason, this module adds the child session and model.

use serde_json::Value;

use crate::domain::agents::adapter::{
    non_empty_str, summarize_subagent_result, RuntimeSubagentPatch, RuntimeSubagentStatus,
    RuntimeSubagentUpdate,
};

/// What a terminal task update says about its sub-agent.
pub(super) struct TaskCompletion {
    /// Still running after the tool call returned (background launch).
    pub background: bool,
    pub update: RuntimeSubagentUpdate,
}

impl TaskCompletion {
    /// `body_text` is the task's cleaned `<task_result>` body, when any.
    pub(super) fn read(
        tool_call_id: &str,
        body: &Value,
        status: &str,
        body_text: Option<&str>,
    ) -> Self {
        let raw_output = body.get("rawOutput");
        let metadata = raw_output.and_then(|output| output.get("metadata"));
        let background = status == "completed"
            && (metadata
                .and_then(|metadata| metadata.get("background"))
                .and_then(Value::as_bool)
                == Some(true)
                || raw_output
                    .and_then(|output| output.get("output"))
                    .and_then(Value::as_str)
                    .and_then(task_state)
                    == Some("running"));
        let mut patch = RuntimeSubagentPatch {
            child_session_id: metadata
                .and_then(|metadata| metadata.get("sessionId"))
                .and_then(non_empty_str),
            model: metadata
                .and_then(|metadata| metadata.get("model"))
                .and_then(model_ref),
            ..RuntimeSubagentPatch::default()
        };
        patch.model_resolved = patch.model.is_some();
        if background {
            patch.status = Some(RuntimeSubagentStatus::Running);
            patch.background = Some(true);
        } else if status == "completed" {
            patch.status = Some(RuntimeSubagentStatus::Completed);
            patch.result_summary = body_text.and_then(summarize_subagent_result);
        }
        Self {
            background,
            update: RuntimeSubagentUpdate::new(tool_call_id, patch),
        }
    }
}

/// `providerID/modelID`, the same spelling the child messages' model uses.
pub(super) fn model_ref(value: &Value) -> Option<String> {
    let provider = value.get("providerID").and_then(non_empty_str)?;
    let model = value.get("modelID").and_then(non_empty_str)?;
    Some(format!("{provider}/{model}"))
}

/// `state` attribute of the leading `<task id="…" state="…">` element.
fn task_state(output: &str) -> Option<&str> {
    let open = output.trim_start().strip_prefix("<task ")?;
    let open = &open[..open.find('>')?];
    let state = &open[open.find("state=\"")? + "state=\"".len()..];
    Some(&state[..state.find('"')?])
}

#[cfg(test)]
mod tests {
    use super::{task_state, TaskCompletion};
    use crate::domain::agents::adapter::RuntimeSubagentStatus;
    use serde_json::json;

    #[test]
    fn foreground_completion_reports_child_model_and_summary() {
        // `completedToolUpdate` for the task tool (opencode acp/tool.ts + tool/task.ts).
        let body = json!({
            "toolCallId": "call_task",
            "status": "completed",
            "title": "Audit auth",
            "rawOutput": {
                "output": "<task id=\"ses_child\" state=\"completed\">\n<task_result>\nFound 2 issues\n</task_result>\n</task>",
                "metadata": {
                    "parentSessionId": "ses_root",
                    "sessionId": "ses_child",
                    "model": { "providerID": "anthropic", "modelID": "claude-haiku-5-5" }
                }
            }
        });
        let completion =
            TaskCompletion::read("call_task", &body, "completed", Some("Found 2 issues"));
        assert!(!completion.background);
        let patch = completion.update.patch;
        assert_eq!(completion.update.tool_use_id, "call_task");
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Completed));
        assert_eq!(patch.child_session_id.as_deref(), Some("ses_child"));
        assert_eq!(patch.model.as_deref(), Some("anthropic/claude-haiku-5-5"));
        assert!(patch.model_resolved);
        assert_eq!(patch.result_summary.as_deref(), Some("Found 2 issues"));
    }

    #[test]
    fn background_launch_stays_running() {
        let body = json!({
            "status": "completed",
            "rawOutput": {
                "output": "<task id=\"ses_bg\" state=\"running\">\n<summary>Background task started</summary>\n<task_result>\nThe task is working in the background.\n</task_result>\n</task>",
                "metadata": {
                    "sessionId": "ses_bg",
                    "model": { "providerID": "openai", "modelID": "gpt-6.1" },
                    "background": true,
                    "jobId": "ses_bg"
                }
            }
        });
        let completion = TaskCompletion::read("call_bg", &body, "completed", Some("working"));
        assert!(completion.background);
        let patch = completion.update.patch;
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Running));
        assert_eq!(patch.background, Some(true));
        assert_eq!(patch.result_summary, None);
        // A promoted task without the metadata flag is read off the output.
        let promoted = json!({
            "rawOutput": { "output": "<task id=\"ses_p\" state=\"running\">\n<task_result>\nx\n</task_result>\n</task>" }
        });
        assert!(TaskCompletion::read("call_p", &promoted, "completed", None).background);
    }

    #[test]
    fn failure_adds_metadata_and_leaves_status_to_the_runtime() {
        // `errorToolUpdate`: rawOutput {error, metadata} (opencode acp/tool.ts).
        let body = json!({
            "status": "failed",
            "rawOutput": {
                "error": "Subagent failed (task_id: ses_child): rate limited",
                "metadata": { "sessionId": "ses_child", "model": { "providerID": "x", "modelID": "y" } }
            }
        });
        let completion = TaskCompletion::read("call_task", &body, "failed", None);
        assert!(!completion.background);
        assert_eq!(completion.update.patch.status, None);
        assert_eq!(
            completion.update.patch.child_session_id.as_deref(),
            Some("ses_child")
        );
        assert_eq!(completion.update.patch.model.as_deref(), Some("x/y"));
        let bare =
            TaskCompletion::read("call_task", &json!({ "status": "failed" }), "failed", None);
        assert!(bare.update.patch.is_empty());
    }

    #[test]
    fn task_state_reads_the_envelope_only() {
        assert_eq!(
            task_state("<task id=\"a\" state=\"error\">\n</task>"),
            Some("error")
        );
        assert_eq!(
            task_state("<task_result>\nstate=\"running\"\n</task_result>"),
            None
        );
        assert_eq!(
            task_state("task_id: ses\n\n<task_result>x</task_result>"),
            None
        );
    }
}
