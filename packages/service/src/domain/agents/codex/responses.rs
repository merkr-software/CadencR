use serde_json::{json, Value};

use super::legacy_permissions::legacy_response_value;
use super::permissions::{
    available_decisions, codex_decision_from_option_id, codex_elicitation_response_from_option_id,
    supports_accept_for_session, DECISION_CANCEL, DECISION_DECLINE, STRICT_AUTO_REVIEW_OPTION_ID,
};
use super::server_request_method::CodexServerRequestMethod;
use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimePermissionResponse};

/// Build the JSON-RPC result for an allow-listed Codex server request. The
/// match is exhaustive on purpose: an approval-shaped `{"decision": ...}` is
/// only ever sent to the two methods whose schema expects it.
pub(super) fn response_value(
    method: CodexServerRequestMethod,
    params: &Value,
    response: &RuntimePermissionResponse,
) -> Value {
    match method {
        CodexServerRequestMethod::Legacy(_) => legacy_response_value(response),
        CodexServerRequestMethod::McpElicitation => elicitation_response(response),
        CodexServerRequestMethod::ToolUserInput => user_input_response(params, response),
        CodexServerRequestMethod::PermissionsApproval => permissions_response(params, response),
        CodexServerRequestMethod::CommandExecutionApproval
        | CodexServerRequestMethod::FileChangeApproval => approval_response(params, response),
    }
}

fn approval_response(params: &Value, response: &RuntimePermissionResponse) -> Value {
    if let Some(decision) = codex_decision_from_option_id(response.option_id.as_deref()) {
        return json!({ "decision": decision });
    }
    let decision = match response.decision {
        RuntimePermissionDecision::AllowOnce => "accept",
        // `AllowForSession` and `AllowFuture` collapse to the same Codex
        // decision today — Codex's RPC vocabulary already carries the
        // session-vs-always distinction via `acceptForSession` vs the
        // separate `permissions_response` "scope" field. The runtime-side
        // `AllowForSession` was introduced for ACP and is not constructed
        // by the Codex adapter, but we accept it defensively so an option
        // that flowed through shared code doesn't panic.
        RuntimePermissionDecision::AllowFuture | RuntimePermissionDecision::AllowForSession
            if supports_accept_for_session(params) =>
        {
            "acceptForSession"
        }
        RuntimePermissionDecision::AllowFuture | RuntimePermissionDecision::AllowForSession => {
            "accept"
        }
        RuntimePermissionDecision::Deny => deny_decision(params),
    };
    json!({ "decision": decision })
}

fn deny_decision(params: &Value) -> &'static str {
    if !params.get("availableDecisions").is_some() {
        return "decline";
    }
    let mut has_cancel = false;
    for decision in available_decisions(params) {
        if decision == DECISION_DECLINE {
            return "decline";
        }
        has_cancel |= decision == DECISION_CANCEL;
    }
    if has_cancel {
        "cancel"
    } else {
        "decline"
    }
}

fn elicitation_response(response: &RuntimePermissionResponse) -> Value {
    if let Some(value) = codex_elicitation_response_from_option_id(response.option_id.as_deref()) {
        return value;
    }
    match response.decision {
        RuntimePermissionDecision::Deny => {
            json!({ "action": "decline", "content": null, "_meta": null })
        }
        _ => json!({
            "action": "accept",
            "content": response.updated_input.clone().unwrap_or_else(|| json!({ "approved": true })),
            "_meta": null,
        }),
    }
}

fn user_input_response(params: &Value, response: &RuntimePermissionResponse) -> Value {
    let Some(raw_answers) = response
        .updated_input
        .as_ref()
        .and_then(|input| input.get("answers"))
    else {
        return json!({ "answers": {} });
    };
    json!({ "answers": codex_question_answers(params, raw_answers) })
}

fn codex_question_answers(params: &Value, raw_answers: &Value) -> Value {
    if raw_answers
        .as_object()
        .is_some_and(|object| object.values().any(|value| value.get("answers").is_some()))
    {
        return raw_answers.clone();
    }

    let questions = params
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut mapped = serde_json::Map::new();
    for (index, question) in questions.iter().enumerate() {
        let Some(question_id) = question.get("id").and_then(Value::as_str) else {
            continue;
        };
        let question_text = question.get("question").and_then(Value::as_str);
        mapped.insert(
            question_id.to_string(),
            json!({ "answers": answer_values(raw_answers, index, question_id, question_text) }),
        );
    }
    Value::Object(mapped)
}

