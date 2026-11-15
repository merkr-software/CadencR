//! How a turn that ends with a user-input gate still pending leaves the status.

use crate::domain::gate_registry::GateKind;
use crate::domain::session_status::PendingKind;
use crate::domain::ws_session::persistence::WsSessionPersistence;

use super::stream_reader_task::StreamReaderTask;

impl StreamReaderTask {
    /// The gate still pending once the turn ended: `None` when there is none,
    /// `Some(None)` when its payload names no request.
    pub(super) async fn gate_left_pending(&self) -> Option<Option<(PendingKind, String)>> {
        let row =
            WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id).await?;
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
