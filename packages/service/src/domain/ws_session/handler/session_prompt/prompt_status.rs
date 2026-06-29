use axum::extract::ws::Message;

use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{
    PromptPersistedPayload, PromptReceivedPayload, UserMessageMirrorPayload, WsEnvelope,
};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use super::super::WsSender;

/// Mirror the just-sent user prompt to *other* devices viewing this feature so
/// their conversation shows it live. The sending device already renders the
/// prompt optimistically, so it's excluded; in the common single-viewer case
/// this is a no-op (`broadcast_others` finds nobody else registered).
pub(super) async fn mirror_user_message(
    feature_senders: &WsFeatureSenderRegistry,
    sender: &WsSender,
    feature_id: i64,
    text: &str,
) {
    let env = WsEnvelope::new(
        "session",
        "user_message",
        serde_json::to_value(UserMessageMirrorPayload {
            text: text.to_string(),
            origin: None,
        })
        .unwrap(),
    );
    feature_senders
        .broadcast_others(feature_id, sender, &Message::Text(String::from(env).into()))
        .await;
}

/// The `prompt_received` ack envelope — the signal that clears a prompt's
/// "pending" decoration on the frontend. Built here so the live ack
/// (`stream_reader_forward`) and the send-failure ack (`clear_pending_prompt_receipt`)
/// share one wire shape.
pub(super) fn prompt_received_envelope(client_message_id: String) -> WsEnvelope {
    WsEnvelope::new(
        "session",
        "prompt_received",
        serde_json::to_value(PromptReceivedPayload { client_message_id }).unwrap(),
    )
}

/// Tell the *sending* device the persisted DB id of the user message it just
/// rendered optimistically, so rewind/fork can target it without a reload. Sent
/// to the sender only — other viewers receive the message via the mirror and
/// hydrate its id when they reload. Best-effort: a closed sender socket means
/// the device is gone, so there is nothing to surface.
pub(super) async fn ack_persisted_user_message(
    sender: &WsSender,
    user_message_ref: &str,
    message_id: i64,
) {
    let env = prompt_persisted_envelope(user_message_ref.to_string(), message_id);
    let _ = sender.send(Message::Text(String::from(env).into()));
}

/// Wire shape for the `prompt_persisted` ack — split out so the sender helper
/// and the unit test share one definition.
pub(super) fn prompt_persisted_envelope(user_message_ref: String, message_id: i64) -> WsEnvelope {
    WsEnvelope::new(
        "session",
        "prompt_persisted",
        serde_json::to_value(PromptPersistedPayload {
            user_message_ref,
            message_id,
        })
        .unwrap(),
    )
}

/// Ack a tracked prompt the agent never received because the stream send
/// failed. The backend receipt is already discarded; this only tells the
/// client to stop the spinner (the accompanying `SDK_ERROR` envelope says why).
/// Mirrored like the live ack so the original sender clears even when it is not
/// the turn owner.
pub(super) async fn clear_pending_prompt_receipt(
    feature_senders: &WsFeatureSenderRegistry,
    sender: &WsSender,
    feature_id: i64,
    client_message_id: String,
) {
    let msg = Message::Text(String::from(prompt_received_envelope(client_message_id)).into());
    feature_senders
        .send_and_mirror(feature_id, sender, msg)
        .await;
}

pub(super) async fn mark_agent_running(
    write_pool: &sqlx::SqlitePool,
    session_status_tx: &crate::domain::session_status::SessionStatusBroadcaster,
    active_turns: &super::super::ActiveTurnRegistry,
    owner: &super::super::SdkSessions,
    db_session_id: i64,
    feature_id: i64,
) {
    // Stamp the turn start on the server and record this connection as the
    // turn's owner. The timestamp is the single source of truth the timer is
    // anchored to on every client; the owner pointer lets a remote device
    // answer a permission/question/plan against this live turn.
    let started_at_ms = super::super::active_turns::now_ms();
    active_turns
        .begin_turn(db_session_id, owner, started_at_ms)
        .await;
    WsSessionPersistence::mark_running_static(write_pool, db_session_id).await;
    session_status_tx.broadcast_running_with_start(db_session_id, feature_id, started_at_ms);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_persisted_envelope_carries_client_id_and_message_id() {
        let env = prompt_persisted_envelope("ref-1".to_string(), 42);
        let json: serde_json::Value =
            serde_json::from_str(&String::from(env)).expect("envelope serializes to JSON");
        assert_eq!(json["domain"], "session");
        assert_eq!(json["action"], "prompt_persisted");
        assert_eq!(json["payload"]["user_message_ref"], "ref-1");
        assert_eq!(json["payload"]["message_id"], 42);
    }
}
