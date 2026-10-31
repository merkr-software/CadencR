//! Tiny helpers shared across the per-action handlers: permission-mode
//! parsing, runtime-session ID persistence, error envelope emission.
use crate::domain::ws_session::runtime::output::OutputTarget;

use crate::domain::ws_session::protocol::WsSessionEvent;
use axum::extract::ws::Message;
use tracing::debug;

use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeSessionHandle};
pub(crate) use crate::domain::agents::permission_modes::{
    default_permission_mode, default_permission_mode_wire, parse_permission_mode,
    post_plan_approval_fallback_mode_wire, post_plan_approval_mode_wire, provider_supports_mode,
};
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{
    RuntimeSessionIdPayload, SessionErrorPayload, WsEnvelope,
};

use super::session_init_resume::persistable_resume_session_id_for_provider;

/// Persistence and viewer delivery needed while closing a runtime.
#[derive(bon::Builder)]
pub(in crate::domain::ws_session) struct RuntimeCloseContext<'a> {
    pool: &'a sqlx::SqlitePool,
    feature_senders: &'a crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry,
}

/// Parse a session_id string from client payload into i64 DB key.
pub(in crate::domain::ws_session) fn parse_session_id(s: &str) -> Option<i64> {
    s.parse::<i64>().ok()
}

/// Persist the runtime session ID from the active runtime, close it, and return the ID.
pub(in crate::domain::ws_session) async fn persist_and_close_query(
    query: &RuntimeSessionHandle,
    context: &RuntimeCloseContext<'_>,
    db_session_id: i64,
    runtime_provider: &str,
    feature_id: i64,
) -> Option<String> {
    let mut q = query.write().await;
    persist_and_close_runtime(
        q.as_mut(),
        context,
        db_session_id,
        runtime_provider,
        feature_id,
    )
    .await
}

/// Close an already-locked runtime so callers can validate state after waiting
/// for the writer without releasing it before the close operation.
pub(in crate::domain::ws_session) async fn persist_and_close_runtime(
    q: &mut dyn AgentRuntimeSession,
    context: &RuntimeCloseContext<'_>,
    db_session_id: i64,
    runtime_provider: &str,
    feature_id: i64,
) -> Option<String> {
    let cli_sid = q.session_id().await;
    let resume_sid = persistable_resume_session_id_for_provider(
        runtime_provider,
        cli_sid.as_deref(),
        q.allows_resume_persistence(),
    );
    if let Some(ref sid) = resume_sid {
        debug!(
            db_session_id,
            runtime_provider = %runtime_provider,
            runtime_session_id = %sid,
            "persist_and_close: saving runtime session_id"
        );
        WsSessionPersistence::persist_runtime_session_id_static(
            context.pool,
            db_session_id,
            runtime_provider,
            sid,
        )
        .await;
    }
    if let Err(error) = q.close().await {
        let message = error.to_string();
        tracing::warn!(db_session_id, %error, "runtime close failed after local cleanup");
        WsSessionPersistence::persist_error_message_static(
            context.pool,
            db_session_id,
            &message,
            None,
        )
        .await;
        let envelope = WsEnvelope::session_event(&WsSessionEvent::Error(SessionErrorPayload {
            code: "RUNTIME_CLOSE_FAILED".into(),
            message,
            ..Default::default()
        }))
        .expect("runtime close error should serialize");
        let message = Message::Text(String::from(envelope).into());
        context
            .feature_senders
            .notify_observers(feature_id, &message);
        for sender in context.feature_senders.get_senders(feature_id).await {
            let _ = sender.send(message.clone());
        }
    }
    resume_sid
}

/// Send an error envelope back to the client.
pub(in crate::domain::ws_session) fn send_error(
    sender: &impl OutputTarget,
    ref_id: &str,
    code: &'static str,
    message: &str,
) {
    sender.report_error(code, message, ref_id);
}

pub(in crate::domain::ws_session) fn send_warning(
    sender: &impl OutputTarget,
    ref_id: &str,
    code: &'static str,
    message: &str,
) {
    sender.report_warning(code, message, ref_id);
}

/// Notify the frontend of the runtime session ID (used for --resume).
pub(in crate::domain::ws_session) fn send_runtime_session_id(
    sender: &impl OutputTarget,
    cli_sid: &str,
) {
    let envelope =
        WsEnvelope::session_event(&WsSessionEvent::RuntimeSessionId(RuntimeSessionIdPayload {
            runtime_session_id: cli_sid.to_string(),
        }))
        .expect("runtime session id payload should serialize");
    let _ = sender.send(Message::Text(String::from(envelope).into()));
}
