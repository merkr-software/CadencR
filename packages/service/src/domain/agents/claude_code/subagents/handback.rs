//! Claude CLI 2.1.31x hands a sub-agent's report back through a
//! `SubagentHandback` tool call the sub-agent makes (`{message}`). The
//! carrier's tool_result (foreground) or the task notification's summary
//! (background) then only points at that call ("This agent's report was
//! delivered to you as a message from …"), so the report has to be read off
//! the child call and kept until the run settles.

use crate::domain::agents::adapter::{
    non_empty_str, summarize_subagent_result, RuntimeSubagentPatch,
};

const HANDBACK_TOOL_NAME: &str = "SubagentHandback";

/// The report a sub-agent's message hands back, if it makes that call.
pub(super) fn handback_report(content: &[claude_agent_sdk_rs::ContentBlock]) -> Option<String> {
    content.iter().rev().find_map(|block| {
        let claude_agent_sdk_rs::ContentBlock::ToolUse { name, input, .. } = block else {
            return None;
        };
        if name != HANDBACK_TOOL_NAME {
            return None;
        }
        input.get("message").and_then(non_empty_str)
    })
}

/// The handed-back report replaces the pointer the CLI reports instead, and
/// the CLI's tool-use count stops counting the handback call itself.
pub(super) fn apply_handback(patch: &mut RuntimeSubagentPatch, report: Option<String>) {
    let Some(report) = report.and_then(|report| summarize_subagent_result(&report)) else {
        return;
    };
    patch.result_summary = Some(report);
    patch.tool_use_count = patch.tool_use_count.map(|count| count.saturating_sub(1));
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::handback_report;

    fn blocks(value: serde_json::Value) -> Vec<claude_agent_sdk_rs::ContentBlock> {
        serde_json::from_value(value).expect("valid content blocks")
    }

    #[test]
    fn reads_the_handback_message() {
        let content = blocks(json!([
            { "type": "text", "text": "Wrapping up." },
            { "type": "tool_use", "id": "t1", "name": "SubagentHandback",
              "input": { "message": "  Found 3 adapters.  " } }
        ]));
        assert_eq!(
            handback_report(&content).as_deref(),
            Some("Found 3 adapters.")
        );
    }

    #[test]
    fn ignores_other_tools_and_empty_messages() {
        let content = blocks(json!([
            { "type": "tool_use", "id": "t1", "name": "Read", "input": { "message": "no" } },
            { "type": "tool_use", "id": "t2", "name": "SubagentHandback", "input": { "message": " " } }
        ]));
        assert_eq!(handback_report(&content), None);
    }
}
