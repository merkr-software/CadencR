//! Sub-agents that run again after they ended.
//!
//! The parent resumes one with `SendMessage` (CLI 2.1.312). Its result names
//! the agent: `resumedAgentId` when the caller owns it, `revivedAgentId`
//! whenever the agent was not answered inline. The agent's own messages keep
//! the original carrier as their parent, and the task queue reports the new
//! end under the same `task_id` but with the `SendMessage` call's
//! `tool_use_id`. A failed, stopped or completed run is therefore not final:
//! a resume runs it again and its next end settles it.
//!
//! The resume can happen in a later runtime than the launch, because the CLI
//! revives the agent from its transcript. A new runtime is therefore seeded
//! with the carriers and task ids the registry remembers.

use serde_json::Value;

use super::{CarrierPhase, ClaudeSubagentState, TaskEntry};
use crate::domain::agents::adapter::{
    non_empty_str, KnownSubagent, RuntimeSubagentPatch, RuntimeSubagentStatus,
    RuntimeSubagentUpdate,
};

impl ClaudeSubagentState {
    /// Runs earlier runtimes launched. They have ended, so they only run
    /// again when the CLI says so (a `SendMessage` resume, a running task).
    pub(super) fn seed(&mut self, known: Vec<KnownSubagent>) {
        for run in known {
            self.carriers
                .entry(run.tool_use_id.clone())
                .or_insert(CarrierPhase::Notified);
            self.remember_task(run.child_session_id, &run.tool_use_id);
        }
    }

    /// Record which carrier the CLI's `task_id` (its agent id) belongs to.
    /// The latest fact wins: a later carrier for the same agent replaces it.
    pub(super) fn remember_task(&mut self, task_id: String, tool_use_id: &str) {
        let entry = self
            .tasks
            .entry(task_id)
            .or_insert_with(|| TaskEntry::new(tool_use_id));
        if entry.tool_use_id != tool_use_id {
            *entry = TaskEntry::new(tool_use_id);
        }
    }

    /// A `SendMessage` result (call `call_id`) that resumed one of this
    /// conversation's agents.
    pub(super) fn observe_resume(
        &mut self,
        call_id: &str,
        structured: &Value,
    ) -> Option<RuntimeSubagentUpdate> {
        let agent_id = resumed_agent_id(structured)?;
        let entry = self.tasks.get_mut(&agent_id)?;
        let tool_use_id = entry.tool_use_id.clone();
        let phase = self.carriers.get_mut(&tool_use_id)?;
        *phase = CarrierPhase::Live;
        entry.resumed_by = Some(call_id.to_string());
        // The one exception to keeping handed-back reports: an earlier report
        // belongs to the run that ended, not to the resumed one.
        self.handbacks.remove(&tool_use_id);
        let patch = RuntimeSubagentPatch {
            status: Some(RuntimeSubagentStatus::Running),
            // `SendMessage` returns at once: the parent's turn no longer waits for it.
            background: Some(true),
            ..RuntimeSubagentPatch::default()
        };
        Some(RuntimeSubagentUpdate::new(tool_use_id, patch))
    }
}

fn resumed_agent_id(structured: &Value) -> Option<String> {
    if structured.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    ["resumedAgentId", "revivedAgentId"]
        .iter()
        .find_map(|key| structured.get(*key).and_then(non_empty_str))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::resumed_agent_id;

    #[test]
    fn reads_the_agent_a_send_message_resumed() {
        // CLI 2.1.312 `SendMessage` result for a revived background agent.
        let result = json!({ "success": true, "message": "Resuming agent a79a490",
            "resumedAgentId": "a79a4904016cfcbe9", "revivedAgentId": "a79a4904016cfcbe9" });
        assert_eq!(
            resumed_agent_id(&result).as_deref(),
            Some("a79a4904016cfcbe9")
        );
        let not_owned = json!({ "success": true, "revivedAgentId": "a1" });
        assert_eq!(resumed_agent_id(&not_owned).as_deref(), Some("a1"));
    }

    #[test]
    fn ignores_failed_and_queued_messages() {
        assert_eq!(
            resumed_agent_id(&json!({ "success": false, "revivedAgentId": "a1" })),
            None
        );
        let queued = json!({ "success": true,
            "message": "a1 is already waking; message queued for its next tool round" });
        assert_eq!(resumed_agent_id(&queued), None);
    }
}
