//! The runtime side of a gate close, ordered after the durable clear.
//!
//! Unsaved, a closed gate would come back on the next open while the runtime,
//! already moved on, rejects any answer to it. So the clear is saved first: a
//! failure there leaves the runtime and the request untouched, and a runtime
//! that then refuses the close gets its gate back.

use super::{deny_runtime_gate, RuntimeGateClose, SdkSessions};
use crate::app_state::AppState;
use crate::domain::ws_session::runtime::application::clear_gate_ahead;
use crate::domain::ws_session::runtime::output::CommandError;

/// Clear the gate durably, then close it on the runtime: what the runtime
/// did, and whether the clear removed a stored gate. On a failure the claim
/// is released and the error returned for the requester.
pub(super) async fn close_runtime_side(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    request_id: &str,
) -> Result<(RuntimeGateClose, bool), CommandError> {
    let fail = |code: &'static str, message: String| async move {
        app_state
            .pending_gates
            .release(db_session_id, request_id)
            .await;
        CommandError::new(code, message)
    };
    let cleared = match clear_gate_ahead(&app_state.write_pool, db_session_id, request_id).await {
        Ok(cleared) => cleared,
        Err(error) => {
            return Err(fail("DB_ERROR", format!("Failed to close gate: {error}")).await);
        }
    };
    // A turn blocked on the gate is stopped before Idle is advertised or the
    // gate released. Otherwise a queued reply can start before this
    // cancellation interrupts it.
    match deny_runtime_gate(sdk_sessions, db_session_id, request_id, app_state).await {
        Ok(closed) => Ok((closed, cleared.cleared_any())),
        Err(error) => {
            let message = match cleared.restore(&app_state.write_pool).await {
                Ok(()) => error.to_string(),
                Err(lost) => format!("{error}; the request could not be put back: {lost}"),
            };
            Err(fail("SDK_ERROR", message).await)
        }
    }
}
