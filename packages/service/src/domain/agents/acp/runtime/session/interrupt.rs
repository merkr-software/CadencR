//! Interrupting and forcefully terminating an unresponsive ACP session.

use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::schema::v1::CancelNotification;
use tokio::sync::mpsc;

use super::super::permissions::reject_all_pending;
use super::AcpRuntimeSession;
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent};

/// Upper bound on delivering a stop-escalation error into a full runtime
/// channel so a stalled consumer can never pin a strong sender forever.
const ESCALATION_ENQUEUE_TIMEOUT: Duration = Duration::from_secs(5);

/// Queue a stop-escalation error without ever blocking the caller. If the
/// runtime channel is full, a bounded background task delivers it once room
/// frees up so a stalled consumer can never pin `tx` open forever.
pub(in crate::domain::agents::acp::runtime) fn queue_stop_escalation(
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    message: String,
) {
    match tx.try_send(Err(RuntimeError::stop_escalated(message))) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(escalation)) => {
            let tx = tx.clone();
            tokio::spawn(async move {
                match tokio::time::timeout(ESCALATION_ENQUEUE_TIMEOUT, tx.send(escalation)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => {
                        tracing::debug!("ACP runtime channel closed before stop escalation");
                    }
                    Err(_) => {
                        tracing::warn!("timed out queueing ACP stop escalation onto full channel");
                    }
                }
            });
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            tracing::debug!("ACP runtime channel closed before stop escalation");
        }
    }
}

/// Upper bound on waiting for `prompt_turn_lock` admission before cancelling.
/// Normally admission is free (released as soon as `session/prompt` hits stdin)
/// or held briefly during settlement; bounding it guarantees a stalled writer
/// or full runtime channel can never deadlock Stop.
const ADMISSION_LOCK_TIMEOUT: Duration = Duration::from_millis(250);

pub(super) async fn interrupt(session: &AcpRuntimeSession) -> Result<(), RuntimeError> {
    let session_id = session.require_session_id().await?;
    reject_all_pending(&session.client, &session.pending_permissions).await;
    let _admission = match tokio::time::timeout(
        ADMISSION_LOCK_TIMEOUT,
        session.prompt_turn_lock.lock_admission(),
    )
    .await
    {
        Ok(guard) => Some(guard),
        Err(_) => {
            tracing::warn!(
                session_id = %session_id,
                "ACP prompt admission lock timed out during Stop; cancelling anyway"
            );
            None
        }
    };
    // The agent may report the interruption as soon as it sees the notification.
    session.prompt_cancel.cancel_current_turn();
    session
        .client
        .send_notification_typed(CancelNotification::new(session_id))
        .await
        .map_err(|e| RuntimeError::new(format!("session/cancel failed: {e}")))
}

pub(super) async fn terminate_unresponsive_stop(
    session: &AcpRuntimeSession,
    reason: String,
) -> bool {
    if session.closing.swap(true, Ordering::SeqCst) {
        return true;
    }
    tracing::warn!("{reason}");
    session.client.begin_close();
    session.prompt_cancel.cancel_current_turn();
    reject_all_pending(&session.client, &session.pending_permissions).await;
    if let Some(task) = session
        .side_channel_task
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        task.abort();
    }
    if session.prompt_cancel.claim_escalation() {
        if let Some(tx) = session.local_tx.as_ref() {
            queue_stop_escalation(tx, reason);
        }
    }
    session.terminals.shutdown().await;
    session.client.shutdown().await;
    true
}
