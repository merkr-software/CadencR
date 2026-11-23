use cadencr_provider_sdk::meta::SubagentStatus;
use serde_json::{json, Value};

use super::ChildJournal;
use crate::events::session_update;

const MAX_SUMMARY_CHARS: usize = 2048;

impl ChildJournal {
    pub(super) fn start_action(
        &self,
        root: &str,
        id: &str,
        name: &str,
        args: Option<&Value>,
    ) -> Value {
        let mut update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": id,
            "parentToolCallId": self.child.carrier,
            "title": name,
            "name": name,
            "kind": "other",
            "status": "in_progress"
        });
        if let Some(args) = args.filter(|args| args.is_object()) {
            update["rawInput"] = args.clone();
        }
        session_update(root, update)
    }

    pub(super) fn action_result(
        &self,
        root: &str,
        id: &str,
        outcome: SubagentStatus,
        output: Option<&str>,
    ) -> Value {
        let status = match outcome {
            SubagentStatus::Completed => "completed",
            SubagentStatus::Failed | SubagentStatus::Cancelled => "failed",
        };
        let mut update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": id,
            "parentToolCallId": self.child.carrier,
            "status": status,
        });
        if let Some(output) = output {
            update["rawOutput"] = json!(output);
        }
        session_update(root, update)
    }

    pub(super) fn finish(
        &self,
        root: &str,
        outcome: SubagentStatus,
        summary: Option<&str>,
    ) -> Value {
        let summary = summary
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| text.chars().take(MAX_SUMMARY_CHARS).collect::<String>());
        self.update(root, Some(outcome), summary.as_deref())
    }

    pub(super) fn update(
        &self,
        root: &str,
        status: Option<SubagentStatus>,
        summary: Option<&str>,
    ) -> Value {
        session_update(
            root,
            json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": self.child.carrier,
                "_meta": self.usage.metadata(status, summary)
            }),
        )
    }
}
