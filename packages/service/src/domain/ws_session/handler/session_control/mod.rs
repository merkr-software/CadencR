//! `session.*` control-plane handlers, split by responsibility:
//! - `permission`: `session.permission.respond`
//! - `provider` / `model`: `session.provider.set` / `session.model.set`
//! - `mode` / `effort`: permission/access mode and thinking-effort changes
//! - `lifecycle` / `power`: interrupt/destroy/delete/clear and
//!   suspend/resume/retry_worktree_setup

mod access_mode;
mod effort;
mod fast_mode;
mod interrupt;
mod lifecycle;
mod mode;
mod model;
mod permission_dispatch;
mod power;
mod profile;
mod provider;
mod runtime_overrides;
mod session_config;

pub(super) use access_mode::handle_access_mode_set;
pub(super) use effort::handle_effort_set;
pub(super) use fast_mode::handle_fast_mode_set;
pub(super) use interrupt::finish_interruption;
pub(super) use lifecycle::{handle_clear, handle_delete, handle_destroy, handle_interrupt};
pub(super) use mode::handle_mode_set;
pub(super) use model::handle_model_set;
pub(crate) use permission_dispatch::handle_permission_respond;
pub(super) use power::{handle_resume, handle_retry_worktree_setup, handle_suspend};
pub(super) use profile::handle_profile_set;
pub(super) use provider::handle_provider_set;
#[cfg(test)]
pub(super) use provider::{read_persisted_selection, restore_persisted_selection};
pub(super) use runtime_overrides::handle_runtime_overrides_set;
pub(super) use session_config::{handle_session_config_get, handle_session_config_set};

use axum::extract::ws::Message;

use super::types::WsSender;
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{WsEnvelope, WsSessionEvent};

pub(super) use crate::domain::ws_session::runtime::control_policy::resolve_owner_sessions;

/// Mirror a session-control change to the *other* devices viewing the same
/// feature so their UI chips stay in sync (the originating sender already got
/// its own reply). Uses a ref-less envelope so receivers process it as an
/// unsolicited broadcast, exactly like the canonical `session.user_message`
/// event.
pub(super) async fn broadcast_control_change(
    app_state: &AppState,
    sender: &WsSender,
    feature_id: i64,
    event: &WsSessionEvent,
) {
    let env = WsEnvelope::session_event(event)
        .expect("session control broadcast payload should serialize");
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
    event: &WsSessionEvent,
) {
    let reply = WsEnvelope::session_reply(envelope_id, event)
        .expect("session control reply payload should serialize");
    let _ = sender.send(Message::Text(String::from(reply).into()));
    broadcast_control_change(app_state, sender, feature_id, event).await;
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
