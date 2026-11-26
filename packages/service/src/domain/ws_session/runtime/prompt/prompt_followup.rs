use crate::domain::agents::adapter::RuntimeSessionHandle;
use crate::domain::ws_session::runtime::output::SessionOutput;
use tracing::info;

use crate::domain::feature_events::{FeatureEventAction, FeatureEventBroadcaster};
use crate::domain::ws_session::protocol::PromptSendPayload;
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use std::sync::Arc;
use tokio::task::JoinHandle;

use super::super::{ActiveTurnRegistry, SdkSessions};
use super::content::{
    build_content_value_for_provider, build_persist_content, expand_prompt_for_provider,
    payload_attachments,
};
use super::followup_delivery::{mark_running, FollowupDelivery};
use super::followup_dispatch::{
    append_shell_context_or_fail, claim_followup_shell_context, fail_followup_stream,
    mark_followup_dispatch_failed, mark_followup_succeeded,
};
use super::followup_turn::{acquire_followup_turn_guard, FollowupTurnGuard};
use super::followup_withdrawal::{fail_stopped_followups, withdraw_followup, WithdrawnBy};
use super::prompt_receipt::clear_pending_prompt_receipt;
use super::prompt_status::{persist_and_publish_prompt, PromptPersistenceOutcome};
use crate::domain::ws_session::runtime::followup_stops::HandOff;

/// How long `handle_followup_prompt` waits before returning to its caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::domain::ws_session) enum DeliveryWait {
    /// Interactive WS prompt: return as soon as the dispatch task is spawned.
    None,
    /// Queued user prompt: wait until the prompt is written onto the provider
    /// transport (for ACP, immediately after `session/prompt` is sent; for
    /// Codex/Claude, when `stream_input` returns). Settlement continues in the
    /// background so post-turn queue draining never blocks for a full ACP turn.
    Submission,
    /// Control/MCP/scheduled prompt: wait for full provider settlement.
    Settlement,
}

impl DeliveryWait {
    pub(super) fn waits_for_caller(self) -> bool {
        !matches!(self, Self::None)
    }
}

pub(in crate::domain::ws_session) struct FollowupPromptContext {
    pub query: RuntimeSessionHandle,
    pub user_selection: Option<super::user_selection::PromptedSelection>,
    pub delivery_lease: Option<super::super::state::RuntimeDeliveryLease>,
    pub feature_id: i64,
    pub db_session_id: i64,
    pub write_pool: sqlx::SqlitePool,
    pub session_status_tx: crate::domain::session_status::SessionStatusBroadcaster,
    pub sender: SessionOutput,
    pub ws_feature_senders: WsFeatureSenderRegistry,
    pub feature_events_tx: FeatureEventBroadcaster,
    pub envelope_id: String,
    /// Session owners for cross-device answers and turn timing.
    pub sdk_sessions: SdkSessions,
    pub active_turns: Arc<ActiveTurnRegistry>,
    pub provider_id: String,
    pub internal_replay: bool,
    /// How long the caller waits for provider delivery before returning.
    pub delivery_wait: DeliveryWait,
}

struct PreparedFollowup {
    context: FollowupPromptContext,
    turn_guard: FollowupTurnGuard,
    payload: PromptSendPayload,
    dispatch_claim: Option<(i64, String)>,
    receipt_message_uuid: Option<String>,
    conversation_references: Vec<super::conversation_references::ResolvedConversationReference>,
    delivery: FollowupDelivery,
}

