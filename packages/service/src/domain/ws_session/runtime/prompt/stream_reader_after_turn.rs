//! What follows a turn's result: the next queued prompt, if any, and a
//! refreshed MCP server list.

use tracing::{debug, error};

use super::mcp_servers::refresh_mcp_servers_for_active_session;
use super::stream_reader_task::StreamReaderTask;

impl StreamReaderTask {
    pub(super) async fn after_turn_result(&self) {
        self.drain_queued_message_after_result().await;
        self.refresh_mcp_servers_after_turn().await;
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
        let result = refresh_mcp_servers_for_active_session(
            &self.sender,
            &self.sdk_sessions,
            self.db_session_id,
            crate::domain::ws_session::stream_readers::closing(),
        )
        .await;
        if result.is_err() {
            debug!(
                self.db_session_id,
                "WebSocket sender closed during post-turn mcp_servers refresh"
            );
        }
    }
}
