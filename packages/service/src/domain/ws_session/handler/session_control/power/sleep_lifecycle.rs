//! The `session.lifecycle` envelopes around an OS sleep, so the frontend
//! turn-lifecycle state machine flips only on backend-confirmed transitions
//! (per `no-optimistic-updates.md`).

use axum::extract::ws::Message;

use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{
    SessionLifecycleKind, SessionLifecyclePayload, WsEnvelope, WsSessionEvent,
};
use crate::domain::ws_session::runtime::output::OutputTarget;
use crate::shared::discard::IgnoreClosed;

pub(super) fn lifecycle_message(session_id: i64, kind: SessionLifecycleKind) -> Message {
    let envelope = WsEnvelope::session_event(&WsSessionEvent::Lifecycle(SessionLifecyclePayload {
        session_id: session_id.to_string(),
        kind,
    }))
    .expect("session event payload should serialize");
    Message::Text(String::from(envelope).into())
}

/// The socket that asked for the pause hears of it, and resumes it after the
/// wake. A headless pause has no such socket: every viewer of the feature
/// learns of it instead.
pub(super) async fn announce_suspend(
    output: &impl OutputTarget,
    app_state: &AppState,
    feature_id: i64,
    db_session_id: i64,
) {
    let message = lifecycle_message(db_session_id, SessionLifecycleKind::SuspendRequested);
    match output.recipient() {
        Some(recipient) => recipient.send(message).ignore_closed(),
        None => {
            app_state
                .ws_feature_senders
                .broadcast_all(feature_id, &message)
                .await;
        }
    }
}
