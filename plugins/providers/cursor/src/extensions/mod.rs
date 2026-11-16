//! Cursor `cursor/*` ACP extension methods, translated into standard ACP the
//! generic Cadencr host understands (tool calls, plans, permission requests).

pub mod plan;
pub mod question;
pub mod subagents;
pub mod task;
pub mod todos;

use serde_json::{json, Value};

/// The host's answer to a connector-issued `session/request_permission`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HostDecision {
    pub approved: bool,
    pub cancelled: bool,
    pub feedback: Option<String>,
    pub updated_input: Option<Value>,
}

impl HostDecision {
    /// `{outcome: {outcome: "selected", optionId}}` approves only when the
    /// selected option is `allow_option_id`. Cadencr attaches the user's
    /// reason as `_meta.feedback` (mirrored as top-level `feedback`) and the
    /// AskUserQuestion answers as `_meta.updatedInput`.
    pub fn from_response(response: &Value, allow_option_id: &str) -> Self {
        let outcome = response.get("outcome");
        let kind = outcome
            .and_then(|outcome| outcome.get("outcome"))
            .and_then(Value::as_str);
        let option_id = outcome
            .and_then(|outcome| outcome.get("optionId"))
            .and_then(Value::as_str);
        let meta = response.get("_meta");
        let feedback = meta
            .and_then(|meta| meta.get("feedback"))
            .or_else(|| response.get("feedback"))
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(ToOwned::to_owned);
        Self {
            approved: kind == Some("selected") && option_id == Some(allow_option_id),
            cancelled: kind == Some("cancelled"),
            feedback,
            updated_input: meta
                .and_then(|meta| meta.get("updatedInput"))
                .filter(|value| value.is_object())
                .cloned(),
        }
    }
}

/// Approve / reject options for a connector-issued gate.
pub fn gate_options(allow_id: &str, allow_label: &str) -> Value {
    json!([
        { "optionId": allow_id, "kind": "allow_once", "name": allow_label },
        { "optionId": "reject", "kind": "reject_once", "name": "Reject" },
    ])
}

/// Cursor's `toolCallId`, or a connector-generated id when it sent none.
pub fn tool_call_id(params: &Value, fallback: impl FnOnce() -> String) -> String {
    params
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(fallback)
}

/// The tool call payload shared by the `session/update` announcement and the
/// matching `session/request_permission`. `toolName` mirrors the standard
/// ACP `name` because Cadencr's permission parser reads `toolName`.
pub fn gate_tool_call(id: &str, name: &str, title: &str, kind: &str, input: &Value) -> Value {
    json!({
        "toolCallId": id,
        "name": name,
        "toolName": name,
        "title": title,
        "kind": kind,
        "status": "pending",
        "rawInput": input,
    })
}

#[cfg(test)]
mod tests {
    use super::{gate_options, gate_tool_call, tool_call_id, HostDecision};
    use serde_json::json;

    #[test]
    fn parses_cadencr_permission_responses() {
        let approved = HostDecision::from_response(
            &json!({
                "outcome": { "outcome": "selected", "optionId": "submit" },
                "_meta": { "updatedInput": { "answers": {} } }
            }),
            "submit",
        );
        assert!(approved.approved);
        assert_eq!(approved.updated_input, Some(json!({ "answers": {} })));

        let rejected = HostDecision::from_response(
            &json!({
                "outcome": { "outcome": "selected", "optionId": "reject" },
                "feedback": "no",
                "_meta": { "feedback": "not like this" }
            }),
            "submit",
        );
        assert!(!rejected.approved && !rejected.cancelled);
        assert_eq!(rejected.feedback.as_deref(), Some("not like this"));

        let cancelled =
            HostDecision::from_response(&json!({ "outcome": { "outcome": "cancelled" } }), "x");
        assert!(cancelled.cancelled && !cancelled.approved);
    }

    #[test]
    fn builds_gate_payloads() {
        assert_eq!(
            gate_options("approve", "Approve plan")[0]["kind"],
            "allow_once"
        );
        assert_eq!(
            gate_options("approve", "Approve plan")[1]["optionId"],
            "reject"
        );
        let call = gate_tool_call("t1", "ExitPlanMode", "Plan", "switch_mode", &json!({}));
        assert_eq!(call["toolName"], "ExitPlanMode");
        assert_eq!(call["name"], "ExitPlanMode");
        assert_eq!(
            tool_call_id(&json!({ "toolCallId": " " }), || "f".into()),
            "f"
        );
        assert_eq!(
            tool_call_id(&json!({ "toolCallId": "c" }), || "f".into()),
            "c"
        );
    }
}
