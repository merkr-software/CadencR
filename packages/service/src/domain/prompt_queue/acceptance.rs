use crate::app_state::AppState;
use crate::domain::ws_session::protocol::PromptSendPayload;
use crate::error::AppError;

use super::{delivery, store};

pub(super) fn validated(content: &str) -> Result<&str, AppError> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest(
            "A queued message can't be empty.".into(),
        ));
    }
    if trimmed.len() > 256 * 1024 {
        return Err(AppError::BadRequest(
            "This message is too long to queue.".into(),
        ));
    }
    Ok(trimmed)
}

pub(super) async fn enqueue(
    state: &AppState,
    session_id: i64,
    content: &str,
) -> Result<store::QueuedPrompt, AppError> {
    let prompt = store::enqueue(&state.write_pool, session_id, validated(content)?).await?;
    accepted(state, session_id).await;
    Ok(prompt)
}

/// A retransmission of a deferred request remains accepted, including after
/// delivery, editing or cancellation. Only a new request may start a new turn.
pub(crate) async fn defer_if_required(
    state: &AppState,
    session_id: i64,
    payload: &PromptSendPayload,
) -> Result<bool, AppError> {
    let message_uuid = payload.message_uuid.as_deref().ok_or_else(|| {
        AppError::BadRequest("A prompt must have a canonical message identity.".into())
    })?;
    if store::has_source(&state.read_pool, session_id, message_uuid).await? {
        return Ok(true);
    }
    if !delivery::requires_queue(state, session_id).await {
        return Ok(false);
    }
    if !payload.attachments.is_empty() || !payload.images.is_empty() {
        return Err(AppError::BadRequest(
            "Compaction is in progress. Keep attachments in the composer until it finishes.".into(),
        ));
    }
    if store::enqueue_deferred(
        &state.write_pool,
        session_id,
        validated(&payload.text)?,
        message_uuid,
    )
    .await?
    {
        accepted(state, session_id).await;
    }
    Ok(true)
}

async fn accepted(state: &AppState, session_id: i64) {
    super::notify_changed(state, session_id);
    // The turn may have ended before acceptance. Delivery failures belong on
    // the queue row; rejecting acceptance would also restore the composer.
    if let Err(error) = delivery::drain_next_if_idle(state, session_id).await {
        tracing::warn!(session_id, %error, "queued prompt could not be delivered right away");
    }
}
