use crate::domain::ws_session::protocol::WsSessionEvent;
use crate::shared::discard::IgnoreClosed;
use axum::extract::ws::Message;
use tracing::info;

use super::session_prompt::{PermissionResponse, PermissionResponseSender};
use super::{parse_session_id, send_error, QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimePermissionDecision, RuntimePermissionResponse,
    RuntimePermissionResponseRoute, RuntimeSessionHandle,
};
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{
    GateClosePayload, GateCloseReason, GateClosedPayload, PermissionDecision, WsEnvelope,
};
use crate::domain::ws_session::runtime::output::OutputTarget;

mod close;
mod dismissed;
mod durable_close;

pub(crate) use close::{close_gate, GateCloseRequest};

struct GateRuntimeGuard {
    _barrier: Option<tokio::sync::OwnedMutexGuard<()>>,
}

/// What closing a gate did to the live runtime holding it.
enum RuntimeGateClose {
    /// No live runtime holds the request.
    NoRuntime,
    /// The agent was blocked on it: denied, and its turn stopped.
    Stopped { _guard: GateRuntimeGuard },
    /// The agent never waited on it: dropped, and the turn goes on.
    Dismissed,
}

struct ActiveGateRuntime {
    runtime_provider: String,
    query: RuntimeSessionHandle,
    permission_tx: PermissionResponseSender,
}

pub(super) async fn handle_gate_close(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: GateClosePayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            return;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };
    let request = close::GateCloseRequest {
        db_session_id,
        request_id: payload.request_id.as_deref(),
        reason: payload.reason,
        ref_id: Some(&envelope.id),
    };
    if let Err(error) = close::close_gate(app_state, sdk_sessions, sender, request).await {
        send_error(sender, &envelope.id, error.code, &error.message);
    }
}

pub(super) async fn clear_persisted_gate_and_notify(
    sender: &impl OutputTarget,
    app_state: &AppState,
    db_session_id: i64,
    request_id: Option<&str>,
    reason: GateCloseReason,
    ref_id: Option<&str>,
    cleared_ahead: bool,
) -> Result<bool, sqlx::Error> {
    let Some(row) =
        WsSessionPersistence::get_session_row(&app_state.write_pool, db_session_id).await?
    else {
        return Ok(false);
    };
    if !row.has_pending_user_input() {
        // The caller cleared this gate itself just before: the session is
        // idle now, as when the clear happens here.
        if cleared_ahead {
            app_state.session_status_tx.broadcast(
                db_session_id,
                row.feature_id,
                AgentStatus::Idle,
                None,
            );
        }
        // Idempotent ack: the DB row has no pending gate, but the renderer
        // may still be holding stale gate state (e.g. it raced an earlier
        // answer or the row was cleared on another path). Send the
        // `gate.closed` envelope anyway so the FE drops its prompt UI
        // instead of staying stuck on a gate the backend will not honor.
        let closed = GateClosed {
            db_session_id,
            feature_id: row.feature_id,
            request_id,
            reason,
            ref_id,
        };
        send_gate_closed(sender, app_state, closed).await;
        return Ok(true);
    }

    // Unsaved, the gate would come back on the next open: fail instead of
    // telling every client it closed.
    WsSessionPersistence::try_clear_all_pending_user_input_static(
        &app_state.write_pool,
        db_session_id,
    )
    .await?;
    app_state
        .session_status_tx
        .broadcast(db_session_id, row.feature_id, AgentStatus::Idle, None);
    let closed = GateClosed {
        db_session_id,
        feature_id: row.feature_id,
        request_id,
        reason,
        ref_id,
    };
    send_gate_closed(sender, app_state, closed).await;
    Ok(true)
}

/// A closed gate, as `gate.closed` reports it.
struct GateClosed<'a> {
    db_session_id: i64,
    feature_id: i64,
    request_id: Option<&'a str>,
    reason: GateCloseReason,
    ref_id: Option<&'a str>,
}

/// Answer the socket that closed the gate. Closed headless (HTTP, MCP, a
/// sleep), every viewer of the feature hears of it instead.
async fn send_gate_closed(
    sender: &impl OutputTarget,
    app_state: &AppState,
    closed: GateClosed<'_>,
) {
    let payload = GateClosedPayload {
        session_id: closed.db_session_id.to_string(),
        request_id: closed.request_id.map(str::to_string),
        reason: closed.reason,
    };
    let envelope = match closed.ref_id {
        Some(id) => WsEnvelope::session_reply(id, &WsSessionEvent::GateClosed(payload)),
        None => WsEnvelope::session_event(&WsSessionEvent::GateClosed(payload)),
    };
    let message =
        Message::Text(String::from(envelope.expect("gate.closed payload should serialize")).into());
    match sender.recipient() {
        Some(recipient) => recipient.send(message).ignore_closed(),
        None => {
            app_state
                .ws_feature_senders
                .publish(closed.feature_id, sender, message)
                .await;
        }
    }
}

