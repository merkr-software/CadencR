//! A follow-up a user Stop cancelled before the agent took it in (see
//! `runtime::followup_stops`): it reads as not delivered, its text stays in the
//! conversation for a retry, and the stop is no error of the session.

use tracing::{error, info};

use super::followup_dispatch::mark_followup_dispatch_failed;
use super::prompt_followup::FollowupPromptContext;
use super::prompt_receipt::{clear_pending_prompt_receipt, prompt_received_envelope};
use super::user_shell_context::PendingUserShellContext;
use crate::domain::ws_session::protocol::{PromptReceiptState, PromptSendPayload};
use crate::domain::ws_session::runtime::followup_stops::AcceptedFollowup;
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

const WITHDRAWN_BY_STOP: &str = "Stopped before the agent took this message in; it was not sent";

/// End a follow-up a Stop cancelled before it reached the agent.
/// How a follow-up's delivery ends when it cannot be handed over.
pub(super) struct FollowupDelivery {
    /// A refused steer leaves the running turn alone (control callers).
    pub(super) preserve_running_turn: bool,
    /// Sent while a turn ran: a user Stop after it cancels it.
    pub(super) accepted: Option<AcceptedFollowup>,
    /// The turn it started, which ends idle if the follow-up is withdrawn.
    pub(super) turn_generation: Option<u64>,
}

impl FollowupDelivery {
    /// The turn a withdrawal must end itself. A follow-up sent mid-turn needs
    /// none: the Stop interrupted that turn, whose end settles the session
    /// (settling it earlier would close the turn before its stop marker).
    /// A prompt sent while idle that the runtime dropped started the only turn.
    pub(super) fn turn_to_end(&self) -> Option<u64> {
        self.accepted
            .is_none()
            .then_some(self.turn_generation)
            .flatten()
    }
}

/// Whether a user Stop came after this follow-up was accepted mid-turn.
pub(super) fn stopped_since_accepted(
    context: &FollowupPromptContext,
    delivery: &FollowupDelivery,
) -> bool {
    delivery.accepted.is_some_and(|accepted| {
        context
            .active_turns
            .followups()
            .stopped_since(context.db_session_id, accepted)
    })
}

/// `started_turn`: the turn generation the follow-up started (it marked the
/// session working), which ends idle unless a newer turn began since.
pub(super) async fn withdraw_followup(
    context: &FollowupPromptContext,
    payload: &PromptSendPayload,
    shell_context: Option<PendingUserShellContext>,
    dispatch_claim: Option<&(i64, String)>,
    started_turn: Option<u64>,
) -> Result<(), String> {
    info!(context.db_session_id, "follow-up cancelled by a Stop");
    if let Some(shell_context) = shell_context {
        if let Err(release_error) = shell_context.release(&context.write_pool).await {
            error!(context.db_session_id, error = %release_error, "failed to release user shell context claim");
        }
    }
    if let Some(generation) = started_turn {
        end_withdrawn_turn(context, generation).await;
    }
    mark_followup_dispatch_failed(context, dispatch_claim, WITHDRAWN_BY_STOP).await;
    match payload.message_uuid.clone() {
        Some(message_uuid) => {
            clear_pending_prompt_receipt(
                &context.write_pool,
                &context.ws_feature_senders,
                &context.sender,
                context.feature_id,
                context.db_session_id,
                message_uuid,
            )
            .await;
        }
        None => crate::domain::ws_session::runtime::helpers::send_warning(
            &context.sender,
            &context.envelope_id,
            "FOLLOWUP_CANCELLED",
            WITHDRAWN_BY_STOP,
        ),
    }
    if context.wait_for_delivery {
        Err(WITHDRAWN_BY_STOP.to_string())
    } else {
        Ok(())
    }
}

/// The turn the follow-up started never ran: nothing else ends it.
async fn end_withdrawn_turn(context: &FollowupPromptContext, generation: u64) {
    if !context
        .active_turns
        .is_current_generation(context.db_session_id, generation)
        .await
    {
        return;
    }
    if let Err(error) =
        crate::domain::ws_session::persistence::WsSessionPersistence::mark_completed_static(
            &context.write_pool,
            context.db_session_id,
        )
        .await
    {
        error!(context.db_session_id, %error, "failed to persist the idle state of a withdrawn follow-up");
        crate::domain::ws_session::runtime::helpers::send_warning(
            &context.sender,
            &context.envelope_id,
            "STATE_NOT_SAVED",
            "The agent stopped, but its idle state could not be saved",
        );
    }
    context.session_status_tx.broadcast(
        context.db_session_id,
        context.feature_id,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );
}

/// Mark follow-ups the runtime withdrew at a Stop as not delivered, for every
/// client viewing the conversation.
pub(in crate::domain::ws_session) async fn report_withdrawn_followups(
    pool: &sqlx::SqlitePool,
    feature_senders: &WsFeatureSenderRegistry,
    feature_id: i64,
    session_id: i64,
    message_uuids: Vec<String>,
) {
    for message_uuid in message_uuids {
        match crate::domain::sessions::user_messages::update_delivery_state(
            pool,
            session_id,
            &message_uuid,
            "delivery_failed",
        )
        .await
        {
            Ok(true) => info!(session_id, %message_uuid, "follow-up withdrawn by a Stop"),
            Ok(false) => continue,
            Err(error) => {
                error!(session_id, %error, "failed to persist a withdrawn follow-up");
                continue;
            }
        }
        let envelope = prompt_received_envelope(message_uuid, PromptReceiptState::DeliveryFailed);
        let message = axum::extract::ws::Message::Text(String::from(envelope).into());
        feature_senders.broadcast_all(feature_id, &message).await;
    }
}
