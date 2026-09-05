//! Tiny helpers shared across the per-action handlers: permission-mode
//! parsing, runtime-session ID persistence, error envelope emission.

use axum::extract::ws::Message;
use tracing::debug;

use crate::domain::agents::adapter::RuntimeSessionHandle;
pub(crate) use crate::domain::agents::permission_modes::{
    default_permission_mode, default_permission_mode_wire, parse_permission_mode,
    post_plan_approval_fallback_mode_wire, post_plan_approval_mode_wire, provider_supports_mode,
};
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{
    RuntimeSessionIdPayload, SessionErrorPayload, WsEnvelope, WsSessionAction,
};

use super::session_init_resume::persistable_resume_session_id_for_provider;
use super::types::WsSender;

/// Parse a session_id string from client payload into i64 DB key.
pub(super) fn parse_session_id(s: &str) -> Option<i64> {
    s.parse::<i64>().ok()
}

/// Persist the runtime session ID from the active runtime, close it, and return the ID.
pub(super) async fn persist_and_close_query(
    query: &RuntimeSessionHandle,
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
    runtime_provider: &str,
) -> Option<String> {
    let mut q = query.write().await;
    let cli_sid = q.session_id().await;
    let resume_sid =
        persistable_resume_session_id_for_provider(runtime_provider, cli_sid.as_deref());
    if let Some(ref sid) = resume_sid {
        debug!(
            db_session_id,
            runtime_provider = %runtime_provider,
            runtime_session_id = %sid,
            "persist_and_close: saving runtime session_id"
        );
        WsSessionPersistence::persist_runtime_session_id_static(
            pool,
            db_session_id,
            runtime_provider,
            sid,
        )
        .await;
    }
    q.close().await;
    resume_sid
}

/// Send an error envelope back to the client.
pub(super) fn send_error(sender: &WsSender, ref_id: &str, code: &str, message: &str) {
    let err = WsEnvelope::reply(
        ref_id,
        "session",
        "error",
        serde_json::to_value(SessionErrorPayload {
            code: code.into(),
            message: message.into(),
            ..Default::default()
        })
        .unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(err).into()));
}

/// Notify the frontend of the runtime session ID (used for --resume).
pub(super) fn send_runtime_session_id(sender: &WsSender, cli_sid: &str) {
    let envelope = WsEnvelope::session_event(
        WsSessionAction::RuntimeSessionId,
        RuntimeSessionIdPayload {
            runtime_session_id: cli_sid.to_string(),
        },
    )
    .expect("runtime session id payload should serialize");
    let _ = sender.send(Message::Text(String::from(envelope).into()));
}
