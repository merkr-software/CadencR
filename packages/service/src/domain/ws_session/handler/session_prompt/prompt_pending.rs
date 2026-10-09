mod active_session;
mod delivery_lifecycle;
mod mode_fallback;
mod runtime_registration;
use super::super::{send_error, SdkSessions, SessionConfig, WsSender};
use super::bridge::{PermissionResponse, WsBridgeCanUseTool};
use super::content::{
    build_content_value_for_provider, build_persist_content, expand_prompt_for_provider,
    payload_attachments,
};
use super::errors::persist_pause_and_send_session_error;
use super::prompt_receipt::confirm_prompt_delivery;
use super::prompt_resume_resolution::refresh_resume_session_id_from_db;
use super::prompt_status::{
    mark_agent_running, persist_and_publish_prompt, PromptPersistenceOutcome,
};
use super::prompt_worktree::prepare_branch_provisioning;
use super::user_shell_context::{claim_pending_user_shell_context, PendingUserShellContext};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{AgentRuntimeAdapter, RuntimeSpawnConfig};
use crate::domain::agents::providers::ProviderAdapterHandle;
use crate::domain::agents::runtime_adapter;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::workflow::worktree;
use crate::domain::ws_session::permissions;
use crate::domain::ws_session::protocol::PromptSendPayload;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};
pub(super) struct PendingPromptContext {
    pub envelope_id: String,
    pub sender: WsSender,
    pub sdk_sessions: SdkSessions,
    pub app_state: AppState,
    pub db_session_id: i64,
    pub feature_id: i64,
    pub provider_id: String,
    pub spawned_model: Option<String>,
    pub spawned_thinking_effort: Option<String>,
    pub config: SessionConfig,
    pub options: RuntimeSpawnConfig,
    pub payload: PromptSendPayload,
    pub(super) permission_tx: Option<mpsc::Sender<PermissionResponse>>,
    pub internal_replay: bool,
}
pub(super) async fn handle_pending_prompt(mut context: PendingPromptContext) -> Result<(), String> {
    let persistence = persist_initial_user_message(&context).await?;
    if !persistence.should_dispatch() {
        return Ok(());
    }
    let dispatch_claim = persistence
        .dispatch_claim()
        .map(|(message_id, token)| (message_id, token.to_string()));
    let receipt_message_uuid = persistence.tracked_message_uuid(&context.payload);
    let conversation_references = match super::conversation_references::resolve(
        &context.app_state.read_pool,
        context.feature_id,
        &context.payload.text,
        !context.internal_replay,
    )
    .await
    {
        Ok(references) => references,
        Err(error) => {
            delivery_lifecycle::fail_pending_receipt(
                &context,
                receipt_message_uuid.as_deref(),
                dispatch_claim.as_ref(),
                &error,
            )
            .await;
            return Err(error);
        }
    };
    let Some(adapter) = resolve_adapter_or_report(&context).await else {
        delivery_lifecycle::fail_pending_receipt(
            &context,
            receipt_message_uuid.as_deref(),
            dispatch_claim.as_ref(),
            "runtime adapter unavailable",
        )
        .await;
        return reported_failure(context.internal_replay, "runtime adapter unavailable");
    };
    mark_agent_running(
        &context.app_state.write_pool,
        &context.app_state.session_status_tx,
        &context.app_state.active_turns,
        &context.sdk_sessions,
        context.db_session_id,
        context.feature_id,
    )
    .await;
    let auto_name_handled = match prepare_worktree(&mut context).await {
        Ok(handled) => handled,
        Err(error) => {
            delivery_lifecycle::fail_pending_receipt(
                &context,
                receipt_message_uuid.as_deref(),
                dispatch_claim.as_ref(),
                &error,
            )
            .await;
            let internal_replay = context.internal_replay;
            // Keep the underlying git error in the internal-caller reply so
            // MCP spawns don't surface an opaque "branch setup failed" (#210).
            let failure = format!("branch setup failed: {error}");
            report_branch_setup_error(context, error).await;
            return reported_failure(internal_replay, &failure);
        }
    };
    if let Err(error) = reresolve_worktree_and_resume(&mut context).await {
        delivery_lifecycle::fail_pending_receipt(
            &context,
            receipt_message_uuid.as_deref(),
            dispatch_claim.as_ref(),
            &error,
        )
        .await;
        let internal_replay = context.internal_replay;
        report_branch_setup_error(context, error).await;
        return reported_failure(internal_replay, "worktree verification failed");
    }
    super::prompt_checkpoint::capture_pre_turn_pending(&context, persistence.message_id()).await;
    attach_permission_bridge(&mut context);
    if let Err(error) = super::prompt_pending_mcp::attach_cadencr_mcp(&mut context).await {
        delivery_lifecycle::fail_pending_receipt(
            &context,
            receipt_message_uuid.as_deref(),
            dispatch_claim.as_ref(),
            &error,
        )
        .await;
        let internal_replay = context.internal_replay;
        report_mcp_attach_error(context, error).await;
        return reported_failure(internal_replay, "failed to attach MCP servers");
    }
    validate_resume_id(&*adapter, &mut context);
    mode_fallback::apply_spawn_mode_fallback(&mut context, &*adapter).await;
    let shell_delivery_id = context
        .payload
        .message_uuid
        .as_deref()
        .unwrap_or(&context.envelope_id);
    let user_shell_context = match claim_pending_user_shell_context(
        &context.app_state.write_pool,
        context.db_session_id,
        shell_delivery_id,
    )
    .await
    {
        Ok(shell_context) => shell_context,
        Err(error) => {
            delivery_lifecycle::fail_pending_receipt(
                &context,
                receipt_message_uuid.as_deref(),
                dispatch_claim.as_ref(),
                &error,
            )
            .await;
            persist_pause_and_send_session_error(
                &context.app_state.write_pool,
                &context.app_state.session_status_tx,
                &context.sender,
                &context.envelope_id,
                context.feature_id,
                context.db_session_id,
                "USER_SHELL_CONTEXT_ERROR",
                &error,
            )
            .await;
            return reported_failure(context.internal_replay, &error);
        }
    };
    spawn_runtime(
        context,
        &*adapter,
        auto_name_handled,
        receipt_message_uuid,
        dispatch_claim,
        conversation_references,
        user_shell_context,
    )
    .await
}

