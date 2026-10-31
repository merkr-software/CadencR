use crate::domain::ws_session::runtime::output::SessionOutput;
use tracing::{error, info};

use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeSessionHandle};

struct FollowupTurnGuard {
    runtime: tokio::sync::OwnedRwLockReadGuard<Box<dyn AgentRuntimeSession>>,
    _barrier: Option<tokio::sync::OwnedMutexGuard<()>>,
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
use super::prompt_receipt::clear_pending_prompt_receipt;
use super::prompt_status::{
    mark_agent_running, persist_and_publish_prompt, PromptPersistenceOutcome,
};
use super::user_shell_context::{claim_pending_user_shell_context, PendingUserShellContext};

pub(in crate::domain::ws_session) struct FollowupPromptContext {
    pub query: RuntimeSessionHandle,
    pub delivery_lease: Option<super::super::state::RuntimeDeliveryLease>,
    pub feature_id: i64,
    pub db_session_id: i64,
    pub write_pool: sqlx::SqlitePool,
    pub session_status_tx: crate::domain::session_status::SessionStatusBroadcaster,
    pub sender: SessionOutput,
    pub ws_feature_senders: WsFeatureSenderRegistry,
    pub feature_events_tx: FeatureEventBroadcaster,
    pub envelope_id: String,
    /// The owning connection's session map + the global registry, so a
    /// follow-up turn re-stamps the start time and owner (single source of
    /// truth for the synced timer + cross-device answers).
    pub sdk_sessions: SdkSessions,
    pub active_turns: Arc<ActiveTurnRegistry>,
    pub provider_id: String,
    pub internal_replay: bool,
    /// Control callers must observe the provider's delivery result before
    /// acknowledging a queued or scheduled prompt.
    pub wait_for_delivery: bool,
}

pub(in crate::domain::ws_session) async fn handle_followup_prompt(
    context: FollowupPromptContext,
    payload: PromptSendPayload,
) -> Result<(), String> {
    let preserve_running_turn =
        context.wait_for_delivery && context.session_status_tx.is_busy(context.db_session_id);
    let persistence = persist_followup_user_message(&context, &payload).await?;
    if !persistence.should_dispatch() {
        return Ok(());
    }
    let dispatch_claim = persistence
        .dispatch_claim()
        .map(|(message_id, token)| (message_id, token.to_string()));
    let receipt_message_uuid = persistence.tracked_message_uuid(&payload);
    let conversation_references = match super::conversation_references::resolve(
        &context.write_pool,
        context.feature_id,
        &payload.text,
        !context.internal_replay,
    )
    .await
    {
        Ok(references) => references,
        Err(error) => {
            mark_followup_dispatch_failed(&context, dispatch_claim.as_ref(), &error).await;
            if let Some(message_uuid) = receipt_message_uuid {
                let _ = clear_pending_prompt_receipt(
                    &context.write_pool,
                    &context.ws_feature_senders,
                    &context.sender,
                    context.feature_id,
                    context.db_session_id,
                    message_uuid,
                )
                .await;
            }
            return Err(error);
        }
    };
    // Retain this read guard through dispatch. Reacquiring it while holding
    // the barrier could deadlock against a queued writer and another control.
    let runtime = context.query.clone().read_owned().await;
    let barrier = runtime.turn_control_guard().await;
    let turn_guard = FollowupTurnGuard {
        runtime,
        _barrier: barrier,
    };
    mark_agent_running(
        &context.write_pool,
        &context.session_status_tx,
        &context.active_turns,
        &context.sdk_sessions,
        context.db_session_id,
        context.feature_id,
    )
    .await;

    // Snapshot the worktree *before* this turn's prompt is delivered to the live
    // agent (the `stream_input` below), so a later rewind to this message can
    // restore the pre-turn code state. A deliberate pre-turn barrier.
    super::prompt_checkpoint::capture_pre_turn_followup(&context, persistence.message_id()).await;

    info!(context.db_session_id, "follow-up prompt");
    if context.wait_for_delivery {
        return stream_followup_prompt(
            context,
            turn_guard,
            payload,
            dispatch_claim,
            receipt_message_uuid,
            conversation_references,
            preserve_running_turn,
        )
        .await;
    }
    tokio::spawn(async move {
        let _ = stream_followup_prompt(
            context,
            turn_guard,
            payload,
            dispatch_claim,
            receipt_message_uuid,
            conversation_references,
            preserve_running_turn,
        )
        .await;
    });
    Ok(())
}

async fn persist_followup_user_message(
    context: &FollowupPromptContext,
    payload: &PromptSendPayload,
) -> Result<PromptPersistenceOutcome, String> {
    let attachments = payload_attachments(payload);
    let persist_content = build_persist_content(&payload.text, &attachments);
    let outcome = persist_and_publish_prompt(
        &context.write_pool,
        &context.ws_feature_senders,
        &context.sender,
        context.feature_id,
        context.db_session_id,
        payload,
        &persist_content,
        context.internal_replay,
    )
    .await?;
    // The user message changed this feature's most-recent-user-message sort
    // key. Broadcast so every client's sidebar re-sorts conversations and
    // floats this one to the top of its project.
    if outcome.inserted() {
        context
            .feature_events_tx
            .emit(context.feature_id, None, FeatureEventAction::Reordered);
    }
    Ok(outcome)
}

async fn stream_followup_prompt(
    mut context: FollowupPromptContext,
    turn_guard: FollowupTurnGuard,
    payload: PromptSendPayload,
    dispatch_claim: Option<(i64, String)>,
    receipt_message_uuid: Option<String>,
    conversation_references: Vec<super::conversation_references::ResolvedConversationReference>,
    preserve_running_turn: bool,
) -> Result<(), String> {
    let shell_context =
        claim_followup_shell_context(&context, &payload, dispatch_claim.as_ref()).await?;
    let attachments = payload_attachments(&payload);
    // Expand Cadencr prompt directives only for the provider. The persisted
    // user message keeps the concise command and conversation-reference tokens.
    let prompt_text = expand_prompt_for_provider(&payload.text, &conversation_references);
    let prompt_text = match shell_context.append_to_prompt(prompt_text) {
        Ok(prompt) => prompt,
        Err(message) => {
            let _ = shell_context.release(&context.write_pool).await;
            mark_followup_dispatch_failed(&context, dispatch_claim.as_ref(), &message).await;
            persist_pause_and_send_session_error(
                &context.write_pool,
                &context.session_status_tx,
                &context.sender,
                &context.envelope_id,
                context.feature_id,
                context.db_session_id,
                "USER_SHELL_CONTEXT_ERROR",
                &message,
            )
            .await;
            return Err(message);
        }
    };
    let content =
        build_content_value_for_provider(&context.provider_id, &prompt_text, &attachments);
    let stream_result = turn_guard
        .runtime
        .stream_input_with_client_message_id(content, receipt_message_uuid.clone())
        .await;
    drop(turn_guard);
    drop(context.delivery_lease.take());

    if let Err(error) = stream_result {
        let message = error.to_string();
        if let Err(release_error) = shell_context.release(&context.write_pool).await {
            error!(context.db_session_id, error = %release_error, "failed to release user shell context claim");
        }
        return fail_followup_stream(
            &context,
            dispatch_claim.as_ref(),
            receipt_message_uuid,
            message,
            preserve_running_turn,
        )
        .await;
    }
    if let Err(error) = shell_context.mark_delivered(&context.write_pool).await {
        error!(context.db_session_id, %error, "failed to mark user shell context delivered");
        super::super::helpers::send_warning(
            &context.sender,
            &context.envelope_id,
            "USER_SHELL_CONTEXT_STATE_ERROR",
            &error,
        );
    }
    mark_followup_succeeded(&context, dispatch_claim.as_ref()).await;
    Ok(())
}

async fn claim_followup_shell_context(
    context: &FollowupPromptContext,
    payload: &PromptSendPayload,
    dispatch_claim: Option<&(i64, String)>,
) -> Result<PendingUserShellContext, String> {
    let shell_delivery_id = payload
        .message_uuid
        .as_deref()
        .unwrap_or(&context.envelope_id);
    match claim_pending_user_shell_context(
        &context.write_pool,
        context.db_session_id,
        shell_delivery_id,
    )
    .await
    {
        Ok(shell_context) => Ok(shell_context),
        Err(message) => {
            mark_followup_dispatch_failed(context, dispatch_claim, &message).await;
            persist_pause_and_send_session_error(
                &context.write_pool,
                &context.session_status_tx,
                &context.sender,
                &context.envelope_id,
                context.feature_id,
                context.db_session_id,
                "USER_SHELL_CONTEXT_ERROR",
                &message,
            )
            .await;
            Err(message)
        }
    }
}

async fn mark_followup_dispatch_failed(
    context: &FollowupPromptContext,
    claim: Option<&(i64, String)>,
    error: &str,
) {
    let Some((message_id, token)) = claim else {
        return;
    };
    if let Err(status_error) = crate::domain::sessions::message_dispatch::mark_failed(
        &context.write_pool,
        *message_id,
        token,
        error,
    )
    .await
    {
        tracing::error!(context.db_session_id, error = %status_error, "failed to persist prompt dispatch failure");
    }
}

async fn fail_followup_stream(
    context: &FollowupPromptContext,
    dispatch_claim: Option<&(i64, String)>,
    receipt_message_uuid: Option<String>,
    message: String,
    preserve_running_turn: bool,
) -> Result<(), String> {
    mark_followup_dispatch_failed(context, dispatch_claim, &message).await;
    error!(context.db_session_id, error = %message, "stream_input failed");
    if let Some(message_uuid) = receipt_message_uuid {
        let owner_closed = clear_pending_prompt_receipt(
            &context.write_pool,
            &context.ws_feature_senders,
            &context.sender,
            context.feature_id,
            context.db_session_id,
            message_uuid,
        )
        .await;
        if owner_closed {
            error!(
                context.db_session_id,
                "prompt delivery-failed receipt owner disconnected"
            );
        }
    }
    // Refusing this queued steer does not end the already-running turn.
    // The control caller surfaces the error on the durable queue entry.
    if preserve_running_turn {
        return Err(message);
    }
    persist_pause_and_send_session_error(
        &context.write_pool,
        &context.session_status_tx,
        &context.sender,
        &context.envelope_id,
        context.feature_id,
        context.db_session_id,
        "SDK_ERROR",
        &message,
    )
    .await;
    Err(message)
}

async fn mark_followup_succeeded(
    context: &FollowupPromptContext,
    dispatch_claim: Option<&(i64, String)>,
) {
    if let Some((message_id, token)) = dispatch_claim {
        if let Err(error) = crate::domain::sessions::message_dispatch::mark_succeeded(
            &context.write_pool,
            *message_id,
            token,
        )
        .await
        {
            error!(context.db_session_id, error = %error, "failed to persist prompt dispatch success");
        }
    }
}
