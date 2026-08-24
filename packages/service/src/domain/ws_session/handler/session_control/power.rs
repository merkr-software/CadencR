use std::path::PathBuf;

use axum::extract::ws::Message;
use tracing::info;

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error};
use super::super::session_gate::clear_persisted_gate_and_notify;
use super::super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSessionHandle;
use crate::domain::workflow::worktree;
use crate::domain::ws_session::protocol::GateCloseReason;

/// Broadcast a `session.lifecycle` envelope so the frontend turn-lifecycle
/// state machine flips only on backend-confirmed transitions (per
/// `no-optimistic-updates.md`). Used by both suspend and resume paths.
fn broadcast_lifecycle(sender: &WsSender, session_id: i64, kind: SessionLifecycleKind) {
    let envelope = WsEnvelope::new(
        "session",
        "lifecycle",
        serde_json::to_value(SessionLifecyclePayload {
            session_id: session_id.to_string(),
            kind,
        })
        .unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(envelope).into()));
}

/// Handle `session.suspend`. Provider-neutral pause driven by the renderer
/// when the OS reports a pending suspend. Persisted permission/question gates
/// are closed first because the user cannot answer them while the machine is
/// asleep. For an active runtime we then capture the session id (so it can be
/// `--resume`'d after wake even if the subprocess dies), abort the in-flight
/// turn via the existing `interrupt()` trait method, and persist `paused` to
/// the DB. A Pending session without a gate has nothing to suspend, so its
/// reply stays silent.
pub(crate) async fn handle_suspend(
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
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };

    if let Err(error) = clear_persisted_gate_and_notify(
        sender,
        app_state,
        db_session_id,
        None,
        GateCloseReason::Sleep,
        Some(&envelope.id),
    )
    .await
    {
        send_error(
            sender,
            &envelope.id,
            "DB_ERROR",
            &format!("Failed to close pending gate before sleep: {error}"),
        );
        return;
    }

    // Extract the live query handle while briefly holding the lock, then
    // drop it so the await on `interrupt()` doesn't block other handlers
    // (same pattern as `handle_permission_respond`).
    let active: Option<(RuntimeSessionHandle, String, i64)> = {
        let sessions = sdk_sessions.lock().await;
        let Some(handle) = sessions.get(&db_session_id) else {
            return;
        };
        match &handle.state {
            QueryState::Active { query, .. } => Some((
                std::sync::Arc::clone(query),
                handle.runtime_provider.clone(),
                handle.feature_id,
            )),
            QueryState::Pending(_) => None,
        }
    };

    let Some((query, runtime_provider, feature_id)) = active else {
        // Pending session: nothing to interrupt, no resume id to persist,
        // no banner to flip. The envelope reply is silent to keep DB/UI
        // state consistent.
        return;
    };

    // Capture session id BEFORE interrupt: once the subprocess starts
    // tearing down, `session_id()` may return None for some adapters.
    let cli_sid = {
        let q = query.read().await;
        let sid = q.session_id().await;
        let interrupt_result = q.interrupt().await;
        drop(q);
        if let Err(error) = interrupt_result {
            info!(db_session_id, %error, "suspend: interrupt failed (treating as best-effort)");
        }
        sid
    };
    if let Some(sid) = super::super::session_init_resume::persistable_resume_session_id_for_provider(
        &runtime_provider,
        cli_sid.as_deref(),
    ) {
        // Persist so resume survives a subprocess death during suspend.
        // DB is the source of truth for resume IDs across restarts.
        WsSessionPersistence::persist_runtime_session_id_static(
            &app_state.write_pool,
            db_session_id,
            &runtime_provider,
            &sid,
        )
        .await;
    }
    WsSessionPersistence::mark_paused_static(&app_state.write_pool, db_session_id).await;
    WsSessionPersistence::broadcast_session_status(
        &app_state.session_status_tx,
        db_session_id,
        feature_id,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );

    broadcast_lifecycle(
        sender,
        db_session_id,
        SessionLifecycleKind::SuspendRequested,
    );
}

/// Handle `session.resume`. Counterpart to `handle_suspend`: provider-neutral
/// acknowledgement of OS wake. We don't respawn anything — the renderer has
/// already called `forceReconnectAll` to refresh transport, and the next
/// user prompt picks up `resume_session_id` from the DB via the existing
/// pending-spawn path. The lifecycle envelope is broadcast unconditionally
/// because the renderer can fan this out before the reconnect has finished
/// rebuilding `sdk_sessions` — an existence check here would race the new
/// connection and produce spurious `SESSION_NOT_FOUND` errors.
pub(crate) async fn handle_resume(envelope: WsEnvelope, sender: &WsSender) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };

    broadcast_lifecycle(sender, db_session_id, SessionLifecycleKind::Resumed);
}

/// Handle session.retry_worktree_setup: re-run setup commands for an existing worktree.
pub(crate) async fn handle_retry_worktree_setup(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let payload: serde_json::Value = envelope.payload;
    let feature_id = match payload.get("feature_id").and_then(|v| v.as_i64()) {
        Some(fid) => fid,
        None => {
            send_error(
                sender,
                &envelope.id,
                "MISSING_FEATURE_ID",
                "feature_id is required",
            );
            return;
        }
    };

    let wt_path_str =
        match worktree::get_setting(&app_state.read_pool, feature_id, "worktree_path").await {
            Some(p) => p,
            None => {
                send_error(
                    sender,
                    &envelope.id,
                    "NO_WORKTREE",
                    "No worktree found for this feature",
                );
                return;
            }
        };

    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "retry_worktree_setup.ok",
        serde_json::json!({
            "feature_id": feature_id,
        }),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));
    if app_state.worktree_setup_runs.is_owned(feature_id) {
        return;
    }

    let rp = app_state.read_pool.clone();
    let wp = app_state.write_pool.clone();
    let setup_runs = app_state.worktree_setup_runs.clone();
    let ws = app_state
        .ws_feature_senders
        .fan_out_sender(feature_id, sender.clone());
    let path = PathBuf::from(wt_path_str);
    tokio::spawn(async move {
        worktree::run_setup_commands(rp, wp, setup_runs, feature_id, path, ws).await;
    });
}