pub(in crate::domain::ws_session) async fn handle_followup_prompt(
    context: FollowupPromptContext,
    payload: PromptSendPayload,
) -> Result<(), String> {
    let mut delivery = FollowupDelivery::arrive(&context);
    let persistence = persist_followup_user_message(&context, &payload).await?;
    if !persistence.should_dispatch() {
        return Ok(());
    }
    let dispatch_claim = persistence
        .dispatch_claim()
        .map(|(message_id, token)| (message_id, token.to_string()));
    let receipt_message_uuid = persistence.tracked_message_uuid(&payload);
    let conversation_references = resolve_followup_references(
        &context,
        &payload.text,
        dispatch_claim.as_ref(),
        receipt_message_uuid.as_deref(),
    )
    .await?;

    // Before the order lock and the pre-turn checkpoint: a prompt sent while
    // idle reserves its turn (the session reads working, with its Stop), one
    // sent mid-turn is already a follow-up. A Stop then cancels either, so the
    // controls received after it are let through.
    delivery.reserve_turn(&context).await;

    let Some(turn_guard) = acquire_followup_turn_guard(
        &context,
        &payload,
        persistence.message_id(),
        dispatch_claim.as_ref(),
        &mut delivery,
    )
    .await?
    else {
        return Ok(());
    };
    // A follow-up marks the session working once it is sure to be handed
    // over; a start did when it reserved its turn.
    if delivery.follows_a_turn() {
        mark_running(&context).await;
    }

    info!(context.db_session_id, "follow-up prompt");
    let prepared = PreparedFollowup {
        context,
        turn_guard,
        payload,
        dispatch_claim,
        receipt_message_uuid,
        conversation_references,
        delivery,
    };
    let wait = prepared.context.delivery_wait;
    match wait {
        DeliveryWait::None => {
            drop(tokio::spawn(stream_followup_prompt(prepared, None)));
            Ok(())
        }
        DeliveryWait::Submission => {
            if !prepared.turn_guard.runtime.signals_prompt_submission() {
                return stream_followup_prompt(prepared, None).await;
            }
            let (submitted_tx, submitted_rx) = tokio::sync::oneshot::channel();
            let mut task = tokio::spawn(stream_followup_prompt(prepared, Some(submitted_tx)));
            tokio::select! {
                submitted = submitted_rx => match submitted {
                    Ok(()) => Ok(()),
                    Err(_) => await_dispatch_task(task).await,
                },
                result = &mut task => result
                    .map_err(|error| format!("Follow-up dispatch task failed: {error}"))?,
            }
        }
        DeliveryWait::Settlement => {
            if prepared.turn_guard.runtime.negotiated_prompt_steering() != Some(true) {
                return stream_followup_prompt(prepared, None).await;
            }
            // The dispatch owns its ACP request and receipt if the control caller leaves.
            await_dispatch_task(tokio::spawn(stream_followup_prompt(prepared, None))).await
        }
    }
}

async fn await_dispatch_task(task: JoinHandle<Result<(), String>>) -> Result<(), String> {
    task.await
        .map_err(|error| format!("Follow-up dispatch task failed: {error}"))?
}

async fn resolve_followup_references(
    context: &FollowupPromptContext,
    text: &str,
    dispatch_claim: Option<&(i64, String)>,
    receipt_message_uuid: Option<&str>,
) -> Result<Vec<super::conversation_references::ResolvedConversationReference>, String> {
    match super::conversation_references::resolve(
        &context.write_pool,
        context.feature_id,
        text,
        !context.internal_replay,
    )
    .await
    {
        Ok(references) => Ok(references),
        Err(error) => {
            mark_followup_dispatch_failed(context, dispatch_claim, &error).await;
            if let Some(message_uuid) = receipt_message_uuid {
                clear_pending_prompt_receipt(
                    &context.write_pool,
                    &context.ws_feature_senders,
                    &context.sender,
                    context.feature_id,
                    context.db_session_id,
                    message_uuid.to_string(),
                )
                .await;
            }
            Err(error)
        }
    }
}

async fn persist_followup_user_message(
    context: &FollowupPromptContext,
    payload: &PromptSendPayload,
) -> Result<PromptPersistenceOutcome, String> {
    let attachments = payload_attachments(payload);
    let persist_content = build_persist_content(&payload.text, &attachments);
    // The previous turn's closing line goes before this prompt.
    context
        .session_status_tx
        .journal()
        .flush(&context.write_pool, &context.ws_feature_senders)
        .await;
    let outcome = persist_and_publish_prompt()
        .pool(&context.write_pool)
        .feature_senders(&context.ws_feature_senders)
        .sender(&context.sender)
        .feature_id(context.feature_id)
        .session_id(context.db_session_id)
        .payload(payload)
        .content(&persist_content)
        .internal_replay(context.internal_replay)
        .call()
        .await?;
    // Reorder every client's sidebar after a new user message.
    if outcome.inserted() {
        context
            .feature_events_tx
            .emit(context.feature_id, None, FeatureEventAction::Reordered);
    }
    Ok(outcome)
}

