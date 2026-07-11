use super::message_queue::{enqueue_message, persist_and_broadcast_generated_user_message};
use super::scope::SessionScope;
use super::send_message::requires_user_resolution;
use crate::app_state::AppState;
use crate::domain::ws_session::handler::session_prompt::dispatch_control_prompt;
use crate::error::AppError;

const REPLY_DELIVERY_NOTE: &str = "automatic reply from agent session turn";
const GATE_DELIVERY_NOTE: &str = "automatic gate notification from linked child session";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunningDelivery {
    Queue,
    Steer,
}

pub(super) async fn deliver_reply(
    state: &AppState,
    responder: &SessionScope,
    requester: &SessionScope,
    envelope: &str,
) -> Result<(), AppError> {
    deliver(
        state,
        responder,
        requester,
        envelope,
        RunningDelivery::Queue,
        REPLY_DELIVERY_NOTE,
    )
    .await
}

pub(super) async fn deliver_gate(
    state: &AppState,
    child: &SessionScope,
    parent: &SessionScope,
    envelope: &str,
) -> Result<(), AppError> {
    deliver(
        state,
        child,
        parent,
        envelope,
        RunningDelivery::Steer,
        GATE_DELIVERY_NOTE,
    )
    .await
}

async fn deliver(
    state: &AppState,
    responder: &SessionScope,
    requester: &SessionScope,
    envelope: &str,
    running_delivery: RunningDelivery,
    delivery_note: &str,
) -> Result<(), AppError> {
    persist_and_broadcast_generated_user_message(
        state,
        responder,
        requester.session_id,
        requester.feature_id,
        envelope,
        delivery_note,
    )
    .await?;
    if should_queue(&requester.status, running_delivery) {
        enqueue_message(&state.write_pool, requester.session_id, None, envelope).await?;
        return Ok(());
    }
    dispatch_control_prompt(
        state,
        requester.feature_id,
        requester.session_id,
        envelope,
        true,
    )
    .await
}

fn should_queue(status: &str, running_delivery: RunningDelivery) -> bool {
    requires_user_resolution(status)
        || (status == "running" && running_delivery == RunningDelivery::Queue)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_queue_while_requester_is_running() {
        assert!(should_queue("running", RunningDelivery::Queue));
    }

    #[test]
    fn gates_steer_while_parent_is_running() {
        assert!(!should_queue("running", RunningDelivery::Steer));
    }

    #[test]
    fn gates_queue_while_parent_has_its_own_gate() {
        assert!(should_queue("awaiting_question", RunningDelivery::Steer));
    }
}
