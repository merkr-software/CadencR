//! The runtime side of a gate close, ordered after the durable clear.
//!
//! Unsaved, a closed gate would come back on the next open while the runtime,
//! already moved on, rejects any answer to it. So the clear is saved first: a
//! failure there leaves the runtime and the request untouched, and a runtime
//! that then refuses the close gets its gate back.

use super::{deny_runtime_gate, send_error, RuntimeGateClose, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::ws_session::runtime::application::clear_gate_ahead;

/// Clear the gate durably, then close it on the runtime. `None` when the
/// close failed: the claim is released and the requester has its error.
/// Otherwise what the runtime did, and whether the clear removed a stored
/// gate.
pub(super) async fn close_runtime_side(
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    request_id: &str,
    envelope_id: &str,
) -> Option<(RuntimeGateClose, bool)> {
    let fail = |code: &'static str, message: String| async move {
        app_state
            .pending_gates
            .release(db_session_id, request_id)
            .await;
        send_error(sender, envelope_id, code, &message);
    };
    let cleared = match clear_gate_ahead(&app_state.write_pool, db_session_id, request_id).await {
        Ok(cleared) => cleared,
        Err(error) => {
            fail("DB_ERROR", format!("Failed to close gate: {error}")).await;
            return None;
        }
    };
    // A turn blocked on the gate is stopped before Idle is advertised or the
    // gate released. Otherwise a queued reply can start before this
    // cancellation interrupts it.
    match deny_runtime_gate(sdk_sessions, db_session_id, request_id, app_state).await {
        Ok(closed) => Some((closed, cleared.cleared_any())),
        Err(error) => {
            let message = match cleared.restore(&app_state.write_pool).await {
                Ok(()) => error.to_string(),
                Err(lost) => format!("{error}; the request could not be put back: {lost}"),
            };
            fail("SDK_ERROR", message).await;
            None
        }
    }
}
