use tracing::{error, info};

use crate::domain::agents::adapter::RuntimeSessionHandle;
use crate::domain::feature_events::{FeatureEventAction, FeatureEventBroadcaster};
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::PromptSendPayload;
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use std::sync::Arc;

use super::super::{ActiveTurnRegistry, SdkSessions, WsSender};
use super::content::{
    build_content_value_for_provider, build_persist_content, payload_attachments,
};
use super::errors::persist_pause_and_send_session_error;
use super::prompt_status::{
    ack_persisted_user_message, clear_pending_prompt_receipt, mark_agent_running,
    mirror_user_message,
};

pub(super) struct FollowupPromptContext {
    pub query: RuntimeSessionHandle,
    pub feature_id: i64,
    pub db_session_id: i64,
    pub write_pool: sqlx::SqlitePool,
    pub session_status_tx: crate::domain::session_status::SessionStatusBroadcaster,
    pub sender: WsSender,
    pub ws_feature_senders: WsFeatureSenderRegistry,
    pub feature_events_tx: FeatureEventBroadcaster,
    pub envelope_id: String,
    /// The owning connection's session map + the global registry, so a
    /// follow-up turn re-stamps the start time and owner (single source of
    /// truth for the synced timer + cross-device answers).
    pub sdk_sessions: SdkSessions,
    pub active_turns: Arc<ActiveTurnRegistry>,
    pub provider_id: String,
}

pub(super) async fn handle_followup_prompt(
    context: FollowupPromptContext,
    payload: PromptSendPayload,
) {
    let user_message_id = persist_followup_user_message(&context, &payload).await;
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
    super::prompt_checkpoint::capture_pre_turn_followup(&context, user_message_id).await;

    info!(context.db_session_id, "follow-up prompt");
    tokio::spawn(stream_followup_prompt(context, payload));
}

async fn persist_followup_user_message(
    context: &FollowupPromptContext,
    payload: &PromptSendPayload,
) -> Option<i64> {
    if payload.replay {
        return None;
    }
    let attachments = payload_attachments(payload);
    let persist_content = build_persist_content(&payload.text, &attachments);
    let persistence = WsSessionPersistence::with_session_id(
        context.write_pool.clone(),
        context.feature_id,
        Some(context.db_session_id),
    );
    let user_message_id = persistence.persist_user_message(&persist_content).await;
    if let (Some(user_message_ref), Some(message_id)) =
        (payload.user_message_ref.as_deref(), user_message_id)
    {
        ack_persisted_user_message(&context.sender, user_message_ref, message_id).await;
    }
    mirror_user_message(
        &context.ws_feature_senders,
        &context.sender,
        context.feature_id,
        &persist_content,
    )
    .await;
    // The user message changed this feature's most-recent-user-message sort
    // key. Broadcast so every client's sidebar re-sorts conversations and
    // floats this one to the top of its project.
    context
        .feature_events_tx
        .emit(context.feature_id, None, FeatureEventAction::Reordered);
    user_message_id
}

async fn stream_followup_prompt(context: FollowupPromptContext, payload: PromptSendPayload) {
    let attachments = payload_attachments(&payload);
    let content =
        build_content_value_for_provider(&context.provider_id, &payload.text, &attachments);
    let client_message_id = payload.client_message_id.clone();
    let query_guard = context.query.read().await;
    let stream_result = query_guard
        .stream_input_with_client_message_id(content, client_message_id.clone())
        .await;
    drop(query_guard);

    if let Err(error) = stream_result {
        let message = error.to_string();
        error!(context.db_session_id, error = %message, "stream_input failed");
        if let Some(client_message_id) = client_message_id {
            clear_pending_prompt_receipt(
                &context.ws_feature_senders,
                &context.sender,
                context.feature_id,
                client_message_id,
            )
            .await;
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
    }
}
