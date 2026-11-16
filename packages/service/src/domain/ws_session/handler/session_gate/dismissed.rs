//! Closing a request the agent never waited on (a question it asked without
//! blocking). Its turn is not stopped: the gate closes, and the session shows
//! what is really going on, the turn still running or nothing at all.

use crate::app_state::AppState;
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::protocol::GateCloseReason;
use crate::domain::ws_session::runtime::application::clear_answered_gate;

use super::{send_gate_closed, WsSender};

/// Clear the dismissed gate, keeping one the runtime raised meanwhile (the
/// next queued question), and ack it. `None` when the session does not exist;
/// otherwise whether queued prompts may run now.
pub(super) async fn clear_dismissed_gate(
    sender: &WsSender,
    app_state: &AppState,
    db_session_id: i64,
    request_id: &str,
    reason: GateCloseReason,
    envelope_id: &str,
) -> Result<Option<bool>, sqlx::Error> {
    let Some(cleared) =
        clear_answered_gate(&app_state.write_pool, db_session_id, request_id).await?
    else {
        return Ok(None);
    };
    // The status comes from the statement that cleared the gate: a turn that
    // ends after it sees no gate and goes idle itself, and the book drops this
    // transition once a turn start or end moved it on.
    let status = status_after_dismissal(&cleared.status);
    let nothing_pending = cleared.remaining.is_none();
    app_state.session_status_tx.broadcast_gate_dismissed(
        db_session_id,
        cleared.feature_id,
        request_id,
        status,
        cleared.remaining,
    );
    send_gate_closed(
        sender,
        db_session_id,
        Some(request_id),
        reason,
        Some(envelope_id),
    );
    // A turn that already ended let nothing queued run while the gate was
    // open. The drain checks again that the session is free to take a prompt.
    Ok(Some(nothing_pending && status == AgentStatus::Idle))
}

/// The turn that asked goes on if it is still running; otherwise it ended
/// while the question waited, and closing the question leaves nothing to do.
fn status_after_dismissal(session_status: &str) -> AgentStatus {
    if session_status == "running" {
        AgentStatus::Agent
    } else {
        AgentStatus::Idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_running_turn_goes_on_after_a_dismissal() {
        assert_eq!(status_after_dismissal("running"), AgentStatus::Agent);
        for ended in ["completed", "paused", "error"] {
            assert_eq!(status_after_dismissal(ended), AgentStatus::Idle);
        }
    }
}
