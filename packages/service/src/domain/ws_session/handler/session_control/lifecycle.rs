use std::sync::atomic::Ordering;

use axum::extract::ws::Message;
use tracing::error;

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, persist_and_close_query, send_error};
use super::super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;

/// Handle session.interrupt
pub(crate) async fn handle_interrupt(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    // The live turn may be owned by another connection (e.g. the host stopping a
    // conversation started on a remote device). Resolve the owning map so the
    // interrupt reaches the running CLI rather than failing with NOT_FOUND. The
    // resulting Idle status already broadcasts to every device via
    // `session_status_tx`, so no extra mirror is needed here.
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let sdk_sessions = &effective_sessions;

    let active_query = {
        let sessions = sdk_sessions.lock().await;
        let handle = match sessions.get(&db_session_id) {
            Some(h) => h,
            None => {
                send_error(
                    sender,
                    &envelope.id,
                    "SESSION_NOT_FOUND",
                    "Session not found",
                );
                return;
            }
        };

        match &handle.state {
            QueryState::Active { query, .. } => Some(std::sync::Arc::clone(query)),
            QueryState::Pending(_) => {
                handle.manual_compact_cancel.store(true, Ordering::SeqCst);
                None
            }
        }
    };

    if let Some(query) = active_query {
        let q = query.read().await;
        if let Err(e) = q.interrupt().await {
            error!(db_session_id, error = %e, "interrupt failed");
            send_error(sender, &envelope.id, "SDK_ERROR", &e.to_string());
        }
    } else {
        send_error(sender, &envelope.id, "INVALID_STATE", "Session not active");
    }
}

/// Handle session.destroy: mark session as completed and close subprocess.
pub(crate) async fn handle_destroy(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.remove(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };

    let feature_id = handle.feature_id;
    let runtime_provider = handle.runtime_provider.clone();

    // Mark completed BEFORE closing the subprocess: closing ends the stream,
    // and the per-turn reader interprets a clean close while the DB still shows
    // `running` as an unexpected mid-turn death (raising an error). Flipping the
    // status off `running` first makes this intentional close read as benign.
    WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id).await;

    // Close active subprocess if running
    if let QueryState::Active { query, .. } = handle.state {
        persist_and_close_query(
            &query,
            &app_state.write_pool,
            db_session_id,
            &runtime_provider,
        )
        .await;
    }
    WsSessionPersistence::broadcast_session_status(
        &app_state.session_status_tx,
        db_session_id,
        feature_id,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );

    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "ended",
        serde_json::to_value(SessionEndedPayload {
            reason: "destroyed".into(),
        })
        .unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

/// Handle session.delete: hard-delete a session and its messages from the DB.
pub(crate) async fn handle_delete(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    match WsSessionPersistence::delete_session_static(&app_state.write_pool, db_session_id).await {
        Ok((feature_id, agent_type)) => {
            // The DB delete is the source of truth. Only drop the in-memory
            // handle after it succeeds; failed deletes (for example a running
            // session) must leave the live handle intact.
            sdk_sessions.lock().await.remove(&db_session_id);

            WsSessionPersistence::broadcast_session_status(
                &app_state.session_status_tx,
                db_session_id,
                feature_id,
                crate::domain::session_status::AgentStatus::Idle,
                None,
            );

            let _ = agent_type; // agent_type kept for log/symmetry — no further branching.

            let reply = WsEnvelope::reply(
                &envelope.id,
                "session",
                "deleted",
                serde_json::json!({ "session_id": db_session_id.to_string() }),
            );
            let _ = sender.send(Message::Text(String::from(reply).into()));
        }
        Err(reason) => {
            send_error(sender, &envelope.id, "DELETE_FAILED", &reason);
        }
    }
}

/// Handle session.clear: archive conversation and reset to fresh state.
pub(crate) async fn handle_clear(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.get_mut(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };

    // Close active subprocess if any, capturing runtime_session_id for archive.
    // If stream already finished (Pending with resume), extract from those options.
    let cli_sid = match &handle.state {
        QueryState::Active { query, .. } => {
            // Flip status off `running` BEFORE closing: closing ends the stream,
            // and the per-turn reader treats a clean close while the DB still
            // shows `running` as an unexpected mid-turn death (raising
            // `AGENT_STOPPED`). An intentional clear must read as a benign close.
            // (`archive_and_clear` below only nulls the runtime id, not status.)
            WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id).await;
            persist_and_close_query(
                query,
                &app_state.write_pool,
                db_session_id,
                &handle.runtime_provider,
            )
            .await
        }
        QueryState::Pending(opts) => opts.resume_session_id.clone(),
    };

    // Also clear the init-time resume_session_id in case it wasn't consumed yet
    let cli_sid = cli_sid.or_else(|| handle.resume_session_id.take());

    // Archive and clear in DB (pass cli_sid to avoid re-reading it)
    WsSessionPersistence::archive_and_clear(
        &app_state.write_pool,
        db_session_id,
        cli_sid.as_deref(),
    )
    .await;

    // Reset handle to Pending with fresh options (no resume)
    let fresh_options = RuntimeSpawnConfig {
        cwd: handle.config.cwd.clone(),
        permission_mode: handle.desired_permission_mode.clone(),
        access_mode: handle.desired_access_mode.clone(),
        model: handle.desired_model.clone(),
        thinking_effort: handle.desired_thinking_effort.clone(),
        system_prompt: handle.config.system_prompt.clone(),
        env: handle.config.env.clone(),
        ..RuntimeSpawnConfig::default()
    };
    handle.state = QueryState::Pending(fresh_options);

    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "cleared",
        serde_json::json!({
            "session_id": db_session_id.to_string(),
            "previous_session_id": cli_sid,
        }),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));
}
