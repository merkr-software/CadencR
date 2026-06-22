//! `session.*` control-plane handlers, split by responsibility:
//! - `permission`: `session.permission.respond`
//! - `provider` / `model`: `session.provider.set` / `session.model.set`
//! - `mode` / `effort`: permission/access mode and thinking-effort changes
//! - `lifecycle` / `power`: interrupt/destroy/delete/clear and
//!   suspend/resume/retry_worktree_setup

mod codex_mode;
mod effort;
mod lifecycle;
mod mode;
mod model;
mod permission;
mod power;
mod provider;

pub(super) use codex_mode::handle_codex_permission_mode_set;
pub(super) use effort::handle_effort_set;
pub(super) use lifecycle::{handle_clear, handle_delete, handle_destroy, handle_interrupt};
pub(super) use mode::handle_mode_set;
pub(super) use model::handle_model_set;
pub(super) use permission::handle_permission_respond;
pub(super) use power::{handle_resume, handle_retry_worktree_setup, handle_suspend};
pub(super) use provider::handle_provider_set;

use axum::extract::ws::Message;

use super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::WsEnvelope;

/// Whether `sessions` holds a live (`Active`) handle for this session. Locks
/// briefly and releases before the caller acquires any further lock, so it
/// never nests the per-connection map lock with the owner-map lock.
pub(super) async fn session_is_active(sessions: &SdkSessions, db_session_id: i64) -> bool {
    let guard = sessions.lock().await;
    matches!(
        guard.get(&db_session_id).map(|h| &h.state),
        Some(QueryState::Active { .. })
    )
}

/// Resolve the connection map that owns this session's live turn. The fast path
/// is the caller's own map (it drove the turn). When the turn is owned by a
/// different connection — e.g. the host acting on a conversation that was
/// started on a remote device — the caller's own map holds only a `Pending`
/// handle, so we fall back to the global registry to reach the live query. This
/// is what makes model/mode/interrupt work from any connected device, not just
/// the turn owner (the same pattern `permission.respond` already uses).
pub(super) async fn resolve_owner_sessions(
    own: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
) -> SdkSessions {
    if session_is_active(own, db_session_id).await {
        own.clone()
    } else {
        app_state
            .active_turns
            .owner_sessions(db_session_id)
            .await
            .unwrap_or_else(|| own.clone())
    }
}

/// Mirror a session-control change to the *other* devices viewing the same
/// feature so their UI chips stay in sync (the originating sender already got
/// its own reply). Uses a ref-less envelope so receivers process it as an
/// unsolicited broadcast, exactly like `mirror_user_message`.
pub(super) async fn broadcast_control_change(
    app_state: &AppState,
    sender: &WsSender,
    feature_id: i64,
    action: &str,
    payload: serde_json::Value,
) {
    let env = WsEnvelope::new("session", action, payload);
    app_state
        .ws_feature_senders
        .broadcast_others(feature_id, sender, &Message::Text(String::from(env).into()))
        .await;
}

/// Reply to the originating sender with `action`+`payload`, then mirror the same
/// change to every other device viewing the feature. This is the standard shape
/// for a session-control change whose reply and broadcast carry identical data,
/// so all connected clients converge on the new value.
pub(super) async fn reply_and_broadcast(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    feature_id: i64,
    action: &str,
    payload: serde_json::Value,
) {
    let reply = WsEnvelope::reply(envelope_id, "session", action, payload.clone());
    let _ = sender.send(Message::Text(String::from(reply).into()));
    broadcast_control_change(app_state, sender, feature_id, action, payload).await;
}

/// Whether the session already has any persisted agent messages. Used to lock
/// provider/model changes once a conversation has started.
pub(super) async fn session_has_messages(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM agent_messages WHERE session_id = ?)")
        .bind(session_id)
        .fetch_one(pool)
        .await
        .map(|exists| exists != 0)
}
