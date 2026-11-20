//! What follows a turn's result: the next queued prompt, if any, and a
//! refreshed MCP server list.

use tracing::error;

use super::mcp_servers::refreshed_mcp_servers_message;
use super::stream_reader_task::StreamReaderTask;

impl StreamReaderTask {
    pub(super) async fn after_turn_result(&self) {
        self.drain_queued_message_after_result().await;
        self.refresh_mcp_servers_after_turn().await;
    }

    /// A stop that closed the turn's gate lets the queue go on once the
    /// stopped turn `generation` has ended, as a turn that ended by itself.
    pub(super) async fn after_stopped_turn(&self, generation: u64) {
        if self
            .app_state
            .active_turns
            .take_queue_after_stop(self.db_session_id, generation)
            .await
        {
            self.drain_queued_message_after_result().await;
        }
    }

    async fn drain_queued_message_after_result(&self) {
        // Unknown gate state must not let a queued prompt run over a gate.
        let Ok(row) = self
            .read_session_row("Queued messages wait until the next turn ends.")
            .await
        else {
            return;
        };
        if row.is_some_and(|row| row.has_pending_user_input()) {
            return;
        }
        // The user's own queued prompts go first: they are what the person
        // supervising this session asked for next.
        use crate::domain::prompt_queue::delivery::drain_next_after_turn;
        if drain_next_after_turn(&self.app_state, self.db_session_id).await {
            return;
        }
        if let Err(error) = crate::domain::mcp::control::message_queue::drain_next_queued_message(
            &self.app_state,
            self.feature_id,
            self.db_session_id,
        )
        .await
        {
            error!(self.db_session_id, error = %error, "failed to drain queued MCP message");
        }
    }

    async fn refresh_mcp_servers_after_turn(&self) {
        let message = refreshed_mcp_servers_message(
            &self.sdk_sessions,
            self.db_session_id,
            crate::domain::ws_session::stream_readers::closing(),
        )
        .await;
        if let Some(message) = message {
            self.publish(message).await;
        }
    }
}
