use super::super::content::{
    build_content_value_for_provider, expand_prompt_for_provider, payload_attachments,
};
use super::super::errors::persist_pause_and_send_session_error;
use super::super::prompt_receipt::confirm_prompt_delivery;
use super::super::user_shell_context::PendingUserShellContext;
use super::{delivery_lifecycle, reported_failure, runtime_registration, PendingPromptContext};
use crate::domain::agents::adapter::AgentRuntimeAdapter;
use tracing::{error, info};

pub(in crate::domain::ws_session) async fn spawn_runtime(
    mut context: PendingPromptContext,
    adapter: &dyn AgentRuntimeAdapter,
    auto_name_handled: bool,
    receipt_message_uuid: Option<String>,
    dispatch_claim: Option<(i64, String)>,
    conversation_references: Vec<
        super::super::conversation_references::ResolvedConversationReference,
    >,
    user_shell_context: PendingUserShellContext,
) -> Result<(), String> {
    log_spawn(&context);
    let attachments = payload_attachments(&context.payload);
    // Expand Cadencr prompt directives only for the provider while keeping the
    // concise command and conversation-reference tokens persisted.
    let prompt_text = expand_prompt_for_provider(&context.payload.text, &conversation_references);
    let prompt_text = match user_shell_context.append_to_prompt(prompt_text) {
        Ok(prompt) => prompt,
        Err(error) => {
            user_shell_context
                .release_or_warn(
                    &context.app_state.write_pool,
                    &context.sender,
                    &context.envelope_id,
                )
                .await;
            delivery_lifecycle::fail_pending_receipt(
                &context,
                receipt_message_uuid.as_deref(),
                dispatch_claim.as_ref(),
                &error,
            )
            .await;
            persist_pause_and_send_session_error()
                .pool(&context.app_state.write_pool)
                .session_status_tx(&context.app_state.session_status_tx)
                .sender(&context.sender)
                .ref_id(&context.envelope_id)
                .feature_id(context.feature_id)
                .session_id(context.db_session_id)
                .code("USER_SHELL_CONTEXT_ERROR")
                .message(&error)
                .call()
                .await;
            return reported_failure(context.wait_for_delivery, &error);
        }
    };
    let content_value =
        build_content_value_for_provider(&context.provider_id, &prompt_text, &attachments);
    let options = std::mem::take(&mut context.options);
    let selection = context.remember_selection.then(|| {
        super::super::user_selection::PromptedSelection::pending(&context.provider_id, &options)
    });
    match adapter.spawn(content_value, options).await {
        Ok(runtime_session) => {
            if let Some(selection) = selection {
                selection
                    .delivered(&*runtime_session)
                    .await
                    .remember(&context.sender, &context.envelope_id)
                    .await;
            }
            user_shell_context
                .mark_delivered_or_warn(
                    &context.app_state.write_pool,
                    &context.sender,
                    &context.envelope_id,
                )
                .await;
            delivery_lifecycle::mark_pending_dispatch_succeeded(&context, dispatch_claim.as_ref())
                .await;
            if let Some(message_uuid) = receipt_message_uuid.as_deref() {
                confirm_prompt_delivery(
                    &context.app_state.write_pool,
                    &context.app_state.ws_feature_senders,
                    &context.sender,
                    context.feature_id,
                    context.db_session_id,
                    message_uuid,
                )
                .await;
            }
            runtime_registration::register_runtime(context, runtime_session, auto_name_handled)
                .await?;
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            user_shell_context
                .release_or_warn(
                    &context.app_state.write_pool,
                    &context.sender,
                    &context.envelope_id,
                )
                .await;
            let wait_for_delivery = context.wait_for_delivery;
            delivery_lifecycle::fail_pending_receipt(
                &context,
                receipt_message_uuid.as_deref(),
                dispatch_claim.as_ref(),
                &message,
            )
            .await;
            let failure = message.clone();
            report_spawn_error(context, message).await;
            reported_failure(wait_for_delivery, &failure)
        }
    }
}

async fn report_spawn_error(context: PendingPromptContext, message: String) {
    error!(context.db_session_id, error = %message, "runtime query spawn failed");
    persist_pause_and_send_session_error()
        .pool(&context.app_state.write_pool)
        .session_status_tx(&context.app_state.session_status_tx)
        .sender(&context.sender)
        .ref_id(&context.envelope_id)
        .feature_id(context.feature_id)
        .session_id(context.db_session_id)
        .code("SDK_SPAWN_ERROR")
        .message(&message)
        .call()
        .await;
}

fn log_spawn(context: &PendingPromptContext) {
    info!(
        context.db_session_id,
        prompt = %context.payload.text,
        model = ?context.options.model,
        provider = %context.provider_id,
        mcp_count = context.options.mcp_servers.as_ref().map_or(0, std::collections::HashMap::len),
        mcp_servers = ?context.options.mcp_servers.as_ref().map(|servers| {
            servers.keys().cloned().collect::<Vec<_>>()
        }),
        "spawning runtime query"
    );
}
