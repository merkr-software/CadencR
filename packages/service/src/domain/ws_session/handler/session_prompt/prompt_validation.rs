use crate::domain::sessions::user_messages::canonical_user_message_uuid;
use crate::domain::ws_session::protocol::{PromptSendPayload, WsEnvelope};

use super::super::{parse_session_id, send_error, WsSender};

pub(in crate::domain::ws_session) fn normalize_message_uuid(
    payload: &mut PromptSendPayload,
) -> Result<(), String> {
    let message_uuid = canonical_user_message_uuid(payload.message_uuid.as_deref())
        .map_err(|_| "message_uuid must be a valid UUID".to_string())?
        .to_string();
    payload.message_uuid = Some(message_uuid);
    Ok(())
}

pub(in crate::domain::ws_session) fn parse_prompt_payload(
    envelope: &WsEnvelope,
    sender: &WsSender,
) -> Option<PromptSendPayload> {
    match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => Some(payload),
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            None
        }
    }
}

pub(in crate::domain::ws_session) fn parse_prompt_session_id(
    payload: &PromptSendPayload,
    envelope: &WsEnvelope,
    sender: &WsSender,
) -> Option<i64> {
    match parse_session_id(&payload.session_id) {
        Some(id) => Some(id),
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "session_id must be a numeric DB id",
            );
            None
        }
    }
}
