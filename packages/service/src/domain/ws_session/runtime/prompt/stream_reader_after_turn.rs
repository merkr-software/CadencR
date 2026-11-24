//! What follows a turn's result: the next queued prompt, if any, and a
//! refreshed MCP server list.

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
        // Fast path: avoid write_pool read, AppState clone, and task spawn on
        // the common empty-queue turn end.
        match crate::domain::prompt_queue::store::has_pending(
            &self.app_state.read_pool,
            self.db_session_id,
            crate::domain::prompt_queue::store::Pick::Next,
        )
        .await
        {
            Ok(false) => return,
            Ok(true) => {}
            Err(error) => {
                tracing::error!(
                    self.db_session_id,
                    %error,
                    "failed to check pending prompt queue after turn"
                );
                return;
            }
        }
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
        // One queue: the user's own prompts go first, then what other
        // sessions' agents queued for this one. Spawn off the stream reader so
        // it never stops draining `self.message_rx` while a prompt dispatches
        // (ACP streams events on this very channel as soon as the prompt runs).
        let app_state = self.app_state.clone();
        let db_session_id = self.db_session_id;
        tokio::spawn(async move {
            crate::domain::prompt_queue::delivery::drain_next_after_turn(&app_state, db_session_id)
                .await;
        });
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
