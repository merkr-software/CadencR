use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::SessionPersistenceStatusPayload;

use super::stream_reader_task::StreamReaderTask;

impl StreamReaderTask {
    pub(in crate::domain::ws_session) async fn publish_transcript_status(
        &self,
        persistence: &mut WsSessionPersistence,
        terminal: bool,
    ) {
        let Some(status) = persistence.take_transcript_status_change(terminal) else {
            return;
        };
        self.app_state
            .persistence_health
            .publish(
                self.db_session_id,
                self.feature_id,
                self.persistence_reader_id,
                SessionPersistenceStatusPayload {
                    status,
                    message: status.message().into(),
                },
                &self.app_state.read_pool,
                &self.feature_senders,
                &self.sender,
            )
            .await;
    }
}
