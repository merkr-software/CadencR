use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{SdkSessions, WsSender};
use super::permission::respond_permission_claimed;
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{PermissionRespondPayload, WsEnvelope};

pub(crate) async fn handle_permission_respond(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: PermissionRespondPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => payload,
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            return;
        }
    };
    let Some(session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };
    if let Err(error) = app_state
        .pending_gates
        .ensure_loaded(&app_state.read_pool, session_id)
        .await
    {
        send_error(sender, &envelope.id, "DB_ERROR", &error.to_string());
        return;
    }
    if let Err(error) = app_state
        .pending_gates
        .claim(session_id, &payload.request_id)
        .await
    {
        send_error(
            sender,
            &envelope.id,
            "STALE_GATE",
            &format!("Gate is stale, mismatched, or already answered: {error:?}"),
        );
        return;
    }
    respond_permission_claimed(
        payload,
        &envelope.id,
        sender,
        sdk_sessions,
        app_state,
        session_id,
    )
    .await;
}

pub(super) async fn finish_gate_claim(
    state: &AppState,
    session_id: i64,
    request_id: &str,
    success: bool,
) {
    if success {
        state.pending_gates.complete(session_id, request_id).await;
    } else {
        state.pending_gates.release(session_id, request_id).await;
    }
}
