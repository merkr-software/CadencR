use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeSessionHandle};
use crate::domain::ws_session::runtime::output::SessionOutput;
use tracing::info;

struct FollowupTurnGuard {
    runtime: tokio::sync::OwnedRwLockReadGuard<Box<dyn AgentRuntimeSession>>,
    _barrier: Option<tokio::sync::OwnedMutexGuard<()>>,
    followup_order: Option<tokio::sync::OwnedMutexGuard<()>>,
}
use crate::domain::feature_events::{FeatureEventAction, FeatureEventBroadcaster};
use crate::domain::ws_session::protocol::PromptSendPayload;
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use std::sync::Arc;

use super::super::{ActiveTurnRegistry, SdkSessions};
use super::content::{
    build_content_value_for_provider, build_persist_content, expand_prompt_for_provider,
    payload_attachments,
};
use super::errors::persist_pause_and_send_session_error;
use super::followup_dispatch::{
    claim_followup_shell_context, fail_followup_stream, mark_followup_dispatch_failed,
    mark_followup_succeeded,
};
use super::followup_withdrawal::{
    fail_stopped_followups, stopped_since_accepted, withdraw_followup, FollowupDelivery,
};
use super::prompt_receipt::clear_pending_prompt_receipt;
use super::prompt_status::{
    mark_agent_running, persist_and_publish_prompt, PromptPersistenceOutcome,
};
use crate::domain::ws_session::runtime::followup_stops::HandOff;

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
    /// Control callers must observe the provider's delivery result before
    /// acknowledging a queued or scheduled prompt.
    pub wait_for_delivery: bool,
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
    let turn_running = context.session_status_tx.is_busy(context.db_session_id);
    let mut delivery = FollowupDelivery {
        preserve_running_turn: context.wait_for_delivery && turn_running,
        accepted: turn_running.then(|| {
            context
                .active_turns
                .followups()
                .accept(context.db_session_id)
        }),
        turn_generation: None,
    };
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

    // A mid-turn follow-up is registered in FollowupStops. Let Stop through
    // before the order lock and checkpoint. An idle prompt first reserves its turn.
    if delivery.accepted.is_some() {
        crate::domain::ws_session::handler::let_controls_through();
    }

    let Some(turn_guard) = acquire_followup_turn_guard(
        &context,
        &payload,
        persistence.message_id(),
        dispatch_claim.as_ref(),
        &delivery,
    )
    .await?
    else {
        return Ok(());
    };

    mark_agent_running(
        &context.write_pool,
        &context.session_status_tx,
        &context.ws_feature_senders,
        &context.active_turns,
        &context.sdk_sessions,
        context.db_session_id,
        context.feature_id,
    )
    .await;

    delivery.turn_generation = context
        .active_turns
        .current_generation(context.db_session_id)
        .await;

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
    let wait = prepared.context.wait_for_delivery;
    if wait && prepared.turn_guard.runtime.negotiated_prompt_steering() != Some(true) {
        return stream_followup_prompt(prepared).await;
    }
    // The dispatch owns its ACP request and receipt if the control caller leaves.
    let task = tokio::spawn(stream_followup_prompt(prepared));
    if wait {
        return task
            .await
            .map_err(|error| format!("Follow-up dispatch task failed: {error}"))?;
    }
    drop(task);
    Ok(())
}

/// Serialize back-to-back follow-ups in FIFO order, capture the pre-turn git
/// checkpoint before locking the runtime, and acquire the runtime + turn
/// barrier. Returns `Ok(None)` if a concurrent Stop withdrew the follow-up.
async fn acquire_followup_turn_guard(
    context: &FollowupPromptContext,
    payload: &PromptSendPayload,
    message_id: Option<i64>,
    dispatch_claim: Option<&(i64, String)>,
    delivery: &FollowupDelivery,
) -> Result<Option<FollowupTurnGuard>, String> {
    let followup_order = context
        .active_turns
        .lock_followup_delivery(context.db_session_id)
        .await;
    if stopped_since_accepted(context, delivery) {
        drop(followup_order);
        withdraw_followup(context, payload, None, dispatch_claim, None).await?;
        return Ok(None);
    }

    // Snapshot the worktree *before* this turn's prompt is delivered to the live
    // agent (`stream_input`), so a later rewind to this message can restore the
    // pre-turn code state. A deliberate pre-turn barrier.
    super::prompt_checkpoint::capture_pre_turn_followup(context, message_id).await;

    // Retain this read guard through dispatch. Reacquiring it while holding
    // the barrier could deadlock against a queued writer and another control.
    let runtime = context.query.clone().read_owned().await;
    let barrier = runtime.turn_control_guard().await;
    let turn_guard = FollowupTurnGuard {
        runtime,
        _barrier: barrier,
        followup_order: Some(followup_order),
    };
    // Before it starts a turn: a Stop that came meanwhile ended the one it
    // followed, and nothing would end the turn it starts.
    if stopped_since_accepted(context, delivery) {
        drop(turn_guard);
        withdraw_followup(context, payload, None, dispatch_claim, None).await?;
        return Ok(None);
    }
    Ok(Some(turn_guard))
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

async fn stream_followup_prompt(prepared: PreparedFollowup) -> Result<(), String> {
    let PreparedFollowup {
        mut context,
        mut turn_guard,
        payload,
        dispatch_claim,
        receipt_message_uuid,
        conversation_references,
        delivery,
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
    if stopped_since_accepted(&context, &delivery) {
        drop(turn_guard);
        drop(context.delivery_lease.take());
        return withdraw_followup(
            &context,
            &payload,
            Some(shell_context),
            dispatch_claim.as_ref(),
            delivery.turn_to_end(),
        )
        .await;
    }
    let stream_result = turn_guard
        .runtime
        .stream_input_with_delivery_order(
            content,
            receipt_message_uuid.clone(),
            &mut turn_guard.followup_order,
        )
        .await;
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
            )
            .await;
        }
        shell_context
            .release_or_warn(&context.write_pool, &context.sender, &context.envelope_id)
            .await;
        return fail_followup_stream(
            &context,
            dispatch_claim.as_ref(),
            receipt_message_uuid,
            &error,
            delivery.preserve_running_turn,
        )
        .await;
    }
    shell_context
        .mark_delivered_or_warn(&context.write_pool, &context.sender, &context.envelope_id)
        .await;
    Ok(())
}

async fn append_shell_context_or_fail<'a>(
    context: &FollowupPromptContext,
    shell_context: &super::user_shell_context::PendingUserShellContext,
    prompt_text: std::borrow::Cow<'a, str>,
    dispatch_claim: Option<&(i64, String)>,
) -> Result<std::borrow::Cow<'a, str>, String> {
    match shell_context.append_to_prompt(prompt_text) {
        Ok(prompt) => Ok(prompt),
        Err(message) => {
            shell_context
                .release_or_warn(&context.write_pool, &context.sender, &context.envelope_id)
                .await;
            mark_followup_dispatch_failed(context, dispatch_claim, &message).await;
            persist_pause_and_send_session_error()
                .pool(&context.write_pool)
                .session_status_tx(&context.session_status_tx)
                .sender(&context.sender)
                .ref_id(&context.envelope_id)
                .feature_id(context.feature_id)
                .session_id(context.db_session_id)
                .code("USER_SHELL_CONTEXT_ERROR")
                .message(&message)
                .call()
                .await;
            Err(message)
        }
    }
}
