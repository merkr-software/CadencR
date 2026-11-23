//! A follow-up a user Stop cancelled before the agent took it in (see
//! `runtime::followup_stops`): it reads as not delivered, its text stays in the
//! conversation for a retry, and the stop is no error of the session.

use tracing::{error, info};

use super::followup_dispatch::mark_followup_dispatch_failed;
use super::prompt_followup::FollowupPromptContext;
use super::prompt_receipt::{clear_pending_prompt_receipt, prompt_received_envelope};
use super::user_shell_context::PendingUserShellContext;
use crate::domain::ws_session::protocol::{PromptReceiptState, PromptSendPayload};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

const WITHDRAWN_BY_STOP: &str = "Stopped before the agent took this message in; it was not sent";
const WITHDRAWN_BY_REPLACEMENT: &str =
    "The agent was closed or restarted before it took this message in; it was not sent";

/// Why a prompt was withdrawn before the agent took it in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WithdrawnBy {
    /// A user Stop (or a sleep pause) cancelled it.
    Stop,
    /// Its runtime was closed or replaced (a rewind, a fork, a close) while
    /// it waited for its pre-turn checkpoint.
    RuntimeReplaced,
}

impl WithdrawnBy {
    fn reason(self) -> &'static str {
        match self {
            Self::Stop => WITHDRAWN_BY_STOP,
            Self::RuntimeReplaced => WITHDRAWN_BY_REPLACEMENT,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::Stop => "FOLLOWUP_CANCELLED",
            Self::RuntimeReplaced => "FOLLOWUP_RUNTIME_REPLACED",
        }
    }
}

/// End a prompt withdrawn before it reached the agent. `started_turn`: the
/// turn generation it started (it marked the session working), which ends idle
/// unless a newer turn began since.
pub(super) async fn withdraw_followup(
    context: &FollowupPromptContext,
    payload: &PromptSendPayload,
    shell_context: Option<PendingUserShellContext>,
    dispatch_claim: Option<&(i64, String)>,
    started_turn: Option<u64>,
    by: WithdrawnBy,
) -> Result<(), String> {
    info!(
        context.db_session_id,
        ?by,
        "prompt withdrawn before its hand-over"
    );
    if let Some(shell_context) = shell_context {
        shell_context
            .release_or_warn(&context.write_pool, &context.sender, &context.envelope_id)
            .await;
    }
    if let Some(generation) = started_turn {
        end_withdrawn_turn(context, generation).await;
    }
    mark_followup_dispatch_failed(context, dispatch_claim, by.reason()).await;
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
            by.code(),
            by.reason(),
        ),
    }
    if context.wait_for_delivery {
        Err(by.reason().to_string())
    } else {
        Ok(())
    }
}

/// The turn the follow-up started never ran: nothing else ends it.
async fn end_withdrawn_turn(context: &FollowupPromptContext, generation: u64) {
    end_turn_idle()
        .pool(&context.write_pool)
        .feature_senders(&context.ws_feature_senders)
        .status(&context.session_status_tx)
        .active_turns(&context.active_turns)
        .session_id(context.db_session_id)
        .feature_id(context.feature_id)
        .generation(generation)
        .call()
        .await;
}

/// End a turn a prompt marked working that never reached the runtime: a
/// withdrawn prompt's, one a Stop cancelled, one whose prompt was dropped.
/// No result will end it, and a stop mark of it dies with it. `generation`:
/// that turn, left alone once a newer one began. The generation is held
/// meanwhile, so no turn begins between the check and its end.
#[bon::builder]
pub(in crate::domain::ws_session) async fn end_turn_idle(
    pool: &sqlx::SqlitePool,
    feature_senders: &WsFeatureSenderRegistry,
    status: &crate::domain::session_status::SessionStatusBroadcaster,
    active_turns: &super::super::ActiveTurnRegistry,
    session_id: i64,
    feature_id: i64,
    generation: Option<u64>,
) {
    let _generation = active_turns.lock_turn_generation(session_id).await;
    if let Some(generation) = generation {
        if !active_turns
            .is_current_generation(session_id, generation)
            .await
        {
            return;
        }
    }
    active_turns.end_turn(session_id).await;
    let completed =
        crate::domain::ws_session::persistence::WsSessionPersistence::mark_completed_static(
            pool, session_id,
        )
        .await;
    crate::domain::ws_session::runtime::helpers::report_if_unsaved(
        feature_senders,
        feature_id,
        session_id,
        "that the agent is idle",
        completed,
    )
    .await;
    status.broadcast(
        session_id,
        feature_id,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );
}

/// Mark follow-ups a Stop left undelivered (withdrawn by the runtime, or
/// never acknowledged by the turn it stopped) as not delivered, for every
/// client viewing the conversation. Their failed dispatch lets a retry send
/// them again, and keeps a late receipt from counting.
pub(in crate::domain::ws_session) async fn fail_stopped_followups(
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
        if let Err(error) = crate::domain::sessions::message_dispatch::mark_withdrawn(
            pool,
            session_id,
            &message_uuid,
            WITHDRAWN_BY_STOP,
        )
        .await
        {
            error!(session_id, %error, "failed to persist a withdrawn follow-up's dispatch");
            broadcast_warning(
                feature_senders,
                feature_id,
                "Couldn't record that a message was not sent: Retry may not send it again. Copy it into a new message instead.",
            )
            .await;
        }
        let envelope = prompt_received_envelope(message_uuid, PromptReceiptState::DeliveryFailed);
        let message = axum::extract::ws::Message::Text(String::from(envelope).into());
        feature_senders.broadcast_all(feature_id, &message).await;
    }
}

impl super::stream_reader_task::StreamReaderTask {
    /// A turn ended. What it was handed, it or the turn the runtime starts for
    /// it took in: a later Stop stops it with that turn. A stopped turn
    /// (`stopped`) also ends the follow-ups its Stop could not withdraw: those
    /// it did not acknowledge (their receipts came before this result) never
    /// ran.
    ///
    /// `superseded`: a newer turn already began, whose follow-ups stay listed.
    pub(super) async fn settle_followups(&self, stopped: bool, superseded: bool) {
        let followups = self.app_state.active_turns.followups();
        let unwithdrawn = if superseded {
            followups.stopped_turn_ended(self.db_session_id)
        } else {
            followups.turn_ended(self.db_session_id)
        };
        if stopped && !unwithdrawn.is_empty() {
            fail_stopped_followups(
                &self.write_pool,
                &self.feature_senders,
                self.feature_id,
                self.db_session_id,
                unwithdrawn,
            )
            .await;
        }
    }
}

async fn broadcast_warning(
    feature_senders: &WsFeatureSenderRegistry,
    feature_id: i64,
    message: &str,
) {
    use crate::domain::ws_session::protocol::{SessionWarningPayload, WsEnvelope, WsSessionEvent};
    let envelope = WsEnvelope::session_event(&WsSessionEvent::Warning(SessionWarningPayload {
        code: "STATE_NOT_SAVED".into(),
        message: message.into(),
    }))
    .expect("session warning should serialize");
    let message = axum::extract::ws::Message::Text(String::from(envelope).into());
    feature_senders.broadcast_all(feature_id, &message).await;
}
