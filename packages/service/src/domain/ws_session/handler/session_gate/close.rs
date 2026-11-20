//! Closing a gate, whoever asks: the desktop's `session.gate.close` (Escape,
//! "Reject & Stop") or a caller with no socket. The work is the same; every
//! failure comes back as a [`CommandError`] for the caller to report, and
//! `gate.closed` goes to `output`.

use super::{
    clear_persisted_gate_and_notify, dismissed, durable_close, RuntimeGateClose, SdkSessions,
};
use crate::app_state::AppState;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::GateCloseReason;
use crate::domain::ws_session::runtime::output::{CommandError, OutputTarget};

/// Which gate to close, and why.
pub(crate) struct GateCloseRequest<'a> {
    pub(crate) db_session_id: i64,
    /// The gate to close; `None` closes the latest open one.
    pub(crate) request_id: Option<&'a str>,
    pub(crate) reason: GateCloseReason,
    /// The command this close answers, echoed on `gate.closed`.
    pub(crate) ref_id: Option<&'a str>,
}

/// Close the gate: saved first, then the runtime blocked on it is stopped (or
/// the request dropped when the agent never waited on it), then the session
/// goes idle and queued prompts may run.
pub(crate) async fn close_gate(
    app_state: &AppState,
    sdk_sessions: &SdkSessions,
    output: &impl OutputTarget,
    request: GateCloseRequest<'_>,
) -> Result<(), CommandError> {
    let GateCloseRequest {
        db_session_id,
        request_id,
        reason,
        ref_id,
    } = request;
    let request_id = claim_gate_close(app_state, db_session_id, request_id)
        .await
        .map_err(|message| CommandError::new("STALE_GATE", message))?;
    let (closed, cleared_ahead) =
        durable_close::close_runtime_side(sdk_sessions, app_state, db_session_id, &request_id)
            .await?;
    let cleared = match &closed {
        RuntimeGateClose::Dismissed => {
            dismissed::clear_dismissed_gate(
                output,
                app_state,
                db_session_id,
                &request_id,
                reason,
                ref_id,
            )
            .await
        }
        RuntimeGateClose::NoRuntime | RuntimeGateClose::Stopped { .. } => {
            clear_persisted_gate_and_notify(
                output,
                app_state,
                db_session_id,
                Some(&request_id),
                reason,
                ref_id,
                cleared_ahead,
            )
            .await
            // A turn this close stopped may still be ending here, and the
            // queue then waits: its stream reader runs the next queued
            // prompt once the turn has ended.
            .map(|found| found.then_some(matches!(closed, RuntimeGateClose::Stopped { .. })))
        }
    };
    settle_gate_close(app_state, db_session_id, &request_id, cleared, closed).await
}

/// Settle the claim once the persisted gate is cleared. `cleared` is `None`
/// for a missing session, else whether queued prompts may run now.
async fn settle_gate_close(
    app_state: &AppState,
    db_session_id: i64,
    request_id: &str,
    cleared: Result<Option<bool>, sqlx::Error>,
    closed: RuntimeGateClose,
) -> Result<(), CommandError> {
    let error = match cleared {
        Ok(Some(drain)) => {
            app_state
                .pending_gates
                .complete(db_session_id, request_id)
                .await;
            // Prompt writers waited behind the cancellation until gate.closed.
            drop(closed);
            if drain {
                drain_after_gate_close(app_state, db_session_id)
                    .await
                    .map_err(|error| {
                        CommandError::new("QUEUE_DELIVERY_FAILED", error.to_string())
                    })?;
            }
            return Ok(());
        }
        Ok(None) => CommandError::new("SESSION_NOT_FOUND", "Session not found"),
        Err(error) => CommandError::new("DB_ERROR", format!("Failed to close gate: {error}")),
    };
    app_state
        .pending_gates
        .release(db_session_id, request_id)
        .await;
    Err(error)
}

/// Claim the open gate the close names (the latest open one when it names
/// none). A close only ever applies to an open gate: with none, or another
/// one, open, it is stale, and stopping the runtime would end whatever runs
/// now (a queued prompt that started since).
async fn claim_gate_close(
    state: &AppState,
    session_id: i64,
    requested_id: Option<&str>,
) -> Result<String, String> {
    state
        .pending_gates
        .ensure_loaded(&state.read_pool, session_id)
        .await
        .map_err(|error| error.to_string())?;
    let Some(gate) = state.pending_gates.latest_open(session_id).await else {
        return Err("no gate is open: it was answered or closed already".to_string());
    };
    let request_id = requested_id.unwrap_or(&gate.request_id).to_string();
    state
        .pending_gates
        .claim(session_id, &request_id)
        .await
        .map_err(|error| format!("gate is stale, mismatched, or already answered: {error:?}"))?;
    Ok(request_id)
}

async fn drain_after_gate_close(
    app_state: &AppState,
    session_id: i64,
) -> Result<(), crate::error::AppError> {
    if crate::domain::prompt_queue::delivery::drain_next_after_turn(app_state, session_id).await {
        return Ok(());
    }
    let Some(row) = WsSessionPersistence::get_session_row(&app_state.read_pool, session_id).await?
    else {
        return Ok(());
    };
    crate::domain::mcp::control::message_queue::drain_next_queued_message(
        app_state,
        row.feature_id,
        session_id,
    )
    .await?;
    Ok(())
}
