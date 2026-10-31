use super::super::helpers::{send_error, send_warning};
use super::super::types::{SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{PermissionRespondPayload, WsEnvelope};
use crate::domain::ws_session::runtime::application::{respond_permission, PermissionContext};
use crate::domain::ws_session::runtime::output::CommandOutput;

pub(crate) async fn handle_permission_respond(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: PermissionRespondPayload = match serde_json::from_value(envelope.payload) {
        Ok(payload) => payload,
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            return;
        }
    };
    let output = CommandOutput {
        recipient: sender.clone().into(),
        correlation_id: envelope.id.clone(),
    };
    let context = PermissionContext::builder()
        .read_pool(&app_state.read_pool)
        .write_pool(&app_state.write_pool)
        .pending_gates(&app_state.pending_gates)
        .active_turns(&app_state.active_turns)
        .session_status(&app_state.session_status_tx)
        .feature_senders(&app_state.ws_feature_senders)
        .feature_events(&app_state.feature_events_tx)
        .build();
    match respond_permission(&context, sdk_sessions, payload, &output).await {
        Ok(outcome) => {
            for warning in outcome.warnings {
                send_warning(sender, &envelope.id, warning.code, &warning.message);
            }
        }
        Err(error) => send_error(sender, &envelope.id, error.code, &error.message),
    }
}
