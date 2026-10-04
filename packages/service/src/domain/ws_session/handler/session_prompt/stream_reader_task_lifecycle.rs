use tracing::info;

use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent};
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::persistence::WsSessionPersistence;

use super::super::QueryState;
use super::stream_reader_task::{StreamReaderState, StreamReaderTask};

impl StreamReaderTask {
    pub(super) async fn broadcast_runtime_signal(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
    ) {
        let Some(signal) = crate::domain::session_status::provider_signal_for_event(runtime_event)
        else {
            return;
        };
        let next = signal.status();
        if !state.turn_state.record_signal_status(next) {
            return;
        }
        if runtime_event.is_turn_started_signal() && next == AgentStatus::Agent {
            WsSessionPersistence::mark_running_static(&self.write_pool, self.db_session_id).await;
        }
        self.app_state
            .pending_gates
            .broadcast_status(
                &self.session_status_tx,
                crate::domain::session_status::SessionStatusEvent::builder()
                    .session_id(self.db_session_id)
                    .feature_id(self.feature_id)
                    .status(next)
                    .maybe_turn_started_at_ms(
                        self.app_state
                            .active_turns
                            .started_at(self.db_session_id)
                            .await,
                    )
                    .build(),
            )
            .await;
    }

    pub(super) async fn handle_reader_closed(&self, state: &mut StreamReaderState) {
        if self.discard_if_superseded("closed").await {
            return;
        }
        if let Some(generation) = self.take_interruption().await {
            self.handle_interrupted_end(state, generation).await;
        } else if self.stream_close_was_unexpected(state).await {
            self.handle_unexpected_stop(state).await;
        } else {
            self.send_stream_closed(state).await;
        }
    }

    pub(super) async fn handle_reader_error(
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
        } else {
            self.handle_stream_error(state, error).await;
        }
    }

    pub(super) async fn discard_superseded_event(&self) -> bool {
        self.discard_if_superseded("emitted an event").await
    }

    pub(super) async fn take_interruption(&self) -> Option<u64> {
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