fn reported_failure(internal_replay: bool, message: &str) -> Result<(), String> {
    if internal_replay {
        Err(message.to_string())
    } else {
        Ok(())
    }
}
/// Correct stale session state from `session.init` before spawning. When a
/// conversation was started on another device, this connection's `Pending`
/// handle can carry a pre-worktree cwd and no resume id (init ran before the
/// worktree existed / before the runtime session id was persisted). Re-read
/// both from the DB — the source of truth — so a follow-up from any device
/// always resumes the SAME provider session in the SAME worktree instead of
/// starting a fresh agent in the project root.
async fn reresolve_worktree_and_resume(context: &mut PendingPromptContext) -> Result<(), String> {
    let path =
        worktree::resolve_feature_cwd(&context.app_state.read_pool, context.feature_id).await?;
    let cwd = std::path::PathBuf::from(&path);
    if context.options.cwd != cwd {
        info!(context.db_session_id, runtime_cwd = %path, "re-resolved runtime cwd from DB before spawn");
        context.config.canonical_cwd = permissions::canonicalize_worktree(&cwd);
        context.config.cwd = cwd.clone();
        context.options.cwd = cwd;
    }
    if let Some(sid) = refresh_resume_session_id_from_db(
        &mut context.options,
        &context.app_state.read_pool,
        context.db_session_id,
        &context.provider_id,
    )
    .await
    {
        info!(context.db_session_id, runtime_session_id = %sid, "re-resolved resume id from DB before spawn");
    }
    Ok(())
}
async fn persist_initial_user_message(
    context: &PendingPromptContext,
) -> Result<PromptPersistenceOutcome, String> {
    let attachments = payload_attachments(&context.payload);
    let persist_content = build_persist_content(&context.payload.text, &attachments);
    let outcome = persist_and_publish_prompt(
        &context.app_state.write_pool,
        &context.app_state.ws_feature_senders,
        &context.sender,
        context.feature_id,
        context.db_session_id,
        &context.payload,
        &persist_content,
        context.internal_replay,
    )
    .await?;
    if outcome.inserted() {
        context.app_state.feature_events_tx.emit(
            context.feature_id,
            None,
            FeatureEventAction::Reordered,
        );
    }
    Ok(outcome)
}
async fn resolve_adapter_or_report(
    context: &PendingPromptContext,
) -> Option<ProviderAdapterHandle> {
    match runtime_adapter(&context.provider_id) {
        Some(adapter) => Some(adapter),
        None => {
            let message = format!(
                "No runtime adapter registered for provider '{}'",
                context.provider_id
            );
            persist_pause_and_send_session_error(
                &context.app_state.write_pool,
                &context.app_state.session_status_tx,
                &context.sender,
                &context.envelope_id,
                context.feature_id,
                context.db_session_id,
                "UNSUPPORTED_PROVIDER",
                &message,
            )
            .await;
            None
        }
    }
}
async fn prepare_worktree(context: &mut PendingPromptContext) -> Result<bool, String> {
    prepare_branch_provisioning(
        &context.app_state,
        &context.app_state.write_pool,
        &context.sender,
        &context.payload,
        context.feature_id,
        &mut context.config,
        &mut context.options,
    )
    .await
}
/// Abort the prompt when first-prompt branch setup fails (e.g. the "From
/// branch" `git checkout -b` hit a dirty tree). Pauses the session and surfaces
/// the git error so the agent never runs on an unexpected branch.
async fn report_branch_setup_error(context: PendingPromptContext, message: String) {
    error!(context.db_session_id, error = %message, "branch setup failed before spawn");
    persist_pause_and_send_session_error(
        &context.app_state.write_pool,
        &context.app_state.session_status_tx,
        &context.sender,
        &context.envelope_id,
        context.feature_id,
        context.db_session_id,
        "BRANCH_SETUP_ERROR",
        &message,
    )
    .await;
}

