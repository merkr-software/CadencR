//! Telling the agent that its ACP session closes.

use crate::shared::discard::cleanup;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::schema::v1::{CancelNotification, CloseSessionRequest};

use super::super::permissions::reject_all_pending;
use super::implementation::AcpRuntimeSession;
use crate::domain::agents::adapter::RuntimeError;

// Must stay below the process-wide stream-reader shutdown deadline (2s): a
// peer that advertises `session/close` but never replies must still leave time
// to close the local runtime channel before the reader is joined.
const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const _: () = assert!(
    SESSION_CLOSE_TIMEOUT.as_millis()
        < crate::domain::ws_session::stream_readers::READER_SHUTDOWN_TIMEOUT.as_millis(),
    "an agent's session/close must leave time for the local teardown"
);

pub(super) async fn close_session(session: &mut AcpRuntimeSession) -> Result<(), RuntimeError> {
    // Only the first close tells the agent. A later one (an idle reader
    // retiring the runtime the shutdown already closed, or a retry of a
    // close the shutdown deadline cut short) finishes the local teardown,
    // which is safe to repeat, without asking the agent again.
    let first_close = !session.closing.swap(true, Ordering::SeqCst);
    session.client.begin_close();
    let session_id = if first_close {
        session.current_session_id().await
    } else {
        None
    };
    if let Some(session_id) = session_id {
        tell_agent(session, session_id).await;
    }
    reject_all_pending(&session.client, &session.pending_permissions).await;
    // Drop session-scoped permission grants on close.
    session.session_permissions.clear().await;
    if let Some(task) = session.loop_task.take() {
        task.abort();
    }
    if let Some(task) = session
        .side_channel_task
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        task.abort();
    }
    // After the event loop: no `terminal/create` can race the stop. The
    // terminals lead their own process groups, so nothing else ends what
    // they left running.
    session.terminals.shutdown().await;
    // The stream receiver is owned outside the runtime. Drop our last
    // steady-state sender after stopping producer tasks so it observes EOF
    // even while the closed runtime remains registered for resume metadata.
    #[cfg(unix)]
    session.mcp_connections.stop().await;
    session.local_tx.take();
    session.client.shutdown().await;
    Ok(())
}

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
        cleanup(
            session
                .client
                .send_notification_typed(CancelNotification::new(session_id))
                .await,
            "cancel the ACP session after its close failed",
        );
    }
}
