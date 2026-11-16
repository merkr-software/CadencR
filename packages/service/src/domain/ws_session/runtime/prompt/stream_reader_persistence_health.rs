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
            .publish()
            .session_id(self.db_session_id)
            .feature_id(self.feature_id)
            .reader_id(self.persistence_reader_id)
            .payload(SessionPersistenceStatusPayload {
                status,
                message: status.message().into(),
            })
            .read_pool(&self.app_state.read_pool)
            .senders(&self.feature_senders)
            .sender(&self.sender)
            .call()
            .await;
    }
}
