//! Delivering queued prompts: one per finished turn, or on demand.

use crate::app_state::AppState;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::runtime::application::dispatch_control_prompt_with_message_uuid;
use crate::error::AppError;

use super::store::{self, QueuedPrompt};

/// Deliver the oldest pending prompt right after a turn finished; true when
/// one was sent. The caller (the stream reader's post-result hook) has already
/// checked that no permission or question waits on the user; the finished
/// turn's owner is still registered at that point, which is what routes the
/// prompt into it. A failed delivery is recorded on the prompt's row, which
/// the queue shows; only the log can carry a failure to read the queue.
pub async fn drain_next_after_turn(state: &AppState, session_id: i64) -> bool {
    match drain_next_if_idle(state, session_id).await {
        Ok(delivered) => delivered,
        Err(error) => {
            tracing::error!(session_id, %error, "failed to deliver queued user prompt");
            false
        }
    }
}

/// Deliver the oldest pending prompt if the session is free to take it: no
/// turn in flight and no permission or question waiting on the user. Called
/// right after an enqueue, so a prompt queued just as the turn ended is not
/// stranded until the next one.
pub async fn drain_next_if_idle(state: &AppState, session_id: i64) -> Result<bool, AppError> {
    let mut delivered = false;
    loop {
        // Every finished turn lands here; an empty queue must not cost a write.
        if !store::has_pending(&state.read_pool, session_id).await? {
            return Ok(delivered);
        }
        if !session_is_idle(state, session_id).await {
            return Ok(delivered);
        }
        let Some(prompt) = store::claim(&state.write_pool, session_id, None).await? else {
            return Ok(delivered);
        };
        deliver(state, prompt).await?;
        delivered = true;
        // A very short turn can finish while its delivery RPC is pending.
        // Its result couldn't claim the next row while this one was delivering.
    }
}

/// Send one queued prompt now. While the agent works this steers the running
/// turn exactly like typing it and pressing Enter; otherwise it starts a turn.
pub async fn send_now(state: &AppState, session_id: i64, id: i64) -> Result<(), AppError> {
    if requires_queue(state, session_id).await {
        return Ok(());
    }
    let prompt = store::claim(&state.write_pool, session_id, Some(id))
        .await?
        .ok_or_else(store::not_editable)?;
    deliver(state, prompt).await?;
    drain_next_if_idle(state, session_id).await?;
    Ok(())
}

/// Provider-neutral live input policy; compaction details stay in the adapter.
pub(crate) async fn requires_queue(state: &AppState, session_id: i64) -> bool {
    state.active_turns.requires_prompt_queue(session_id).await
}

async fn session_is_idle(state: &AppState, session_id: i64) -> bool {
    // A connected idle runtime still has an owner. Ownership routes delivery;
    // the authoritative status determines whether a turn is actually running.
    if state.session_status_tx.is_busy(session_id) || requires_queue(state, session_id).await {
        return false;
    }
    WsSessionPersistence::get_session_row(&state.read_pool, session_id)
        .await
        .is_some_and(|row| row.status != "running" && !row.has_pending_user_input())
}

async fn deliver(state: &AppState, prompt: QueuedPrompt) -> Result<(), AppError> {
    let result = deliver_claimed(state, &prompt).await;
    match &result {
        Ok(()) => store::mark_delivered(&state.write_pool, prompt.id).await?,
        Err(error) => store::mark_error(&state.write_pool, prompt.id, &error.to_string()).await?,
    }
    super::notify_changed(state, prompt.session_id);
    result
}

async fn deliver_claimed(state: &AppState, prompt: &QueuedPrompt) -> Result<(), AppError> {
    let feature_id: i64 = sqlx::query_scalar("SELECT feature_id FROM agent_sessions WHERE id = ?")
        .bind(prompt.session_id)
        .fetch_optional(&state.read_pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;
    // `replay = false`: persisted and mirrored to every client as the user's
    // own message, like a scheduled prompt.
    // A retry is the same logical user message, including after a failed
    // runtime spawn. Keep its dispatch identity stable without duplicating
    // the transcript on each retry.
    let message_uuid = match &prompt.message_uuid {
        Some(value) => uuid::Uuid::parse_str(value).map_err(|error| {
            AppError::Internal(format!("Invalid queued message identity: {error}"))
        })?,
        // Rows queued before message identities were persisted keep a stable
        // retry identity as well.
        None => uuid::Uuid::new_v5(
            &uuid::Uuid::from_u128(0xcade_cc00_0000_4000_8000_0000_0000_0000),
            format!("{}:{}", prompt.id, prompt.content).as_bytes(),
        ),
    };
    dispatch_control_prompt_with_message_uuid(
        state,
        feature_id,
        prompt.session_id,
        &prompt.content,
        false,
        Some(message_uuid),
    )
    .await
    .map(|outcome| outcome.delivery_confirmed())
}
