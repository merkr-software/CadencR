use crate::domain::ws_session::runtime::helpers::{
    broadcast_session_error, SESSION_STATE_NOT_SAVED,
};
use crate::domain::ws_session::runtime::output::OutputTarget;

use super::bridge::WsBridgeCanUseTool;
use super::{
    persist_and_publish_user_message, CanonicalUserMessageMode, CanonicalUserMessageRequest,
};
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::sessions::user_messages::canonical_user_message_uuid;

impl WsBridgeCanUseTool {
    pub(in crate::domain::ws_session) async fn persist_and_publish_plan_message(
        &self,
        text: &str,
        message_uuid: Option<&str>,
    ) {
        let message_uuid = match canonical_user_message_uuid(message_uuid) {
            Ok(message_uuid) => message_uuid,
            Err(error) => {
                self.send_user_message_persist_error(&error.to_string())
                    .await;
                return;
            }
        };
        let result = persist_and_publish_user_message(CanonicalUserMessageRequest {
            pool: &self.write_pool,
            feature_senders: &self.feature_senders,
            owner: self.sender.recipient(),
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
                    self.send_user_message_persist_error(&error.to_string())
                        .await;
                }
                self.app_state.feature_events_tx.emit(
                    self.feature_id,
                    None,
                    FeatureEventAction::Reordered,
                );
            }
            Ok(outcome) => {
                if let Err(error) = outcome.delivery {
                    self.send_user_message_persist_error(&error.to_string())
                        .await;
                }
            }
            Err(error) => {
                self.send_user_message_persist_error(&error.to_string())
                    .await
            }
        }
    }

    async fn send_user_message_persist_error(&self, message: &str) {
        tracing::error!(
            db_session_id = self.db_session_id,
            error = message,
            "failed to save the plan feedback message"
        );
        // The plan answer still applies: a notice, not a failed turn.
        self.show_session_error(
            SESSION_STATE_NOT_SAVED,
            format!("Cadencr could not save your plan feedback message ({message}). It may be missing after a restart."),
        )
        .await;
    }

    /// Show a failure no request waits on to every viewer of the feature. The
    /// bridge's own sender is headless when HTTP, MCP or a schedule drove the
    /// turn, and an error sent only there would reach nobody.
    pub(super) async fn show_session_error(&self, code: &str, message: String) {
        broadcast_session_error(&self.feature_senders, self.feature_id, code, message).await;
    }
}

#[cfg(test)]
mod tests {
    use axum::extract::ws::Message;

    use super::super::bridge::WsBridgeCanUseTool;
    use super::super::permission_responses::permission_response_channel;
    use crate::domain::ws_session::handler::tests::support::make_test_app_state;
    use crate::domain::ws_session::runtime::output::SessionOutput;
    use crate::domain::ws_session::runtime::state::new_sdk_sessions;

    /// A bridge driven over HTTP, MCP or a schedule has a headless sender: the
    /// failure used to go nowhere. Every viewer of the feature now sees it.
    #[tokio::test]
    async fn headless_plan_message_failure_reaches_feature_viewers() {
        let app_state = make_test_app_state().await;
        let (_, waiters) = permission_response_channel();
        let bridge = WsBridgeCanUseTool {
            app_state: app_state.clone(),
            sender: SessionOutput::headless(),
            feature_senders: app_state.ws_feature_senders.clone(),
            permission_waiters: waiters,
            feature_id: 7,
            db_session_id: 1,
            write_pool: app_state.write_pool.clone(),
            session_status_tx: app_state.session_status_tx.clone(),
            sdk_sessions: new_sdk_sessions(),
        };
        let (viewer, mut viewer_rx) = tokio::sync::mpsc::unbounded_channel();
        app_state.ws_feature_senders.register(7, viewer).await;

        bridge.send_user_message_persist_error("disk full").await;

        let Message::Text(text) = viewer_rx.try_recv().expect("an error envelope") else {
            panic!("expected a text envelope");
        };
        assert!(text.contains("SESSION_STATE_NOT_SAVED"), "{text}");
        assert!(text.contains("disk full"), "{text}");
    }
}
