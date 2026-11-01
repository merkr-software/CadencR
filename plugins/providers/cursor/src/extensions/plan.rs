//! `cursor/create_plan` → an `ExitPlanMode` tool call plus a plan gate.

use serde_json::{json, Value};

use super::todos::normalized_todos;
use super::HostDecision;

pub const APPROVE_OPTION_ID: &str = "approve";
pub const FOLLOWUP_PROMPT: &str = "Plan approved. Proceed with execution.";

pub fn tool_input(params: &Value) -> Value {
    json!({
        "plan": params.get("plan").and_then(Value::as_str).unwrap_or(""),
        "name": params.get("name"),
        "overview": params.get("overview"),
        "todos": normalized_todos(params),
        "isProject": params.get("isProject"),
        "phases": params.get("phases"),
    })
}

pub fn title(params: &Value) -> String {
    params
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Plan")
        .to_string()
}

/// Cursor's native accepted / rejected response schema.
pub fn response(decision: &HostDecision) -> Value {
    if decision.approved {
        return json!({ "outcome": { "outcome": "accepted" } });
    }
    json!({
        "outcome": {
            "outcome": "rejected",
            "reason": decision.feedback.as_deref().unwrap_or("Plan rejected by user"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{response, title, tool_input};
    use crate::extensions::HostDecision;
    use serde_json::json;

    #[test]
    fn plan_becomes_exit_plan_mode_input() {
        let params = json!({
            "toolCallId": "call-plan",
            "plan": "1. Inspect\n2. Edit",
            "todos": [{ "id": "1", "content": "Inspect", "status": "completed" }]
        });
        let input = tool_input(&params);
        assert_eq!(input["plan"], "1. Inspect\n2. Edit");
        assert_eq!(input["todos"][0]["status"], "completed");
        assert_eq!(title(&params), "Plan");
        assert_eq!(title(&json!({ "name": "Auth refactor" })), "Auth refactor");
    }

    #[test]
    fn decision_uses_cursor_response_schema() {
        let approved = HostDecision {
            approved: true,
            ..HostDecision::default()
        };
        assert_eq!(response(&approved)["outcome"]["outcome"], "accepted");
        let rejected = HostDecision {
            feedback: Some("Split it".to_string()),
            ..HostDecision::default()
        };
        assert_eq!(response(&rejected)["outcome"]["outcome"], "rejected");
        assert_eq!(response(&rejected)["outcome"]["reason"], "Split it");
        assert_eq!(
            response(&HostDecision::default())["outcome"]["reason"],
            "Plan rejected by user"
        );
    }
}
