use tracing::error;

use super::super::prompt_receipt::clear_pending_prompt_receipt;
use super::PendingPromptContext;

pub(in crate::domain::ws_session) async fn fail_pending_receipt(
    context: &PendingPromptContext,
    message_uuid: Option<&str>,
    dispatch_claim: Option<&(i64, String)>,
    error: &str,
) {
    if let Some((message_id, token)) = dispatch_claim {
        if let Err(status_error) = crate::domain::sessions::message_dispatch::mark_failed(
            &context.app_state.write_pool,
            *message_id,
            token,
            error,
        )
        .await
        {
            error!(context.db_session_id, error = %status_error, "failed to persist prompt dispatch failure");
        }
    }
    let Some(message_uuid) = message_uuid else {
        return;
    };
    let owner_closed = clear_pending_prompt_receipt(
        &context.app_state.write_pool,
        &context.app_state.ws_feature_senders,
        &context.sender,
        context.feature_id,
        context.db_session_id,
        message_uuid.to_string(),
    )
    .await;
    if owner_closed {
        error!(
            context.db_session_id,
            "prompt delivery-failed receipt owner disconnected"
        );
    }
}

pub(in crate::domain::ws_session) async fn mark_pending_dispatch_succeeded(
    context: &PendingPromptContext,
    claim: Option<&(i64, String)>,
) {
    let Some((message_id, token)) = claim else {
        return;
    };
    if let Err(error) = crate::domain::sessions::message_dispatch::mark_succeeded(
        &context.app_state.write_pool,
        *message_id,
        token,
    )
    .await
    {
        error!(context.db_session_id, error = %error, "failed to persist prompt dispatch success");
    }
}
