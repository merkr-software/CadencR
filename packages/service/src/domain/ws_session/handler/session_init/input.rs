use crate::domain::ws_session::protocol::{SessionInitPayload, WsEnvelope};

use super::{send_error, WsSender};

pub(super) fn parse(
    envelope: &WsEnvelope,
    sender: &WsSender,
) -> Option<(SessionInitPayload, i64, String)> {
    let payload: SessionInitPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => payload,
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            return None;
        }
    };
    let Some(feature_id) = payload.feature_id else {
        send_error(
            sender,
            &envelope.id,
            "MISSING_FEATURE_ID",
            "feature_id is required for session init",
        );
        return None;
    };
    let Some(cwd) = payload.cwd.clone().filter(|cwd| !cwd.is_empty()) else {
        send_error(
            sender,
            &envelope.id,
            "MISSING_CWD",
            "cwd is required for session init",
        );
        return None;
    };
    Some((payload, feature_id, cwd))
}
