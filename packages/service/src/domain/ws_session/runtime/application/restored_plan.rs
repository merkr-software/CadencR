//! Answering a plan whose agent process is gone.
//!
//! A plan gate is the reply to the agent's `ExitPlanMode` call, which only the
//! process that made it can receive. Once that process is gone (a restart, a
//! crash, a runtime replaced since), the persisted gate still shows, and
//! answering it reached nothing ("Session not yet active"). The service
//! answers it instead: an approval takes the session out of plan mode, the
//! gate closes, and the agent receives the decision as its next prompt. The
//! client only sends the decision, like for a live gate.

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimePermissionResponseKind;
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::protocol::PermissionRespondPayload;
use crate::domain::ws_session::runtime::helpers::broadcast_session_error;
use crate::domain::ws_session::runtime::output::{CommandError, CommandOutput};
use crate::domain::ws_session::runtime::post_plan_mode::{
    should_transition_after_plan_approval, transition_session_to_post_plan_mode,
};
use crate::domain::ws_session::runtime::state::SdkSessions;

use super::control_dispatch::dispatch_control_prompt_with_message_uuid;
use super::permission::PermissionResponseOutcome;
use super::permission_context::PermissionContext;
use super::permission_pending::clear_answered_gate_preserving_replacement;

const APPROVED_PROMPT: &str = "The user approved your plan. Exit plan mode and carry it out.";
const REJECTED_PROMPT: &str = "The user did not approve your plan. Revise it.";

/// The decision, told as the agent's next prompt.
fn follow_up_prompt(approved: bool, feedback: Option<&str>) -> String {
    if approved {
        return APPROVED_PROMPT.to_string();
    }
    match feedback.map(str::trim).filter(|text| !text.is_empty()) {
        Some(feedback) => format!(
            "The user did not approve your plan and asked for changes:\n\n{feedback}\n\nRevise the plan."
        ),
        None => REJECTED_PROMPT.to_string(),
    }
}

/// `respond_claimed` failures meaning no live runtime holds the request: none
/// is running (`INVALID_STATE`), the running one never saw it (`STALE_GATE`),
/// or its permission channel died with it (`CHANNEL_ERROR`).
const NO_RUNTIME_HOLDS_IT: [&str; 3] = ["INVALID_STATE", "STALE_GATE", "CHANNEL_ERROR"];

/// A plan gate no live runtime holds — none is running, or the running one
/// was spawned after the plan was asked — is answered by the service.
pub(super) async fn respond_claimed_plan(
    context: &PermissionContext<'_>,
    sdk_sessions: &SdkSessions,
    payload: PermissionRespondPayload,
    output: &CommandOutput,
    db_session_id: i64,
) -> Result<PermissionResponseOutcome, CommandError> {
    let restored = payload.clone();
    match super::permission::respond_claimed(context, sdk_sessions, payload, output, db_session_id)
        .await
    {
        Err(error) if NO_RUNTIME_HOLDS_IT.contains(&error.code) => {
            let sessions = super::super::control_policy::resolve_owner_sessions(
                sdk_sessions,
                context.active_turns,
                db_session_id,
            )
            .await;
            answer_restored_plan(context, &sessions, restored, output, db_session_id).await
        }
        result => result,
    }
}

/// Answer the claimed plan gate `payload` names, whose runtime cannot.
/// Acknowledged once the gate is closed; the follow-up turn starts after, and
/// a failure to deliver it reaches every viewer as a session error.
async fn answer_restored_plan(
    context: &PermissionContext<'_>,
    sdk_sessions: &SdkSessions,
    payload: PermissionRespondPayload,
    output: &CommandOutput,
    session_id: i64,
) -> Result<PermissionResponseOutcome, CommandError> {
    let Some(app_state) = context.app_state else {
        return Err(CommandError::new("INVALID_STATE", "Session not yet active"));
    };
    // Already validated by `respond_permission`.
    let message_uuid = payload
        .message_uuid
        .as_deref()
        .and_then(|value| uuid::Uuid::parse_str(value).ok());
    let feature_id = sdk_sessions
        .lock()
        .await
        .get(&session_id)
        .map(|handle| handle.feature_id)
        .ok_or_else(|| CommandError::new("SESSION_NOT_FOUND", "Session not found"))?;
    let approved = should_transition_after_plan_approval(
        RuntimePermissionResponseKind::PlanApproval,
        payload
            .decision
            .to_runtime_decision(payload.option_id.as_deref()),
    );
    if approved {
        transition_session_to_post_plan_mode(
            sdk_sessions,
            session_id,
            context.write_pool,
            &output.recipient,
        )
        .await
        .map_err(|error| {
            CommandError::new(
                "SDK_ERROR",
                format!("Failed to apply post-plan permission mode: {error}"),
            )
        })?;
    }
    let has_replacement = clear_answered_gate_preserving_replacement(
        context.write_pool,
        session_id,
        &payload.request_id,
    )
    .await
    .map_err(|error| CommandError::new("DB_ERROR", format!("Failed to close the plan: {error}")))?;
    output.permission_accepted();
    if !has_replacement {
        context.session_status.broadcast_gate_resolved(
            session_id,
            feature_id,
            &payload.request_id,
            AgentStatus::Idle,
        );
    }

    let state = app_state.clone();
    let text = follow_up_prompt(approved, payload.feedback.as_deref());
    tokio::spawn(async move {
        deliver_follow_up(&state, feature_id, session_id, &text, message_uuid).await;
    });
    Ok(PermissionResponseOutcome {
        warnings: Vec::new(),
    })
}

async fn deliver_follow_up(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    text: &str,
    message_uuid: Option<uuid::Uuid>,
) {
    let dispatched = dispatch_control_prompt_with_message_uuid(
        state,
        feature_id,
        session_id,
        text,
        false,
        message_uuid,
    )
    .await;
    match dispatched {
        Ok(outcome) => outcome.delivery_confirmed(),
        Err(error) => {
            tracing::error!(session_id, %error, "the restored plan's answer was not delivered");
            broadcast_session_error(
                &state.ws_feature_senders,
                feature_id,
                "PLAN_ANSWER_NOT_DELIVERED",
                format!(
                    "The plan answer did not reach the agent: {error}. Send it again as a message."
                ),
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rejection_carries_the_feedback() {
        let prompt = follow_up_prompt(false, Some("  Split step 2.  "));
        assert!(prompt.contains("Split step 2."), "{prompt}");
        assert_eq!(follow_up_prompt(false, Some(" ")), REJECTED_PROMPT);
        assert_eq!(follow_up_prompt(true, Some("ignored")), APPROVED_PROMPT);
    }
}
