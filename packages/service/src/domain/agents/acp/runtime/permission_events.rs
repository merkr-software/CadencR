use serde_json::{json, Value};

use crate::domain::agents::adapter::{
    RuntimePermissionDecision, RuntimePermissionOption, RuntimePermissionRequest,
};

/// Surface a provider-normalized blocking request as the raw envelope the WS
/// bridge consumes. Both canonical ACP permissions and adapter extensions use
/// this one provider-neutral event shape.
pub fn permission_raw_event(request: &RuntimePermissionRequest, params: &Value) -> Value {
    json!({
        "type": "acp_permission_request",
        "transport": "acp",
        "request_id": request.request_id,
        "call_id": request.tool_use_id,
        "tool_name": request.tool_name,
        "tool_input": request.tool_input,
        "description": request.description,
        "preview": request.preview,
        "options": request.options.iter().map(permission_option_json).collect::<Vec<_>>(),
        "acp": params.clone(),
    })
}

fn permission_option_json(option: &RuntimePermissionOption) -> Value {
    // `AllowForSession` is a backend refinement of the FE's allow-future
    // discriminant; the distinct label and option id still render and route
    // the session-scoped choice independently.
    let decision = match option.decision {
        RuntimePermissionDecision::AllowOnce => "allow_once",
        RuntimePermissionDecision::AllowFuture | RuntimePermissionDecision::AllowForSession => {
            "allow_future"
        }
        RuntimePermissionDecision::Deny => "deny",
    };
    json!({
        "decision": decision,
        "option_id": option.option_id,
        "label": option.label,
        "description": option.description,
        "collect_feedback": option.collect_feedback,
    })
}

pub fn parse_permission_options(raw: Option<&Value>) -> Option<Vec<RuntimePermissionOption>> {
    let parsed = raw?
        .as_array()?
        .iter()
        .filter_map(|option| {
            let decision = match option.get("decision").and_then(Value::as_str)? {
                "allow_once" => RuntimePermissionDecision::AllowOnce,
                "allow_for_session" => RuntimePermissionDecision::AllowForSession,
                "allow_future" => RuntimePermissionDecision::AllowFuture,
                "deny" => RuntimePermissionDecision::Deny,
                _ => return None,
            };
            Some(RuntimePermissionOption {
                decision,
                option_id: option
                    .get("option_id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                label: option
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("Option")
                    .to_string(),
                description: option
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                collect_feedback: option
                    .get("collect_feedback")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();
    (!parsed.is_empty()).then_some(parsed)
}

/// The single decoder for the envelope [`permission_raw_event`] wrote.
///
/// Keeping decode in one place means adding a field to [`permission_raw_event`]
/// is a one-line change here rather than a hunt through every reader. An
/// envelope without options is rejected instead of inventing choices — a
/// generic ACP provider must never show the user options its agent did not
/// offer.
pub fn parse_acp_permission_request(raw: &Value) -> Option<RuntimePermissionRequest> {
    if raw.get("type").and_then(Value::as_str) != Some("acp_permission_request") {
        return None;
    }
    let text = |key: &str| raw.get(key).and_then(Value::as_str).map(ToOwned::to_owned);
    Some(RuntimePermissionRequest {
        request_id: text("request_id")?,
        tool_use_id: text("call_id"),
        tool_name: text("tool_name")?,
        tool_input: raw.get("tool_input").cloned().unwrap_or_else(|| json!({})),
        description: text("description"),
        pattern: None,
        preview: text("preview"),
        options: parse_permission_options(raw.get("options"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_acp_permission_request, permission_raw_event};
    use crate::domain::agents::adapter::{
        RuntimePermissionDecision, RuntimePermissionOption, RuntimePermissionRequest,
    };
    use serde_json::json;

    fn request() -> RuntimePermissionRequest {
        RuntimePermissionRequest {
            request_id: "req-1".to_string(),
            tool_use_id: Some("call-1".to_string()),
            tool_name: "Bash".to_string(),
            tool_input: json!({ "command": "git status" }),
            description: Some("Run git status".to_string()),
            pattern: None,
            preview: Some("git status".to_string()),
            options: vec![RuntimePermissionOption {
                decision: RuntimePermissionDecision::AllowOnce,
                option_id: Some("allow".to_string()),
                label: "Allow".to_string(),
                description: "Approve once".to_string(),
                collect_feedback: false,
            }],
        }
    }

    /// The envelope the runtime emits must survive a round trip, otherwise a
    /// generic ACP provider's permission prompts would never reach the user.
    #[test]
    fn round_trips_the_runtime_permission_envelope() {
        let raw = permission_raw_event(&request(), &json!({ "sessionId": "s-1" }));
        let parsed = parse_acp_permission_request(&raw).expect("envelope should parse");
        assert_eq!(parsed.request_id, "req-1");
        assert_eq!(parsed.tool_use_id.as_deref(), Some("call-1"));
        assert_eq!(parsed.tool_name, "Bash");
        assert_eq!(parsed.tool_input, json!({ "command": "git status" }));
        assert_eq!(parsed.preview.as_deref(), Some("git status"));
        assert_eq!(parsed.options.len(), 1);
        assert_eq!(parsed.options[0].option_id.as_deref(), Some("allow"));
    }

    #[test]
    fn ignores_other_events_and_option_less_envelopes() {
        assert!(parse_acp_permission_request(&json!({ "type": "other" })).is_none());
        let option_less = json!({
            "type": "acp_permission_request",
            "request_id": "req-1",
            "tool_name": "Bash",
        });
        assert!(parse_acp_permission_request(&option_less).is_none());
    }
}
