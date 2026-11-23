mod control_dispatch;
mod control_dispatch_config;
mod control_dispatch_payload;

use crate::{app_state::AppState, error::AppError};
use control_dispatch_payload::replay_payload;
use prompt_outcome::PromptDispatchOutcome;

#[derive(Clone, Copy)]
enum PromptOrigin {
    Control { replay: bool },
    UserQueue,
}

impl PromptOrigin {
    fn is_replay(self) -> bool {
        matches!(self, Self::Control { replay: true })
    }
    fn is_user(self) -> bool {
        matches!(self, Self::UserQueue)
    }
}

/// Inject a prompt into a session without a connected WS client.
///
/// `replay` controls whether the standard prompt path persists and broadcasts
/// the inbound text as a user message. MCP callers persist the user message
/// themselves (with agent-to-agent origin metadata) and pass `true` to suppress
/// the duplicate; the scheduler passes `false` so a user-authored scheduled
/// message is persisted and mirrored to clients like any other user message.
pub(crate) async fn dispatch_control_prompt(
    app_state: &AppState,
    feature_id: i64,
    session_id: i64,
    text: &str,
    replay: bool,
) -> Result<PromptDispatchOutcome, AppError> {
    dispatch_control_prompt_with_message_uuid(app_state, feature_id, session_id, text, replay, None)
        .await
}

pub(crate) async fn dispatch_control_prompt_with_message_uuid(
    app_state: &AppState,
    feature_id: i64,
    session_id: i64,
    text: &str,
    replay: bool,
    message_uuid: Option<uuid::Uuid>,
) -> Result<PromptDispatchOutcome, AppError> {
    let payload = replay_payload(session_id, text, None, replay, message_uuid);
    control_dispatch::dispatch(
        app_state,
        feature_id,
        session_id,
        payload,
        PromptOrigin::Control { replay },
    )
    .await
}

/// A user-authored queued prompt updates the workspace selection once delivered.
pub(crate) async fn dispatch_queued_user_prompt(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    text: &str,
    message_uuid: uuid::Uuid,
) -> Result<PromptDispatchOutcome, AppError> {
    let payload = replay_payload(session_id, text, None, false, Some(message_uuid));
    control_dispatch::dispatch(
        state,
        feature_id,
        session_id,
        payload,
        PromptOrigin::UserQueue,
    )
    .await
}

mod gate_clear_ahead;
pub(crate) use gate_clear_ahead::clear_gate_ahead;
mod permission;
mod permission_context;
mod permission_pending;
pub(crate) use permission_pending::clear_answered_gate;
mod permission_user_message;
pub(crate) use permission::respond_permission;
pub(crate) use permission_context::PermissionContext;

mod pending_gate;
pub(crate) use pending_gate::{mark_agent_resumed, mark_awaiting_user};

mod prompt_outcome;
mod restored_gate;
mod restored_plan;
mod restored_question;
