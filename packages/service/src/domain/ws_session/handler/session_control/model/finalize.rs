//! Steps that follow a `session.model.set` switch: persistence, the context
//! window reseed, clearing an unsupported fast mode, and the reply.

use tracing::error;

use super::super::super::super::persistence::WsSessionPersistence;
use super::super::super::super::protocol::*;
use super::super::super::helpers::send_error;
use super::super::super::types::{SdkSessions, WsSender};
use super::super::fast_mode::{apply_fast_mode_change, FastModeChangeError};
use crate::app_state::AppState;
use crate::domain::agents::runtime_adapter;

pub(super) async fn clear_unsupported_fast_mode(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
) -> bool {
    match apply_fast_mode_change(sdk_sessions, app_state, db_session_id, false).await {
        Ok(_) => true,
        Err(FastModeChangeError::SessionNotFound) => {
            send_error(
                sender,
                envelope_id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            false
        }
        Err(FastModeChangeError::Unsupported) => true,
        Err(FastModeChangeError::ConfigurationChanged) => {
            send_error(
                sender,
                envelope_id,
                "SESSION_CONFIG_CHANGED",
                "Session configuration changed while clearing fast mode; retry the selection",
            );
            false
        }
        Err(FastModeChangeError::Persistence(error)) => {
            error!(db_session_id, %error, "failed to persist cleared fast mode");
            send_error(
                sender,
                envelope_id,
                "DB_ERROR",
                "Failed to persist cleared fast mode",
            );
            false
        }
        Err(FastModeChangeError::Sdk(error)) => {
            error!(db_session_id, %error, "failed to clear unsupported fast mode");
            send_error(sender, envelope_id, "SDK_ERROR", &error);
            false
        }
    }
}

pub(super) async fn persist_model_selection(
    app_state: &AppState,
    db_session_id: i64,
    model: &str,
    runtime_provider: &str,
    context_window: Option<u64>,
) {
    WsSessionPersistence::update_model_static(&app_state.write_pool, db_session_id, model).await;
    if let Err(error) = sqlx::query("UPDATE agent_sessions SET runtime_provider = ? WHERE id = ?")
        .bind(runtime_provider)
        .bind(db_session_id)
        .execute(&app_state.write_pool)
        .await
    {
        error!(%error, session_db_id = db_session_id, "failed to persist runtime provider");
    }
    WsSessionPersistence::update_context_window(
        &app_state.write_pool,
        db_session_id,
        context_window,
    )
    .await;
}

pub(super) async fn seed_context_window(model: &str, runtime_provider: &str) -> Option<u64> {
    // Seed the new model's context window ONLY when the target adapter can
    // answer authoritatively right now — opencode from its catalog, Claude
    // Code from what a previous turn's `result` reported for that exact model
    // id. `None` clears the stored window rather than leaving the outgoing
    // model's, which would misscale the bar until the next `result`.
    // Token counts are NOT reset: the conversation history has not changed,
    // only the model has. The first `result` from the new model will stamp
    // fresh token totals.
    match runtime_adapter(runtime_provider) {
        Some(adapter) => adapter.context_window_for_model(model).await,
        None => None,
    }
}

pub(super) async fn send_model_set_ok(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    feature_id: i64,
    provider: String,
    model: String,
    seeded_window: Option<u64>,
) {
    // Reply to the caller and mirror to other devices so their model chip updates.
    super::super::reply_and_broadcast(
        app_state,
        sender,
        envelope_id,
        feature_id,
        WsSessionAction::ModelSetOk,
        ModelSetOkPayload {
            provider,
            model,
            context_window: seeded_window,
        },
    )
    .await;
}
