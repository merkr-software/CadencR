use serde::Deserialize;

use crate::app_state::AppState;
use crate::domain::gate_registry::{GateKind, PendingGate};
use crate::domain::ws_session::protocol::{PermissionDecision, PermissionRespondPayload};
use crate::error::AppError;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum GateDecision {
    Permission {
        action: PermissionAction,
        message: Option<String>,
    },
    Plan {
        action: PlanAction,
        message: Option<String>,
    },
    Question {
        answers: serde_json::Value,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PermissionAction {
    AllowOnce,
    AllowAlways,
    Deny,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PlanAction {
    Approve,
    RequestChanges,
    Reject,
}

pub(crate) async fn authorize_decision(
    state: &AppState,
    session_id: i64,
    request_id: &str,
    decision: &GateDecision,
) -> Result<PermissionRespondPayload, AppError> {
    state
        .pending_gates
        .ensure_loaded(&state.read_pool, session_id)
        .await?;
    let gate = state
        .pending_gates
        .find_pending(session_id, request_id)
        .await
        .ok_or_else(|| AppError::Conflict("gate is no longer pending".into()))?;
    validate_decision_kind(decision, gate.kind)?;
    permission_payload(session_id, request_id, decision, &gate)
}

fn validate_decision_kind(decision: &GateDecision, kind: GateKind) -> Result<(), AppError> {
    let matches = matches!(
        (decision, kind),
        (GateDecision::Permission { .. }, GateKind::Permission)
            | (GateDecision::Plan { .. }, GateKind::Plan)
            | (GateDecision::Question { .. }, GateKind::Question)
    );
    if matches {
        return Ok(());
    }
    let accepted = match kind {
        GateKind::Permission => "a `permission` decision: allow_once, allow_always or deny",
        GateKind::Plan => "a `plan` decision: approve, request_changes or reject",
        GateKind::Question => "a `question` decision with its answers",
    };
    Err(AppError::BadRequest(format!(
        "decision type does not match pending gate kind: this {} gate takes {accepted}",
        kind.as_str()
    )))
}

fn permission_payload(
    session_id: i64,
    request_id: &str,
    decision: &GateDecision,
    gate: &PendingGate,
) -> Result<PermissionRespondPayload, AppError> {
    let (decision, advertised, feedback, updated_input) = match decision {
        GateDecision::Permission { action, message } => match action {
            PermissionAction::AllowOnce => (
                PermissionDecision::AllowOnce,
                "allow_once",
                message.clone(),
                None,
            ),
            PermissionAction::AllowAlways => (
                PermissionDecision::AllowFuture,
                "allow_future",
                message.clone(),
                None,
            ),
            PermissionAction::Deny => (PermissionDecision::Deny, "deny", message.clone(), None),
        },
        GateDecision::Plan { action, message } => {
            return Ok(plan_payload(session_id, request_id, action, message, gate));
        }
        GateDecision::Question { answers } => {
            if answers.is_null() {
                return Err(AppError::BadRequest(
                    "question answers must not be null".into(),
                ));
            }
            return Ok(PermissionRespondPayload {
                session_id: session_id.to_string(),
                request_id: request_id.to_string(),
                message_uuid: None,
                decision: PermissionDecision::AllowOnce,
                option_id: advertised_option(&gate.payload, "allow_once").flatten(),
                feedback: None,
                updated_input: Some(question_input(&gate.payload, answers.clone())),
            });
        }
    };
    let option_id = advertised_option(&gate.payload, advertised).ok_or_else(|| {
        AppError::BadRequest(format!(
            "gate does not advertise the `{advertised}` decision"
        ))
    })?;
    Ok(PermissionRespondPayload {
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        message_uuid: None,
        decision,
        option_id,
        feedback,
        updated_input,
    })
}

/// A plan gate's decisions come from its kind, as in the desktop's plan bar:
/// approving allows the plan, asking for changes or rejecting denies it with
/// the feedback. Claude and Codex advertise no options on a plan; a provider
/// that does gets the matching option, and otherwise its adapter picks one.
fn plan_payload(
    session_id: i64,
    request_id: &str,
    action: &PlanAction,
    message: &Option<String>,
    gate: &PendingGate,
) -> PermissionRespondPayload {
    let (decision, advertised) = match action {
        PlanAction::Approve => (PermissionDecision::AllowOnce, "allow_once"),
        PlanAction::RequestChanges | PlanAction::Reject => (PermissionDecision::Deny, "deny"),
    };
    PermissionRespondPayload {
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        message_uuid: None,
        decision,
        option_id: advertised_option(&gate.payload, advertised).flatten(),
        feedback: message.clone(),
        updated_input: None,
    }
}

fn advertised_option(payload: &serde_json::Value, decision: &str) -> Option<Option<String>> {
    payload
        .get("options")?
        .as_array()?
        .iter()
        .find(|option| option.get("decision").and_then(serde_json::Value::as_str) == Some(decision))
        .map(|option| {
            option
                .get("option_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
}

fn question_input(payload: &serde_json::Value, answers: serde_json::Value) -> serde_json::Value {
    let mut input = payload
        .get("tool_input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(object) = input.as_object_mut() {
        object.insert("answers".into(), answers);
        input
    } else {
        serde_json::json!({"answers": answers})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(kind: GateKind, tool: &str) -> PendingGate {
        PendingGate {
            request_id: "r1".into(),
            kind,
            payload: serde_json::json!({
                "request_id": "r1",
                "tool_name": tool,
                "tool_input": {},
                "options": [
                    {"decision":"allow_once","option_id":"native-once"},
                    {"decision":"deny","option_id":"native-deny"}
                ]
            }),
        }
    }

    #[test]
    fn rejects_mismatched_decision_kind() {
        let decision = GateDecision::Question {
            answers: serde_json::json!(["yes"]),
        };
        let error = validate_decision_kind(&decision, GateKind::Permission).unwrap_err();
        assert!(error.to_string().contains("does not match"));
    }

    /// A Claude or Codex plan gate, as stored: no options.
    fn bare_plan_gate() -> PendingGate {
        PendingGate {
            request_id: "plan-1".into(),
            kind: GateKind::Plan,
            payload: serde_json::json!({
                "request_id": "plan-1",
                "tool_name": "ExitPlanMode",
                "tool_input": {"plan": "Create hello.txt"},
                "description": "Plan is ready for approval",
                "options": []
            }),
        }
    }

    fn plan(action: PlanAction, message: Option<&str>) -> GateDecision {
        GateDecision::Plan {
            action,
            message: message.map(str::to_string),
        }
    }

    /// The desktop approves a plan with `allow_once` and no option, and asks
    /// for changes with `deny` and the feedback; the API and MCP do the same.
    #[tokio::test]
    async fn a_plan_without_options_takes_every_plan_decision() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let state = AppState::with_pool(pool);
        state.pending_gates.register(2, bare_plan_gate()).await;

        let approve = plan(PlanAction::Approve, None);
        let payload = authorize_decision(&state, 2, "plan-1", &approve)
            .await
            .unwrap();
        assert_eq!(payload.decision, PermissionDecision::AllowOnce);
        assert_eq!(payload.option_id, None);

        let gate = bare_plan_gate();
        let changes = plan(PlanAction::RequestChanges, Some("Add a test"));
        let payload = permission_payload(2, "plan-1", &changes, &gate).unwrap();
        assert_eq!(payload.decision, PermissionDecision::Deny);
        assert_eq!(payload.feedback.as_deref(), Some("Add a test"));

        let reject = plan(PlanAction::Reject, None);
        let payload = permission_payload(2, "plan-1", &reject, &gate).unwrap();
        assert_eq!(payload.decision, PermissionDecision::Deny);
        assert_eq!(payload.option_id, None);
    }

    /// A provider that advertises its plan options gets the matching one.
    #[test]
    fn a_plan_with_options_answers_with_the_matching_option() {
        let mut gate = gate(GateKind::Plan, "ExitPlanMode");
        gate.payload["options"] = serde_json::json!([
            {"decision": "allow_once", "option_id": "acp-approve"},
            {"decision": "deny", "option_id": "acp-reject"}
        ]);
        let approve = permission_payload(2, "r1", &plan(PlanAction::Approve, None), &gate);
        assert_eq!(approve.unwrap().option_id.as_deref(), Some("acp-approve"));
        let reject = permission_payload(2, "r1", &plan(PlanAction::Reject, None), &gate);
        assert_eq!(reject.unwrap().option_id.as_deref(), Some("acp-reject"));
    }

    #[test]
    fn a_permission_decision_on_a_plan_lists_the_plan_decisions() {
        let allow_once = GateDecision::Permission {
            action: PermissionAction::AllowOnce,
            message: None,
        };
        let error = validate_decision_kind(&allow_once, GateKind::Plan)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("approve, request_changes or reject"),
            "{error}"
        );
    }

    #[test]
    fn uses_provider_option_id_and_rejects_unadvertised_decision() {
        let gate = gate(GateKind::Permission, "Read");
        let allow_once = GateDecision::Permission {
            action: PermissionAction::AllowOnce,
            message: None,
        };
        let payload = permission_payload(2, "r1", &allow_once, &gate).unwrap();
        assert_eq!(payload.option_id.as_deref(), Some("native-once"));

        let allow_always = GateDecision::Permission {
            action: PermissionAction::AllowAlways,
            message: None,
        };
        let error = permission_payload(2, "r1", &allow_always, &gate).unwrap_err();
        assert!(error.to_string().contains("allow_future"));
    }

    #[tokio::test]
    async fn linked_parent_can_authorize_shell_permission() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let state = AppState::with_pool(pool);
        state
            .pending_gates
            .register(2, gate(GateKind::Permission, "Bash"))
            .await;
        let decision = GateDecision::Permission {
            action: PermissionAction::AllowOnce,
            message: None,
        };

        let payload = authorize_decision(&state, 2, "r1", &decision)
            .await
            .unwrap();

        assert_eq!(payload.request_id, "r1");
        assert_eq!(payload.option_id.as_deref(), Some("native-once"));
    }

    #[test]
    fn preserves_single_string_answer_for_provider_adapter() {
        let mut gate = gate(GateKind::Question, "AskUserQuestion");
        gate.payload["tool_input"] = serde_json::json!({
            "questions": [{"question": "Choose a path?"}]
        });
        let decision = GateDecision::Question {
            answers: serde_json::json!("Question path"),
        };

        let payload = permission_payload(2, "r1", &decision, &gate).unwrap();

        assert_eq!(
            payload.updated_input.unwrap()["answers"],
            serde_json::json!("Question path")
        );
    }

    #[test]
    fn preserves_structured_question_answers_for_provider_adapter() {
        let mut gate = gate(GateKind::Question, "AskUserQuestion");
        gate.payload["tool_input"] = serde_json::json!({
            "questions": [
                {"question": "First?"},
                {"question": "Second?"}
            ]
        });
        let decision = GateDecision::Question {
            answers: serde_json::json!([["Alpha", "Beta"], "Gamma"]),
        };

        let payload = permission_payload(2, "r1", &decision, &gate).unwrap();

        assert_eq!(
            payload.updated_input.unwrap()["answers"],
            serde_json::json!([["Alpha", "Beta"], "Gamma"])
        );
    }
}