async fn deny_runtime_gate(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    request_id: &str,
    app_state: &AppState,
) -> Result<RuntimeGateClose, RuntimeError> {
    let owner = super::session_control::resolve_owner_sessions(
        sdk_sessions,
        &app_state.active_turns,
        db_session_id,
    )
    .await;
    let Some(target) = active_runtime(&owner, db_session_id).await else {
        return Ok(RuntimeGateClose::NoRuntime);
    };
    let q = target.query.read().await;
    let barrier = q.turn_control_guard().await;
    // Stopping the turn would end work the agent goes on with while the
    // question waits, or, between turns, leave a stop mark that the next
    // turn's result consumes.
    if q.dismiss_nonblocking_request(request_id).await? {
        return Ok(RuntimeGateClose::Dismissed);
    }
    // Register before denying: Claude can finish the cancelled turn before the
    // interrupt acknowledgement arrives. Reuse Stop's benign completion path,
    // including its transcript marker and preservation of inter-agent waits.
    let generation = app_state
        .active_turns
        .request_interruption(db_session_id, &target.query)
        .await;
    // Once the stopped turn ends, its stream reader runs the next queued
    // prompt; draining here would find the turn still running.
    if let Some(generation) = generation {
        app_state
            .active_turns
            .queue_after_stop(db_session_id, generation)
            .await;
    }
    let runtime_response = RuntimePermissionResponse {
        request_id: request_id.to_string(),
        decision: RuntimePermissionDecision::Deny,
        option_id: None,
        feedback: None,
        updated_input: None,
    };
    deny_open_request(&target, &**q, db_session_id, runtime_response).await;

    let result = q.interrupt().await;
    match super::session_control::finish_interruption(
        result,
        &target.query,
        app_state,
        db_session_id,
        generation,
    )
    .await
    {
        // The denial ended the turn first: nothing was left to stop.
        Err(error) if error.is_nothing_to_interrupt() => {}
        result => result?,
    }
    // Keep prompt writers behind the cancellation until gate.closed is sent.
    Ok(RuntimeGateClose::Stopped {
        _guard: GateRuntimeGuard { _barrier: barrier },
    })
}

/// Resolve the open request through the adapter's declared route. The turn
/// is interrupted right after, so a request that is already gone is benign.
async fn deny_open_request(
    target: &ActiveGateRuntime,
    query: &dyn crate::domain::agents::adapter::AgentRuntimeSession,
    db_session_id: i64,
    response: RuntimePermissionResponse,
) {
    let route = crate::domain::agents::permission_modes::provider_permission_response_route(
        &target.runtime_provider,
    );
    let result = match route {
        RuntimePermissionResponseRoute::Session => query
            .respond_permission(response)
            .await
            .map_err(|error| error.to_string()),
        RuntimePermissionResponseRoute::PermissionCallback => target
            .permission_tx
            .deliver(PermissionResponse {
                request_id: response.request_id,
                message_uuid: None,
                decision: PermissionDecision::Deny,
                option_id: None,
                feedback: None,
                updated_input: None,
                is_approval_gate: false,
            })
            .map_err(|error| error.to_string()),
    };
    if let Err(error) = result {
        info!(db_session_id, %error, "gate close: open request already resolved; interrupting");
    }
}

async fn active_runtime(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
) -> Option<ActiveGateRuntime> {
    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&db_session_id)?;
    match &handle.state {
        QueryState::Active {
            query,
            permission_tx,
        } => Some(ActiveGateRuntime {
            runtime_provider: handle.runtime_provider.clone(),
            query: std::sync::Arc::clone(query),
            permission_tx: permission_tx.clone(),
        }),
        QueryState::Pending(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::handler::tests::support::InPlaceEffortSession;
    use crate::domain::ws_session::runtime::prompt::permission_response_channel;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    #[tokio::test]
    async fn closing_a_callback_routed_gate_denies_only_that_request() {
        let (permission_tx, waiters) = permission_response_channel();
        let open = waiters.register("req-1");
        let other = waiters.register("req-2");
        let target = ActiveGateRuntime {
            // Claude Code answers through the permission callback.
            runtime_provider: "claude_code".into(),
            query: Arc::new(RwLock::new(Box::new(InPlaceEffortSession::new()))),
            permission_tx,
        };
        let response = RuntimePermissionResponse {
            request_id: "req-1".into(),
            decision: RuntimePermissionDecision::Deny,
            option_id: None,
            feedback: None,
            updated_input: None,
        };
        {
            let query = target.query.read().await;
            deny_open_request(&target, &**query, 1, response).await;
        }

        let answer = open.recv().await.expect("the closed gate is answered");
        assert_eq!(answer.request_id, "req-1");
        assert!(matches!(answer.decision, PermissionDecision::Deny));
        // Closing the session resolves the untouched request as "closed", not
        // with the other gate's denial.
        drop(target);
        assert!(other.recv().await.is_none());
    }
}
