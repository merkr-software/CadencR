//! What answering a gate whose runtime is gone shares for plans
//! (`restored_plan`) and questions (`restored_question`): the gate closes, the
//! answer is acknowledged, and the agent is told as its next prompt.

use crate::app_state::AppState;
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::protocol::PermissionRespondPayload;
use crate::domain::ws_session::runtime::helpers::broadcast_session_error;
use crate::domain::ws_session::runtime::output::{CommandError, CommandOutput};

use super::control_dispatch::dispatch_control_prompt_with_message_uuid;
use super::permission::PermissionResponseOutcome;
use super::permission_context::PermissionContext;
use super::permission_pending::clear_answered_gate_preserving_replacement;

/// The gate a service-side answer closes.
pub(super) struct RestoredGate<'a> {
    pub(super) session_id: i64,
    pub(super) feature_id: i64,
    pub(super) payload: &'a PermissionRespondPayload,
    /// "plan" or "question", for the error when closing fails.
    pub(super) name: &'static str,
}

/// The prompt telling the agent the answer, and what a failed delivery says.
pub(super) struct FollowUp {
    pub(super) text: String,
    pub(super) not_delivered_code: &'static str,
    /// Leads the delivery error: "The plan answer", "Your answer".
    pub(super) not_delivered: &'static str,
}

/// Close `gate` and send `follow_up` as the next prompt. Acknowledged once the
/// gate is closed; the follow-up turn starts after, and a failure to deliver
/// it reaches every viewer as a session error.
pub(super) async fn close_and_follow_up(
    context: &PermissionContext<'_>,
    app_state: &AppState,
    output: &CommandOutput,
    gate: RestoredGate<'_>,
    follow_up: Option<FollowUp>,
) -> Result<PermissionResponseOutcome, CommandError> {
    let request_id = &gate.payload.request_id;
    let has_replacement =
        clear_answered_gate_preserving_replacement(context.write_pool, gate.session_id, request_id)
            .await
            .map_err(|error| {
                CommandError::new(
                    "DB_ERROR",
                    format!("Failed to close the {}: {error}", gate.name),
                )
            })?;
    output.permission_accepted();
    if !has_replacement {
        context.session_status.broadcast_gate_resolved(
            gate.session_id,
            gate.feature_id,
            request_id,
            AgentStatus::Idle,
        );
    }
    if let Some(follow_up) = follow_up {
        // Already validated by `respond_permission`.
        let message_uuid = gate
            .payload
            .message_uuid
            .as_deref()
            .and_then(|value| uuid::Uuid::parse_str(value).ok());
        let state = app_state.clone();
        let (feature_id, session_id) = (gate.feature_id, gate.session_id);
        tokio::spawn(async move {
            deliver(&state, feature_id, session_id, follow_up, message_uuid).await;
        });
    }
    Ok(PermissionResponseOutcome {
        warnings: Vec::new(),
    })
}

async fn deliver(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    follow_up: FollowUp,
    message_uuid: Option<uuid::Uuid>,
) {
    let dispatched = dispatch_control_prompt_with_message_uuid(
        state,
        feature_id,
        session_id,
        &follow_up.text,
        false,
        message_uuid,
    )
    .await;
    match dispatched {
        Ok(outcome) => outcome.delivery_confirmed(),
        Err(error) => {
            tracing::error!(session_id, %error, "the answer to a restored gate was not delivered");
            broadcast_session_error(
                &state.ws_feature_senders,
                feature_id,
                follow_up.not_delivered_code,
                format!(
                    "{} did not reach the agent: {error}. Send it again as a message.",
                    follow_up.not_delivered
                ),
            )
            .await;
        }
    }
}
