//! Telling the agent that its ACP session closes.

use std::time::Duration;

use agent_client_protocol::schema::v1::{CancelNotification, CloseSessionRequest};

use super::implementation::AcpRuntimeSession;

// Must stay below the process-wide stream-reader shutdown deadline (2s): a
// peer that advertises `session/close` but never replies must still leave time
// to close the local runtime channel before the reader is joined.
const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

/// Prefer the stable lifecycle request when advertised. A connector that
/// accepts it must cancel ongoing work and release the session's resources.
/// Fall back to the baseline cancel notification if the optional request
/// fails so teardown remains bounded and best-effort.
pub(super) async fn tell_agent(session: &AcpRuntimeSession, session_id: String) {
    let should_cancel = if session.supports_session_close {
        match session
            .client
            .send_request_typed(
                CloseSessionRequest::new(session_id.clone()),
                SESSION_CLOSE_TIMEOUT,
            )
            .await
        {
            Ok(_) => false,
            Err(error) => {
                // At shutdown the agent is often already gone with the
                // service's process group: nothing is lost.
                if crate::domain::restart_continuations::is_shutting_down() {
                    tracing::info!(%error, "ACP session/close failed while the service shut down; falling back to session/cancel");
                } else {
                    tracing::warn!(%error, "ACP session/close failed; falling back to session/cancel");
                }
                true
            }
        }
    } else {
        true
    };
    if should_cancel {
        let _ = session
            .client
            .send_notification_typed(CancelNotification::new(session_id))
            .await;
    }
}
