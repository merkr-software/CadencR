//! A follow-up's dispatch record (`agent_message_dispatches`), which control
//! callers such as MCP steers and the prompt queue wait on.

use tracing::error;

use crate::domain::agents::adapter::RuntimeError;
use crate::domain::ws_session::protocol::PromptSendPayload;

use super::errors::persist_pause_and_send_session_error;
use super::prompt_followup::FollowupPromptContext;
use super::prompt_receipt::clear_pending_prompt_receipt;
use super::user_shell_context::{claim_pending_user_shell_context, PendingUserShellContext};

pub(super) async fn mark_followup_dispatch_failed(
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

pub(super) async fn mark_followup_succeeded(
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

pub(super) async fn claim_followup_shell_context(
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

pub(super) async fn fail_followup_stream(
    context: &FollowupPromptContext,
    dispatch_claim: Option<&(i64, String)>,
    receipt_message_uuid: Option<String>,
    error: &RuntimeError,
    preserve_running_turn: bool,
) -> Result<(), String> {
    let message = error.to_string();
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
    if let RuntimeError::PromptDeliveryFailed {
        surfaced_on_stream, ..
    } = error
    {
        if !context.wait_for_delivery && !surfaced_on_stream {
            crate::domain::ws_session::runtime::helpers::send_warning(
                &context.sender,
                &context.envelope_id,
                "PROMPT_DELIVERY_FAILED",
                &message,
            );
        }
        return Err(message);
    }
    if error.is_stop_escalation() {
        return Err(message);
    }
    // Refusing this queued steer does not end the already-running turn.
    // The control caller surfaces the error on the durable queue entry.
    if preserve_running_turn {
        return Err(message);
    }
    persist_pause_and_send_session_error()
        .pool(&context.write_pool)
        .session_status_tx(&context.session_status_tx)
        .sender(&context.sender)
        .ref_id(&context.envelope_id)
        .feature_id(context.feature_id)
        .session_id(context.db_session_id)
        .code(error.session_error_code())
        .message(&message)
        .call()
        .await;
    Err(message)
}
