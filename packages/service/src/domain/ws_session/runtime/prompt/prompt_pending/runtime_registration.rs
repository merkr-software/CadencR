use std::sync::Arc;

use tracing::{info, warn};

use super::super::mcp_servers::send_mcp_servers_for_runtime;
use super::super::prompt_worktree::spawn_auto_name_if_needed;
use super::super::stream_reader::spawn_stream_reader;
use super::{active_session, PendingPromptContext};
use crate::domain::ws_session::persistence::WsSessionPersistence;

pub(in crate::domain::ws_session) async fn register_runtime(
    mut context: PendingPromptContext,
    mut runtime_session: Box<dyn crate::domain::agents::adapter::AgentRuntimeSession>,
    auto_name_handled: bool,
) -> Result<(), String> {
    info!(
        context.db_session_id,
        "runtime query spawned successfully, starting stream reader"
    );
    let provider_context_window = runtime_session.context_window();
    let runtime_control_endpoint = runtime_session.runtime_control_endpoint();
    if let Some(context_window) = provider_context_window {
        WsSessionPersistence::update_context_window(
            &context.app_state.write_pool,
            context.db_session_id,
            Some(context_window),
        )
        .await;
    }
    if send_mcp_servers_for_runtime(
        &context.sender,
        context.db_session_id,
        runtime_session.as_ref(),
    )
    .await
    .is_err()
    {
        warn!(
            context.db_session_id,
            "websocket sender closed while sending post-spawn MCP servers"
        );
    }

    let message_rx = runtime_session.take_message_rx();
    let query_arc = Arc::new(tokio::sync::RwLock::new(runtime_session));
    let permission_tx = context
        .permission_tx
        .take()
        .expect("permission bridge must be attached before runtime spawn");
    let stream_provider = context.provider_id.clone();
    let stream_model = context.spawned_model.clone();
    let cleanup_session_on_end = false;

    let installed = active_session::insert_active_session(
        &context,
        query_arc.clone(),
        permission_tx,
        runtime_control_endpoint,
    )
    .await;
    if !installed {
        let close = query_arc.write().await.close().await;
        let message = match close {
            Ok(()) => "Session was retired or replaced while its runtime was starting".to_string(),
            Err(error) => format!("Session was retired or replaced while its runtime was starting; closing that runtime failed: {error}"),
        };
        super::super::super::helpers::send_warning(
            &context.sender,
            &context.envelope_id,
            "PROMPT_RUNTIME_RETIRED",
            &message,
        );
        return Err(message);
    }
    spawn_auto_name_if_needed(
        auto_name_handled,
        context.app_state.write_pool.clone(),
        context.app_state.feature_events_tx.clone(),
        context
            .app_state
            .ws_feature_senders
            .feature_output_sender(context.feature_id, &context.sender),
        context.feature_id,
        context.payload.text.clone(),
        context.config.cwd.to_string_lossy().to_string(),
    );
    drop(context.spawn_claim.take());
    spawn_stream_reader(
        context.db_session_id,
        context.feature_id,
        message_rx,
        Some(Arc::downgrade(&query_arc)),
        context.sender,
        context.app_state.ws_feature_senders.clone(),
        context.app_state.write_pool.clone(),
        context.app_state.session_status_tx.clone(),
        context.sdk_sessions.clone(),
        stream_provider,
        stream_model.as_deref(),
        provider_context_window,
        context.app_state.clone(),
        cleanup_session_on_end,
    );
    Ok(())
}
