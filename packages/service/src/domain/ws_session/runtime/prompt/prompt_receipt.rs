use crate::domain::ws_session::protocol::WsSessionEvent;
use crate::domain::ws_session::runtime::output::OutputTarget;
use axum::extract::ws::Message;

use crate::domain::ws_session::protocol::{PromptReceiptState, PromptReceivedPayload, WsEnvelope};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

pub(in crate::domain::ws_session) fn prompt_received_envelope(
    message_uuid: String,
    delivery_state: PromptReceiptState,
) -> WsEnvelope {
    WsEnvelope::session_event(&WsSessionEvent::PromptReceived(PromptReceivedPayload {
        message_uuid,
        delivery_state,
    }))
    .expect("prompt received payload should serialize")
}

/// Tell the client a tracked prompt could not reach the agent. Returns true
/// when the owner socket closed before the receipt could be delivered.
pub(in crate::domain::ws_session) async fn clear_pending_prompt_receipt(
    pool: &sqlx::SqlitePool,
    feature_senders: &WsFeatureSenderRegistry,
    sender: &impl OutputTarget,
    feature_id: i64,
    session_id: i64,
    message_uuid: String,
) -> bool {
    let transitioned = match crate::domain::sessions::user_messages::update_delivery_state(
        pool,
        session_id,
        &message_uuid,
        "delivery_failed",
    )
    .await
    {
        Ok(transitioned) => transitioned,
        Err(error) => {
            tracing::error!(session_id, error = %error, "failed to persist prompt delivery failure");
            return false;
        }
    };
    if !transitioned {
        tracing::warn!(session_id, %message_uuid, "ignored prompt delivery failure for an ineligible canonical message");
        return false;
    }
    let msg = Message::Text(
        String::from(prompt_received_envelope(
            message_uuid,
            PromptReceiptState::DeliveryFailed,
        ))
        .into(),
    );
    feature_senders
        .send_and_mirror(feature_id, sender, msg)
        .await
}

pub(in crate::domain::ws_session) async fn confirm_prompt_delivery(
    pool: &sqlx::SqlitePool,
    feature_senders: &WsFeatureSenderRegistry,
    sender: &impl OutputTarget,
    feature_id: i64,
    session_id: i64,
    message_uuid: &str,
) -> bool {
    let transitioned = match crate::domain::sessions::user_messages::update_delivery_state(
        pool,
        session_id,
        message_uuid,
        "received_agent",
    )
    .await
    {
        Ok(transitioned) => transitioned,
        Err(error) => {
            tracing::error!(session_id, error = %error, "failed to persist prompt delivery success");
            return false;
        }
    };
    if !transitioned {
        tracing::warn!(session_id, %message_uuid, "ignored prompt delivery receipt for an unknown canonical message");
        return false;
    }
    let msg = Message::Text(
        String::from(prompt_received_envelope(
            message_uuid.to_string(),
            PromptReceiptState::ReceivedAgent,
        ))
        .into(),
    );
    feature_senders
        .send_and_mirror(feature_id, sender, msg)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn rejected_terminal_transitions_do_not_emit_receipts() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE agent_messages (
                session_id INTEGER NOT NULL,
                message_uuid TEXT,
                delivery_state TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        let registry = WsFeatureSenderRegistry::new();
        let (owner, mut owner_rx) = mpsc::unbounded_channel();

        assert!(!confirm_prompt_delivery(&pool, &registry, &owner, 1, 7, "missing").await);
        let owner_closed =
            clear_pending_prompt_receipt(&pool, &registry, &owner, 1, 7, "missing".to_string())
                .await;
        assert!(!owner_closed);
        assert!(owner_rx.try_recv().is_err());
    }
}
