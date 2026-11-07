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

use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

/// Persistence and viewer delivery needed while closing a runtime.
#[derive(bon::Builder)]
pub(in crate::domain::ws_session) struct RuntimeCloseContext<'a> {
    pool: &'a sqlx::SqlitePool,
    feature_senders: &'a WsFeatureSenderRegistry,
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

/// The runtime's session id when its provider resumes from it.
pub(in crate::domain::ws_session) async fn persistable_resume_sid(
    q: &dyn AgentRuntimeSession,
    runtime_provider: &str,
) -> Option<String> {
    let cli_sid = q.session_id().await;
    persistable_resume_session_id_for_provider(
        runtime_provider,
        cli_sid.as_deref(),
        q.allows_resume_persistence(),
    )
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
    let resume_sid = persistable_resume_sid(q, runtime_provider).await;
    if let Some(ref sid) = resume_sid {
        debug!(
            db_session_id,
            runtime_provider = %runtime_provider,
            runtime_session_id = %sid,
            "persist_and_close: saving runtime session_id"
        );
        let written = WsSessionPersistence::persist_runtime_session_id_static(
            context.pool,
            db_session_id,
            runtime_provider,
            sid,
        )
        .await;
        report_if_unsaved(
            context.feature_senders,
            feature_id,
            db_session_id,
            "its resume point",
            written,
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
        broadcast_session_error(
            context.feature_senders,
            feature_id,
            "RUNTIME_CLOSE_FAILED",
            message,
        )
        .await;
    }
    resume_sid
}

/// The value whose anchoring write succeeded, or `None` once the failure was
/// reported to the requester.
pub(in crate::domain::ws_session) fn saved_or_report<T>(
    sender: &impl OutputTarget,
    envelope_id: &str,
    what: &str,
    saved: Result<T, sqlx::Error>,
) -> Option<T> {
    saved
        .map_err(|error| {
            let message = format!("Failed to save the conversation's {what}: {error}");
            send_error(sender, envelope_id, "DB_ERROR", &message);
        })
        .ok()
}

/// Send an uncorrelated session error: no request is waiting on this failure.
pub(in crate::domain::ws_session) fn send_session_error(
    sender: &impl OutputTarget,
    code: &str,
    message: String,
) {
    let _ = sender.send(session_error_message(code, message));
}

fn session_error_message(code: &str, message: String) -> Message {
    let envelope = WsEnvelope::session_event(&WsSessionEvent::Error(SessionErrorPayload {
        code: code.into(),
        message,
        ..Default::default()
    }))
    .expect("session error should serialize");
    Message::Text(String::from(envelope).into())
}

/// Show a session error to every viewer of the feature, for failures found by
/// work no request is waiting on.
pub(in crate::domain::ws_session) async fn broadcast_session_error(
    feature_senders: &WsFeatureSenderRegistry,
    feature_id: i64,
    code: &str,
    message: String,
) {
    feature_senders
        .broadcast_all(feature_id, &session_error_message(code, message))
        .await;
}

/// The code of a session-state write that failed while the change itself
/// applies; clients show it as a notice, not as a failed turn.
pub(in crate::domain::ws_session) const SESSION_STATE_NOT_SAVED: &str = "SESSION_STATE_NOT_SAVED";

pub(in crate::domain::ws_session) fn state_not_saved_message(
    what: &str,
    error: &sqlx::Error,
) -> String {
    format!(
        "Cadencr could not save {what} for this conversation ({error}). It may show the wrong state after a restart."
    )
}

/// Tell the requester its change applies but could not be saved.
pub(in crate::domain::ws_session) fn send_state_not_saved(
    sender: &impl OutputTarget,
    envelope_id: &str,
    what: &str,
    error: &sqlx::Error,
) {
    tracing::error!(%error, what, "failed to save session state");
    send_error(
        sender,
        envelope_id,
        SESSION_STATE_NOT_SAVED,
        &state_not_saved_message(what, error),
    );
}

/// Surface a session-state write that failed: the live session carries on, but
/// what the database says about it (`what`) is stale until the next write.
pub(in crate::domain::ws_session) async fn report_session_write_failure(
    feature_senders: &WsFeatureSenderRegistry,
    feature_id: i64,
    db_session_id: i64,
    what: &str,
    error: &sqlx::Error,
) {
    tracing::error!(db_session_id, %error, what, "failed to save session state");
    broadcast_session_error(
        feature_senders,
        feature_id,
        SESSION_STATE_NOT_SAVED,
        state_not_saved_message(what, error),
    )
    .await;
}

/// [`report_session_write_failure`] when `written` failed.
pub(in crate::domain::ws_session) async fn report_if_unsaved(
    feature_senders: &WsFeatureSenderRegistry,
    feature_id: i64,
    db_session_id: i64,
    what: &str,
    written: Result<(), sqlx::Error>,
) {
    if let Err(error) = written {
        report_session_write_failure(feature_senders, feature_id, db_session_id, what, &error)
            .await;
    }
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

/// Tell a runtime about to stream which sub-agents its conversation already
/// launched, so one it resumes keeps its card. A registry that cannot be read
/// only costs that, so the client is warned and the runtime starts anyway.
pub(in crate::domain::ws_session) async fn seed_known_subagents(
    sender: &impl OutputTarget,
    ref_id: &str,
    pool: &sqlx::SqlitePool,
    session_id: i64,
    runtime: &mut dyn AgentRuntimeSession,
) {
    if let Err(error) = crate::domain::subagents::seed_runtime(pool, session_id, runtime).await {
        send_warning(
            sender,
            ref_id,
            "SUBAGENT_HISTORY_UNAVAILABLE",
            &format!("Sub-agents resumed in this conversation may not show their status: {error}"),
        );
    }
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
