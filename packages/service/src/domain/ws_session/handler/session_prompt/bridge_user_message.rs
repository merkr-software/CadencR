use crate::domain::ws_session::protocol::WsSessionEvent;
use axum::extract::ws::Message;

use super::bridge::WsBridgeCanUseTool;
use super::{
    persist_and_publish_user_message, CanonicalUserMessageMode, CanonicalUserMessageRequest,
};
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::sessions::user_messages::canonical_user_message_uuid;
use crate::domain::ws_session::protocol::{SessionErrorPayload, WsEnvelope};

impl WsBridgeCanUseTool {
    pub(super) async fn persist_and_publish_plan_message(
        &self,
        text: &str,
        message_uuid: Option<&str>,
    ) {
        let message_uuid = match canonical_user_message_uuid(message_uuid) {
            Ok(message_uuid) => message_uuid,
            Err(error) => {
                self.send_user_message_persist_error(&error.to_string());
                return;
            }
        };
        let result = persist_and_publish_user_message(CanonicalUserMessageRequest {
            pool: &self.write_pool,
            feature_senders: &self.feature_senders,
            owner: Some(&self.sender),
            feature_id: self.feature_id,
            session_id: self.db_session_id,
            content: text,
            message_uuid,
            origin: None,
            mode: CanonicalUserMessageMode::PersistOnly,
        })
        .await;
        match result {
            Ok(outcome) if outcome.message.inserted => {
                if let Err(error) = outcome.delivery {
                    self.send_user_message_persist_error(&error.to_string());
                }
                self.app_state.feature_events_tx.emit(
                    self.feature_id,
                    None,
                    FeatureEventAction::Reordered,
                );
            }
            Ok(outcome) => {
                if let Err(error) = outcome.delivery {
                    self.send_user_message_persist_error(&error.to_string());
                }
            }
            Err(error) => self.send_user_message_persist_error(&error.to_string()),
        }
    }

    fn send_user_message_persist_error(&self, message: &str) {
        let error = WsEnvelope::session_event(&WsSessionEvent::Error(SessionErrorPayload {
            code: "USER_MESSAGE_PERSIST_FAILED".to_string(),
            message: message.to_string(),
            ..Default::default()
        }))
        .expect("session event payload should serialize");
        let _ = self.sender.send(Message::Text(String::from(error).into()));
    }
}