async fn stream_followup_prompt(
    prepared: PreparedFollowup,
    mut submitted: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<(), String> {
    let PreparedFollowup {
        mut context,
        mut turn_guard,
        payload,
        dispatch_claim,
        receipt_message_uuid,
        conversation_references,
        mut delivery,
    } = prepared;
    let shell_context =
        claim_followup_shell_context(&context, &payload, dispatch_claim.as_ref()).await?;
    let attachments = payload_attachments(&payload);
    // Expand Cadencr prompt directives only for the provider. The persisted
    // user message keeps the concise command and conversation-reference tokens.
    let prompt_text = expand_prompt_for_provider(&payload.text, &conversation_references);
    let prompt_text = append_shell_context_or_fail(
        &context,
        &shell_context,
        prompt_text,
        dispatch_claim.as_ref(),
    )
    .await?;
    let content =
        build_content_value_for_provider(&context.provider_id, &prompt_text, &attachments);
    if !delivery.claim_hand_over(&context).await {
        drop(turn_guard);
        drop(context.delivery_lease.take());
        return withdraw_followup(
            &context,
            &payload,
            Some(shell_context),
            dispatch_claim.as_ref(),
            delivery.turn_to_end(),
            WithdrawnBy::Stop,
        )
        .await;
    }
    let stream_result = turn_guard
        .runtime
        .stream_input_with_delivery_order(
            content,
            receipt_message_uuid.clone(),
            &mut turn_guard.followup_order,
            &mut submitted,
        )
        .await;
    // Derive caller state directly from whether `submitted` was consumed: if
    // the runtime took and fired it, the caller already got `Ok(())`.
    let caller_still_waiting = matches!(context.delivery_wait, DeliveryWait::Settlement)
        || (matches!(context.delivery_wait, DeliveryWait::Submission) && submitted.is_some());
    settle_followup_stream()
        .context(context)
        .turn_guard(turn_guard)
        .payload(payload)
        .shell_context(shell_context)
        .maybe_dispatch_claim(dispatch_claim)
        .maybe_receipt_message_uuid(receipt_message_uuid)
        .delivery(delivery)
        .stream_result(stream_result)
        .caller_still_waiting(caller_still_waiting)
        .call()
        .await
}

#[bon::builder]
async fn settle_followup_stream(
    mut context: FollowupPromptContext,
    turn_guard: FollowupTurnGuard,
    payload: PromptSendPayload,
    shell_context: super::user_shell_context::PendingUserShellContext,
    dispatch_claim: Option<(i64, String)>,
    receipt_message_uuid: Option<String>,
    mut delivery: FollowupDelivery,
    stream_result: Result<(), crate::domain::agents::adapter::RuntimeError>,
    caller_still_waiting: bool,
) -> Result<(), String> {
    // Recorded before the barrier drops: a Stop that follows withdraws it,
    // and finds its dispatch final.
    let selection = match (&stream_result, context.user_selection.take()) {
        (Ok(()), Some(selection)) => Some(selection.delivered(&**turn_guard.runtime).await),
        _ => None,
    };
    if stream_result.is_ok() {
        mark_followup_succeeded(&context, dispatch_claim.as_ref()).await;
        if let (Some(accepted), Some(id)) = (delivery.accepted, receipt_message_uuid.as_ref()) {
            let followups = context.active_turns.followups();
            if followups.handed_off(context.db_session_id, accepted, id.clone())
                == HandOff::SettleNow
            {
                fail_stopped_followups(
                    &context.write_pool,
                    &context.ws_feature_senders,
                    context.feature_id,
                    context.db_session_id,
                    vec![id.clone()],
                )
                .await;
            }
        }
    }
    drop(turn_guard);
    drop(context.delivery_lease.take());
    if let Some(selection) = selection {
        selection
            .remember(&context.sender, &context.envelope_id)
            .await;
    }
    if let Err(error) = stream_result {
        if error.is_input_withdrawn() {
            return withdraw_followup(
                &context,
                &payload,
                Some(shell_context),
                dispatch_claim.as_ref(),
                delivery.turn_to_end(),
                WithdrawnBy::Stop,
            )
            .await;
        }
        shell_context
            .release_or_warn(&context.write_pool, &context.sender, &context.envelope_id)
            .await;
        return fail_followup_stream()
            .context(&context)
            .maybe_dispatch_claim(dispatch_claim.as_ref())
            .maybe_receipt_message_uuid(receipt_message_uuid)
            .error(&error)
            .preserve_running_turn(delivery.preserve_running_turn)
            .caller_still_waiting(caller_still_waiting)
            .call()
            .await;
    }
    shell_context
        .mark_delivered_or_warn(&context.write_pool, &context.sender, &context.envelope_id)
        .await;
    Ok(())
}
