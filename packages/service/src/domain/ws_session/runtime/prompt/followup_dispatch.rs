//! A follow-up's dispatch record (`agent_message_dispatches`), which control
//! callers such as MCP steers and the prompt queue wait on.

use tracing::error;

use super::prompt_followup::FollowupPromptContext;

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
