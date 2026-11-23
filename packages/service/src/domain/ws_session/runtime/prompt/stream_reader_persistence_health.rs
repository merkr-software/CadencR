use crate::domain::ws_session::persistence::{TranscriptPersistenceError, WsSessionPersistence};
use crate::domain::ws_session::protocol::SessionPersistenceStatusPayload;
use tracing::error;

use super::stream_reader_task::StreamReaderTask;

impl StreamReaderTask {
    pub(in crate::domain::ws_session) async fn flush_due_deltas(
        &self,
        persistence: &mut WsSessionPersistence,
    ) {
        self.handle_delta_flush_result(persistence.flush_due_deltas().await, persistence, false)
            .await;
    }

    pub(in crate::domain::ws_session) async fn flush_all_pending_deltas(
        &self,
        persistence: &mut WsSessionPersistence,
        terminal: bool,
    ) {
        self.handle_delta_flush_result(
            persistence.flush_all_pending_deltas().await,
            persistence,
            terminal,
        )
        .await;
    }

    async fn handle_delta_flush_result(
        &self,
        result: Result<(), TranscriptPersistenceError>,
        persistence: &mut WsSessionPersistence,
        terminal: bool,
    ) {
        match result {
            Ok(()) | Err(TranscriptPersistenceError::AwaitingReconciliation) => {}
            Err(error) => {
                error!(self.db_session_id, error = %error, "transcript delta flush degraded");
                self.publish_transcript_status(persistence, terminal).await;
            }
        }
    }

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
