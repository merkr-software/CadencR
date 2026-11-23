//! The phases [`StreamReaderTask::handle_runtime_event`] runs an event
//! through before it is persisted and forwarded.

use super::stream_reader_background_agents::track_background_agents;
use super::stream_reader_forward::{forward_immediate_event, ForwardOutcome};
use super::stream_reader_task::{StreamReaderState, StreamReaderTask};
use crate::domain::agents::adapter::{AgentRuntimeAdapter, RuntimeEvent};
use crate::domain::ws_session::persistence::WsSessionPersistence;

/// Whether an event still has to be forwarded once the reader observed it.
pub(super) enum EventObservation {
    Consumed,
    Continue { interrupted_generation: Option<u64> },
}

impl StreamReaderTask {
    pub(super) async fn publish_current_mcp_servers(&self) {
        let message =
            super::mcp_servers::current_mcp_servers_message(&self.sdk_sessions, self.db_session_id)
                .await;
        if let Some(message) = message {
            self.publish(message).await;
        }
    }

    /// A `Result` from an older turn generation is discarded, not applied.
    pub(super) async fn accepts_result_event(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
    ) -> bool {
        if !runtime_event.is_result() {
            return true;
        }
        let generation = self
            .app_state
            .active_turns
            .current_generation(self.db_session_id)
            .await;
        if state
            .turn_state
            .accepts_result_generation(runtime_event.is_detached_reply_end(), generation)
        {
            return true;
        }
        self.discard_stale_result(state, runtime_event).await;
        false
    }

    /// Bookkeeping every event feeds before it can be forwarded: usage,
    /// reported status and model, background agents, sub-agents and runtime
    /// holds. Usage reports and sub-agent signals end here.
    pub(super) async fn observe_runtime_event(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
    ) -> EventObservation {
        // Provider-native token reports are recorded before any early return
        // below. Context-window usage remains on the separate `usage_state`
        // path and is never mistaken for consumption, except for a provider's
        // explicit provider fallback.
        self.capture_usage_attribution(state, runtime_event).await;
        self.capture_provider_usage_event_id(state, runtime_event);
        self.record_token_usage(state, runtime_event).await;
        if runtime_event.is_usage_accounting() {
            return EventObservation::Consumed;
        }
        if runtime_event.is_result() {
            state.usage_attribution = None;
            state.usage_attribution_captured = false;
            state.provider_usage_event_id = None;
        }
        let interrupted_generation = if runtime_event.is_result() {
            self.take_interruption().await
        } else {
            None
        };
        self.reflect_reported_status(runtime_event);
        self.observe_reported_model(state, runtime_event).await;
        let had_background_agents = !state.live_background_agents.is_empty();
        track_background_agents(&mut state.live_background_agents, runtime_event);
        if had_background_agents && state.live_background_agents.is_empty() {
            self.end_background_only_stop(state).await;
        }
        self.track_subagents(state, runtime_event, interrupted_generation.is_some())
            .await;
        if runtime_event.is_subagent_signal_only() {
            return EventObservation::Consumed;
        }
        state
            .runtime_hold
            .observe(runtime_event, !state.turn_state.is_between_turns());
        EventObservation::Continue {
            interrupted_generation,
        }
    }

    /// Transient acks and permission requests, which are never persisted, plus
    /// the session id and MCP snapshot an `init` carries. Returns whether the
    /// event was fully handled.
    pub(super) async fn handle_before_persistence(
        &self,
        state: &mut StreamReaderState,
        runtime_adapter: Option<&dyn AgentRuntimeAdapter>,
        persistence: &mut WsSessionPersistence,
        runtime_event: &RuntimeEvent,
    ) -> bool {
        match forward_immediate_event(self, state, runtime_event).await {
            // `prompt_received` / `commands.updated` / `stream_status` are
            // transient UI acks that are never persisted. `SenderClosed` here
            // means only the owner socket is gone — mirrored acks
            // (`prompt_received`, `stream_status`) already reached other viewers
            // before that send — so either outcome just continues the stream.
            ForwardOutcome::Forwarded
            | ForwardOutcome::SenderClosed
            | ForwardOutcome::Suppressed => return true,
            ForwardOutcome::NotHandled => {}
        }
        if self
            .handle_permission_request(runtime_adapter, persistence, runtime_event)
            .await
        {
            return true;
        }
        self.capture_runtime_session_id(state, runtime_adapter, runtime_event)
            .await;
        // MCP-server snapshots only go to the owner socket; if it is gone, skip
        // and keep streaming the rest of the turn.
        self.send_mcp_servers_if_init(runtime_event).await;
        false
    }

    /// Show provider errors, unknown messages and error results. Buffered text
    /// is written first so the transcript holds everything before the error.
    /// Returns whether the event was fully handled.
    pub(super) async fn surface_event_errors(
        &self,
        state: &mut StreamReaderState,
        persistence: &mut WsSessionPersistence,
        runtime_event: &RuntimeEvent,
        interrupted_generation: Option<u64>,
    ) -> bool {
        if runtime_event.provider_error().is_some()
            || runtime_event.unknown_message().is_some()
            || runtime_event.result_error().is_some()
        {
            self.flush_all_pending_deltas(persistence, false).await;
        }
        if self.handle_provider_error(runtime_event).await
            || self.handle_unknown_message(runtime_event).await
        {
            state
                .turn_state
                .mark_error_surfaced(runtime_event.parent_tool_use_id());
            return true;
        }
        // A turn-ending error result is surfaced but must NOT short-circuit —
        // the result still has to flow through the turn-complete path below.
        // Suppressed when an error already surfaced this turn (issue #78).
        if interrupted_generation.is_none()
            && self
                .surface_result_error(
                    state.turn_state.has_error_surfaced_this_turn(),
                    runtime_event,
                )
                .await
        {
            state
                .turn_state
                .mark_error_surfaced(runtime_event.parent_tool_use_id());
        }
        false
    }
}
