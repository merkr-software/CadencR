use super::generated_message::{
    dispatch_generated_prompt, persist_and_broadcast_generated_user_message,
};
use super::scope::SessionScope;
use crate::app_state::AppState;
use crate::error::AppError;

const REPLY_DELIVERY_NOTE: &str = "automatic reply from agent session turn";
const GATE_DELIVERY_NOTE: &str = "automatic gate notification from linked child session";

pub(super) async fn deliver_reply(
    state: &AppState,
    responder: &SessionScope,
    requester: &SessionScope,
    envelope: &str,
    message_uuid: uuid::Uuid,
) -> Result<(), AppError> {
    deliver(
        state,
        responder,
        requester,
        envelope,
        REPLY_DELIVERY_NOTE,
        message_uuid,
    )
    .await
}

pub(super) async fn deliver_gate(
    state: &AppState,
    child: &SessionScope,
    parent: &SessionScope,
    envelope: &str,
) -> Result<(), AppError> {
    deliver(
        state,
        child,
        parent,
        envelope,
        GATE_DELIVERY_NOTE,
        uuid::Uuid::new_v4(),
    )
    .await
}

async fn deliver(
    state: &AppState,
    responder: &SessionScope,
    requester: &SessionScope,
    envelope: &str,
    delivery_note: &str,
    message_uuid: uuid::Uuid,
) -> Result<(), AppError> {
    let persisted = persist_and_broadcast_generated_user_message(
        state,
        responder,
        requester.session_id,
        requester.feature_id,
        envelope,
        delivery_note,
        message_uuid,
    )
    .await?;
    let message_uuid = uuid::Uuid::parse_str(&persisted.message_uuid)
        .map_err(|_| AppError::internal("persisted user message returned an invalid UUID"))?;
    dispatch_generated_prompt(
        state,
        requester.feature_id,
        requester.session_id,
        envelope,
        message_uuid,
    )
    .await
}
