//! How a turn that ends with a user-input gate still pending leaves the status.

use crate::domain::gate_registry::GateKind;
use crate::domain::session_status::PendingKind;
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};
use crate::domain::ws_session::runtime::helpers::{
    broadcast_session_error, SESSION_STATE_UNREADABLE,
};
use std::sync::atomic::Ordering;

use super::stream_reader_task::StreamReaderTask;

/// The session row could not be read; the failure is already reported.
pub(super) struct RowReadReported;

impl StreamReaderTask {
    /// The session's row for work no request waits on. A read failure is
    /// logged and, once per failure streak, shown to every viewer of the
    /// feature with its `consequence`; the caller then takes its safe branch.
    pub(super) async fn read_session_row(
        &self,
        consequence: &str,
    ) -> Result<Option<SessionRow>, RowReadReported> {
        let error =
            match WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id).await
            {
                Ok(row) => {
                    self.row_read_failed.store(false, Ordering::Relaxed);
                    return Ok(row);
                }
                Err(error) => error,
            };
        tracing::error!(self.db_session_id, %error, consequence, "failed to read session row");
        if !self.row_read_failed.swap(true, Ordering::Relaxed) {
            broadcast_session_error(
                &self.feature_senders,
                self.feature_id,
                SESSION_STATE_UNREADABLE,
                format!(
                    "Cadencr could not read this conversation's saved state ({error}). {consequence}"
                ),
            )
            .await;
        }
        Err(RowReadReported)
    }

    /// The gate still pending once the turn ended: `None` when there is none,
    /// `Some(None)` when its payload names no request.
    pub(super) async fn gate_left_pending(&self) -> Option<Option<(PendingKind, String)>> {
        let row = match self
            .read_session_row("Its status may not show a pending question until it is reopened.")
            .await
        {
            Ok(row) => row?,
            Err(RowReadReported) => return None,
        };
        row.has_pending_user_input().then(|| {
            row.pending_gate_payload().map(|(kind, payload)| {
                let kind = GateKind::from_pending(kind, &payload.tool_name);
                (kind.as_session_kind(), payload.request_id)
            })
        })
    }

    /// The session waits on the gate, not on a turn. A reply sent while a
    /// question asked without blocking waited showed the turn working; without
    /// this the session would look busy until the gate closed.
    pub(super) fn show_gate_left_pending(&self, gate: Option<(PendingKind, String)>) {
        if let Some((kind, request_id)) = gate {
            self.session_status_tx.broadcast_gate_left_pending(
                self.db_session_id,
                self.feature_id,
                kind,
                request_id,
            );
        }
    }
}
