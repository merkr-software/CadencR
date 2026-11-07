use tracing::{error, info};

use crate::domain::agents::adapter::RuntimeError;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::runtime::helpers::report_if_unsaved;

use super::super::QueryState;
use super::stream_reader_task::{StreamReaderState, StreamReaderTask};

impl StreamReaderTask {
    pub(in crate::domain::ws_session) async fn handle_reader_closed(
        &self,
        state: &mut StreamReaderState,
    ) {
        if self.discard_if_superseded("closed").await {
            return;
        }
        if let Some(generation) = self.take_interruption().await {
            self.handle_interrupted_end(state, generation).await;
        } else if self.end_turn_cut_off_by_shutdown(state).await {
            // The next start resumes it; departing clients need no error.
        } else if self.stream_close_was_unexpected(state).await {
            self.handle_unexpected_stop(state).await;
        } else {
            self.send_stream_closed(state).await;
        }
    }

    pub(in crate::domain::ws_session) async fn handle_reader_error(
        &self,
        state: &mut StreamReaderState,
        error: RuntimeError,
    ) {
        if self.discard_if_superseded("failed").await {
            return;
        }
        if let Some(generation) = self.take_interruption().await {
            info!(
                self.db_session_id,
                error = %error,
                "runtime ended while processing an intentional interruption"
            );
            self.handle_interrupted_end(state, generation).await;
            if error.is_stop_escalation() {
                // The stop happened, but by killing the runtime: whatever it
                // held (processes, MCP servers, unsaved state) is gone.
                self.persist_and_emit_error("AGENT_STOP_ESCALATED", error.to_string(), None)
                    .await;
            }
        } else if self.end_turn_cut_off_by_shutdown(state).await {
            info!(self.db_session_id, error = %error, "runtime failed while the service shut down");
        } else {
            self.handle_stream_error(state, error).await;
        }
    }

    /// A Stop between turns, while only background agents were running: the
    /// CLI stops them and acknowledges, but sends no `result` since no turn
    /// was running. Called when the last of them ended: that ends the stop.
    pub(in crate::domain::ws_session) async fn end_background_only_stop(
        &self,
        state: &mut StreamReaderState,
    ) {
        if !state.turn_state.has_completed_turn() {
            return;
        }
        if let Some(generation) = self.take_interruption().await {
            self.handle_interrupted_end(state, generation).await;
        }
    }

    /// End a turn the service's own shutdown cut off, without the "agent
    /// stopped unexpectedly" error: it is captured (here, when the capture at
    /// the start of shutdown missed it), and the next start marks the
    /// transcript and resumes the conversation (`restart_continuations`).
    /// Returns false when this close is not that.
    async fn end_turn_cut_off_by_shutdown(&self, state: &StreamReaderState) -> bool {
        if !crate::domain::restart_continuations::is_shutting_down()
            || !self.stream_close_was_unexpected(state).await
        {
            return false;
        }
        info!(
            self.db_session_id,
            "agent turn ended by service shutdown; the next start resumes it"
        );
        crate::domain::restart_continuations::capture_cut_off_turn(
            &self.write_pool,
            self.db_session_id,
        )
        .await;
        self.fail_receipts_and_pause("at shutdown").await;
        true
    }

    /// End a turn that did not finish: prompts still waiting for a receipt
    /// failed, and the session is paused.
    pub(in crate::domain::ws_session) async fn fail_receipts_and_pause(
        &self,
        context: &'static str,
    ) {
        if let Err(error) = crate::domain::sessions::user_messages::resolve_pending_delivery_states(
            &self.write_pool,
            self.db_session_id,
            "delivery_failed",
        )
        .await
        {
            error!(self.db_session_id, error = %error, context, "failed to resolve pending prompt receipts");
        }
        self.check_write(
            WsSessionPersistence::mark_paused_static(&self.write_pool, self.db_session_id).await,
            "that the agent paused",
        )
        .await;
    }

    pub(in crate::domain::ws_session) async fn record_completed(&self) {
        let written =
            WsSessionPersistence::mark_completed_static(&self.write_pool, self.db_session_id).await;
        self.check_write(written, "that the agent finished").await;
    }

    pub(in crate::domain::ws_session) async fn record_running(&self) {
        let written =
            WsSessionPersistence::mark_running_static(&self.write_pool, self.db_session_id).await;
        self.check_write(written, "that the agent is working").await;
    }

    /// Surface a session-state write that failed to every viewer.
    pub(in crate::domain::ws_session) async fn check_write(
        &self,
        written: Result<(), sqlx::Error>,
        what: &str,
    ) {
        let senders = &self.feature_senders;
        report_if_unsaved(senders, self.feature_id, self.db_session_id, what, written).await;
    }

    pub(in crate::domain::ws_session) async fn discard_superseded_event(&self) -> bool {
        self.discard_if_superseded("emitted an event").await
    }

    pub(in crate::domain::ws_session) async fn take_interruption(&self) -> Option<u64> {
        let runtime = self.runtime_session_handle.as_ref()?;
        self.app_state
            .active_turns
            .take_interruption(self.db_session_id, runtime)
            .await
    }

    async fn discard_if_superseded(&self, action: &str) -> bool {
        if self.runtime_is_current().await {
            return false;
        }
        let _ = self.take_interruption().await;
        info!(
            self.db_session_id,
            action, "superseded runtime stream ended without affecting the current turn"
        );
        true
    }

    async fn runtime_is_current(&self) -> bool {
        let Some(runtime) = self.runtime_session_handle.as_ref() else {
            return true;
        };
        let sessions = self.sdk_sessions.lock().await;
        let Some(handle) = sessions.get(&self.db_session_id) else {
            return false;
        };
        let QueryState::Active { query, .. } = &handle.state else {
            return false;
        };
        std::sync::Weak::ptr_eq(&std::sync::Arc::downgrade(query), runtime)
    }
}