fn answer_values(
    raw_answers: &Value,
    index: usize,
    question_id: &str,
    question_text: Option<&str>,
) -> Vec<String> {
    let index_key = index.to_string();
    let value = raw_answers
        .get(question_id)
        .or_else(|| question_text.and_then(|text| raw_answers.get(text)))
        .or_else(|| raw_answers.get(index_key.as_str()))
        .or_else(|| raw_answers.as_array().and_then(|items| items.get(index)));
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect(),
        Some(Value::String(answer)) => vec![answer.clone()],
        _ => Vec::new(),
    }
}

fn permissions_response(params: &Value, response: &RuntimePermissionResponse) -> Value {
    if matches!(response.decision, RuntimePermissionDecision::Deny) {
        return json!({ "permissions": {}, "scope": "turn" });
    }
    let strict_auto_review = response.option_id.as_deref() == Some(STRICT_AUTO_REVIEW_OPTION_ID);
    let scope = match response.decision {
        // Both runtime decisions request multi-turn approval for Codex's
        // permissions RPC; Codex itself decides whether it persists the
        // grant beyond the session.
        RuntimePermissionDecision::AllowFuture | RuntimePermissionDecision::AllowForSession => {
            "session"
        }
        _ => "turn",
    };
    let mut result = json!({
        "permissions": params.get("permissions").cloned().unwrap_or(Value::Null),
        "scope": scope,
    });
    if strict_auto_review {
        result["strictAutoReview"] = Value::Bool(true);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::response_value;
    use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimePermissionResponse};
    use crate::domain::agents::codex::server_request_method::method;
    use serde_json::{json, Value};

    #[test]
    fn denied_user_input_uses_codex_answer_shape() {
        let response = RuntimePermissionResponse {
            request_id: "question".to_string(),
            decision: RuntimePermissionDecision::Deny,
            option_id: None,
            feedback: None,
            updated_input: None,
        };
        let value = response_value(
            method("item/tool/requestUserInput"),
            &Value::Null,
            &response,
        );
        assert_eq!(value, json!({ "answers": {} }));
    }

    #[test]
    fn elicitation_response_uses_native_option_id() {
        let response = RuntimePermissionResponse {
            request_id: "elicitation".to_string(),
            decision: RuntimePermissionDecision::Deny,
            option_id: Some(
                r#"codex_elicitation:{"action":"cancel","content":null,"_meta":null}"#.to_string(),
            ),
            feedback: Some("stop".to_string()),
            updated_input: None,
        };

        let value = response_value(
            method("mcpServer/elicitation/request"),
            &Value::Null,
            &response,
        );
        assert_eq!(
            value,
            json!({ "action": "cancel", "content": null, "_meta": null })
        );
    }

    #[test]
    fn elicitation_response_preserves_native_persist_meta() {
        let response = RuntimePermissionResponse {
            request_id: "elicitation".to_string(),
            decision: RuntimePermissionDecision::AllowFuture,
            option_id: Some(
                r#"codex_elicitation:{"action":"accept","content":{"approved":true},"_meta":{"persist":"session"}}"#.to_string(),
            ),
            feedback: None,
            updated_input: None,
        };

        let value = response_value(
            method("mcpServer/elicitation/request"),
            &Value::Null,
            &response,
        );
        assert_eq!(
            value,
            json!({
                "action": "accept",
                "content": { "approved": true },
                "_meta": { "persist": "session" }
            })
        );
    }

    #[test]
    fn user_input_answers_are_keyed_by_codex_question_ids() {
        let response = RuntimePermissionResponse {
            request_id: "question".to_string(),
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: None,
            feedback: None,
            updated_input: Some(json!({ "answers": [["yes"], ["no"]] })),
        };
        let params = json!({
            "questions": [
                { "id": "q1", "question": "First?" },
                { "id": "q2", "question": "Second?" }
            ]
        });

        let value = response_value(method("item/tool/requestUserInput"), &params, &response);
        assert_eq!(
            value,
            json!({ "answers": { "q1": { "answers": ["yes"] }, "q2": { "answers": ["no"] } } })
        );
    }

    #[test]
    fn user_input_answers_accept_already_keyed_codex_shape() {
        let response = RuntimePermissionResponse {
            request_id: "question".to_string(),
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: None,
            feedback: None,
            updated_input: Some(json!({
                "answers": {
                    "q1": { "answers": ["already mapped"] }
                }
            })),
        };
        let params = json!({ "questions": [{ "id": "q1", "question": "First?" }] });

        let value = response_value(method("item/tool/requestUserInput"), &params, &response);
        assert_eq!(
            value,
            json!({ "answers": { "q1": { "answers": ["already mapped"] } } })
        );
    }

    #[test]
    fn user_input_answers_accept_frontend_question_text_keys() {
        let question = "Where should the new One dark theme apply?";
        let response = RuntimePermissionResponse {
            request_id: "question".to_string(),
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: None,
            feedback: None,
            updated_input: Some(
                json!({ "answers": { question: "K7Notes app only (Recommended)" } }),
            ),
        };
        let params = json!({ "questions": [{ "id": "theme_scope", "question": question }] });

        let value = response_value(method("item/tool/requestUserInput"), &params, &response);
        assert_eq!(
            value,
            json!({ "answers": { "theme_scope": { "answers": ["K7Notes app only (Recommended)"] } } })
        );
    }

    #[test]
    fn permission_approval_uses_session_scope_for_allow_future() {
        let response = RuntimePermissionResponse {
            request_id: "permissions".to_string(),
            decision: RuntimePermissionDecision::AllowFuture,
            option_id: None,
            feedback: None,
            updated_input: None,
        };
        let params = json!({ "permissions": { "write": true } });

        let value = response_value(
            method("item/permissions/requestApproval"),
            &params,
            &response,
        );
        assert_eq!(
            value,
            json!({ "permissions": { "write": true }, "scope": "session" })
        );
    }

    #[test]
    fn command_deny_declines_without_cancelling_turn() {
        let response = RuntimePermissionResponse {
            request_id: "command".to_string(),
            decision: RuntimePermissionDecision::Deny,
            option_id: None,
            feedback: Some("Skip it".to_string()),
            updated_input: None,
        };

        let value = response_value(
            method("item/commandExecution/requestApproval"),
            &Value::Null,
            &response,
        );
        assert_eq!(value, json!({ "decision": "decline" }));
    }

    #[test]
    fn approval_response_uses_native_codex_option_id() {
        let response = RuntimePermissionResponse {
            request_id: "command".to_string(),
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: Some("codex:\"acceptWithExecpolicyAmendment\"".to_string()),
            feedback: None,
            updated_input: None,
        };

        let value = response_value(
            method("item/commandExecution/requestApproval"),
            &Value::Null,
            &response,
        );
        assert_eq!(
            value,
            json!({ "decision": "acceptWithExecpolicyAmendment" })
        );
    }

    #[test]
    fn permissions_response_marks_strict_auto_review() {
        let response = RuntimePermissionResponse {
            request_id: "permissions".to_string(),
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: Some("codex_permissions_strict_auto_review".to_string()),
            feedback: None,
            updated_input: None,
        };
        let params = json!({ "permissions": { "write": true } });

        let value = response_value(
            method("item/permissions/requestApproval"),
            &params,
            &response,
        );
        assert_eq!(
            value,
            json!({
                "permissions": { "write": true },
                "scope": "turn",
                "strictAutoReview": true
            })
        );
    }

    #[test]
    fn command_deny_uses_cancel_only_when_decline_is_unavailable() {
        let response = RuntimePermissionResponse {
            request_id: "command".to_string(),
            decision: RuntimePermissionDecision::Deny,
            option_id: None,
            feedback: None,
            updated_input: None,
        };

        let value = response_value(
            method("item/commandExecution/requestApproval"),
            &json!({ "availableDecisions": ["accept", "cancel"] }),
            &response,
        );
        assert_eq!(value, json!({ "decision": "cancel" }));
    }

    #[test]
    fn allow_future_falls_back_to_accept_when_session_decision_is_unavailable() {
        let response = RuntimePermissionResponse {
            request_id: "approval".to_string(),
            decision: RuntimePermissionDecision::AllowFuture,
            option_id: None,
            feedback: None,
            updated_input: None,
        };

        let value = response_value(
            method("item/commandExecution/requestApproval"),
            &json!({ "availableDecisions": ["accept", "decline"] }),
            &response,
        );

        assert_eq!(value, json!({ "decision": "accept" }));
    }
}