async fn report_mcp_attach_error(context: PendingPromptContext, message: String) {
    error!(context.db_session_id, error = %message, "failed to attach Cadencr MCP servers");
    persist_pause_and_send_session_error(
        &context.app_state.write_pool,
        &context.app_state.session_status_tx,
        &context.sender,
        &context.envelope_id,
        context.feature_id,
        context.db_session_id,
        "MCP_ATTACH_ERROR",
        &message,
    )
    .await;
}

fn attach_permission_bridge(context: &mut PendingPromptContext) {
    let (permission_tx, permission_rx) = mpsc::channel::<PermissionResponse>(16);
    let bridge = WsBridgeCanUseTool {
        app_state: context.app_state.clone(),
        sender: context.sender.clone(),
        feature_senders: context.app_state.ws_feature_senders.clone(),
        response_rx: Arc::new(Mutex::new(permission_rx)),
        feature_id: context.feature_id,
        db_session_id: context.db_session_id,
        write_pool: context.app_state.write_pool.clone(),
        session_status_tx: context.app_state.session_status_tx.clone(),
        sdk_sessions: context.sdk_sessions.clone(),
    };
    context.options.permission_handler = Some(Arc::new(bridge));
    context.permission_tx = Some(permission_tx);
}
fn validate_resume_id(adapter: &dyn AgentRuntimeAdapter, context: &mut PendingPromptContext) {
    let Some(ref session_id) = context.options.resume_session_id else {
        return;
    };
    if adapter.is_valid_resume_session_id(session_id) {
        return;
    }
    warn!(
        context.db_session_id,
        resume_session_id = %session_id,
        provider = %context.provider_id,
        "dropping invalid resume_session_id before spawn"
    );
    context.options.resume_session_id = None;
}
async fn spawn_runtime(
    mut context: PendingPromptContext,
    adapter: &dyn AgentRuntimeAdapter,
    auto_name_handled: bool,
    receipt_message_uuid: Option<String>,
    dispatch_claim: Option<(i64, String)>,
    conversation_references: Vec<super::conversation_references::ResolvedConversationReference>,
    user_shell_context: PendingUserShellContext,
) -> Result<(), String> {
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
    let attachments = payload_attachments(&context.payload);
    // Expand Cadencr prompt directives only for the provider while keeping the
    // concise command and conversation-reference tokens persisted.
    let prompt_text = expand_prompt_for_provider(&context.payload.text, &conversation_references);
    let prompt_text = match user_shell_context.append_to_prompt(prompt_text) {
        Ok(prompt) => prompt,
        Err(error) => {
            let _ = user_shell_context
                .release(&context.app_state.write_pool)
                .await;
            delivery_lifecycle::fail_pending_receipt(
                &context,
                receipt_message_uuid.as_deref(),
                dispatch_claim.as_ref(),
                &error,
            )
            .await;
            persist_pause_and_send_session_error(
                &context.app_state.write_pool,
                &context.app_state.session_status_tx,
                &context.sender,
                &context.envelope_id,
                context.feature_id,
                context.db_session_id,
                "USER_SHELL_CONTEXT_ERROR",
                &error,
            )
            .await;
            return reported_failure(context.internal_replay, &error);
        }
    };
    let content_value =
        build_content_value_for_provider(&context.provider_id, &prompt_text, &attachments);
    let options = std::mem::take(&mut context.options);
    match adapter.spawn(content_value, options).await {
        Ok(runtime_session) => {
            if let Err(error) = user_shell_context
                .mark_delivered(&context.app_state.write_pool)
                .await
            {
                error!(context.db_session_id, %error, "failed to mark user shell context delivered");
                send_error(
                    &context.sender,
                    &context.envelope_id,
                    "USER_SHELL_CONTEXT_STATE_ERROR",
                    &error,
                );
            }
            delivery_lifecycle::mark_pending_dispatch_succeeded(&context, dispatch_claim.as_ref())
                .await;
            if let Some(message_uuid) = receipt_message_uuid.as_deref() {
                let _ = confirm_prompt_delivery(
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
                .await;
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            if let Err(release_error) = user_shell_context
                .release(&context.app_state.write_pool)
                .await
            {
                error!(context.db_session_id, error = %release_error, "failed to release user shell context claim");
            }
            let internal_replay = context.internal_replay;
            delivery_lifecycle::fail_pending_receipt(
                &context,
                receipt_message_uuid.as_deref(),
                dispatch_claim.as_ref(),
                &message,
            )
            .await;
            report_spawn_error(context, message).await;
            reported_failure(internal_replay, "runtime query spawn failed")
        }
    }
}

async fn report_spawn_error(context: PendingPromptContext, message: String) {
    error!(context.db_session_id, error = %message, "runtime query spawn failed");
    persist_pause_and_send_session_error(
        &context.app_state.write_pool,
        &context.app_state.session_status_tx,
        &context.sender,
        &context.envelope_id,
        context.feature_id,
        context.db_session_id,
        "SDK_SPAWN_ERROR",
        &message,
    )
    .await;
}
