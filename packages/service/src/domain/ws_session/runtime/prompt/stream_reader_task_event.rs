use super::super::send_runtime_session_id;
use super::mcp_servers::send_mcp_servers_if_init;
use super::stream_reader_background_agents::track_background_agents;
use super::stream_reader_forward::{forward_immediate_event, ForwardOutcome};
use super::stream_reader_resume::runtime_allows_resume_persistence;
use super::stream_reader_task::{StreamReaderState, StreamReaderTask};
use crate::domain::agents::adapter::{AgentRuntimeAdapter, RuntimeEvent, RuntimeTurnStartedSource};
use crate::domain::runtime_stream::{
    capture_runtime_session_id, permission_request_payload, persist_usage,
};
use crate::domain::ws_session::persistence::{
    PendingUserInput, TranscriptPersistenceError, WsSessionPersistence,
};
use crate::domain::ws_session::protocol::{
    permission_request_envelope, PermissionRequestPayload, WsEnvelope,
};
use crate::domain::ws_session::protocol::{SessionCompactingPayload, WsSessionEvent};
use crate::domain::ws_session::runtime::application::mark_awaiting_user;
use axum::extract::ws::Message;
use tracing::{debug, error, info};
impl StreamReaderTask {
    /// Process one runtime event. A closed owner socket is no longer fatal:
    /// every send becomes best-effort because the agent must keep running on
    /// the host after a client (e.g. a sleeping phone) disconnects. The reader
    /// stops only when the runtime stream itself ends, or via deferred teardown
    /// (see [`StreamReaderTask::maybe_teardown_orphaned`]).
    pub(in crate::domain::ws_session) async fn handle_runtime_event(
        &self,
        state: &mut StreamReaderState,
        runtime_adapter: Option<&dyn AgentRuntimeAdapter>,
        persistence: &mut WsSessionPersistence,
        runtime_event: RuntimeEvent,
    ) {
        state.last_runtime_activity = tokio::time::Instant::now();
        state.diagnostics.record(runtime_event.raw_json());
        // Provider-native token reports are recorded before any early return
        // below. Context-window usage remains on the separate `usage_state`
        // path and is never mistaken for consumption, except for Cursor's
        // explicit provider fallback.
        self.capture_usage_attribution(state, &runtime_event).await;
        self.capture_provider_usage_event_id(state, &runtime_event);
        self.record_token_usage(state, &runtime_event).await;
        if runtime_event.is_usage_accounting() {
            return;
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
        self.forward_compaction_state(state, &runtime_event).await;
        track_background_agents(&mut state.live_background_agents, &runtime_event);
        self.track_subagents(state, &runtime_event, interrupted_generation.is_some())
            .await;
        if runtime_event.is_subagent_signal_only() {
            return;
        }
        state.runtime_hold.observe(&runtime_event);

        match forward_immediate_event(self, state, &runtime_event).await {
            // `prompt_received` / `commands.updated` / `stream_status` are
            // transient UI acks that are never persisted. `SenderClosed` here
            // means only the owner socket is gone — mirrored acks
            // (`prompt_received`, `stream_status`) already reached other viewers
            // before that send — so either outcome just continues the stream.
            ForwardOutcome::Forwarded
            | ForwardOutcome::SenderClosed
            | ForwardOutcome::Suppressed => return,
            ForwardOutcome::NotHandled => {}
        }

        if self
            .handle_permission_request(runtime_adapter, &runtime_event)
            .await
        {
            return;
        }

        self.capture_runtime_session_id(state, &runtime_event).await;
        // MCP-server snapshots only go to the owner socket; if it is gone, skip
        // and keep streaming the rest of the turn.
        let _ = self.send_mcp_servers_if_init(&runtime_event).await;

        if self.handle_provider_error(&runtime_event).await {
            state
                .turn_state
                .mark_error_surfaced(runtime_event.parent_tool_use_id());
            return;
        }

        if self.handle_unknown_message(&runtime_event).await {
            state
                .turn_state
                .mark_error_surfaced(runtime_event.parent_tool_use_id());
            return;
        }

        // A turn-ending error result is surfaced but must NOT short-circuit —
        // the result still has to flow through the turn-complete path below.
        // Suppressed when an error already surfaced this turn (issue #78).
        if interrupted_generation.is_none()
            && self
                .surface_result_error(
                    state.turn_state.has_error_surfaced_this_turn(),
                    &runtime_event,
                )
                .await
        {
            state
                .turn_state
                .mark_error_surfaced(runtime_event.parent_tool_use_id());
        }

        if self.handle_non_result_signal(state, &runtime_event).await {
            return;
        }

        self.persist_and_forward_event(
            state,
            runtime_adapter,
            persistence,
            &runtime_event,
            interrupted_generation,
        )
        .await;
    }

    async fn handle_permission_request(
        &self,
        runtime_adapter: Option<&dyn AgentRuntimeAdapter>,
        runtime_event: &RuntimeEvent,
    ) -> bool {
        let Some(request) = runtime_adapter
            .and_then(|adapter| adapter.parse_permission_request(runtime_event.raw_json()))
        else {
            return false;
        };
        let is_question = crate::domain::ws_session::protocol::is_question_tool(&request.tool_name);
        let mut payload: PermissionRequestPayload = permission_request_payload(request);
        crate::domain::ws_session::protocol::clear_question_permission_chrome(&mut payload);
        let question_payload = is_question.then(|| {
            serde_json::to_value(&payload).expect("question permission payload should serialize")
        });
        self.persist_pending_user_input(&payload, question_payload.as_ref())
            .await;
        let envelope = permission_request_envelope(payload)
            .expect("permission request payload should serialize");
        // Mirror the gate to every device viewing this feature so it appears on
        // the host and any remote clients alike, not only the turn owner.
        let _ = self
            .send_and_mirror(Message::Text(String::from(envelope).into()))
            .await;
        true
    }

    async fn persist_pending_user_input(
        &self,
        payload: &PermissionRequestPayload,
        question_payload: Option<&serde_json::Value>,
    ) {
        let pending = question_payload
            .map(PendingUserInput::Question)
            .unwrap_or(PendingUserInput::Permission(payload));
        mark_awaiting_user(
            &self.app_state,
            self.db_session_id,
            self.feature_id,
            &pending,
        )
        .await;
    }

    async fn capture_runtime_session_id(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
    ) {
        let Some(runtime_sid) =
            capture_runtime_session_id(runtime_event, state.runtime_session_id.as_deref())
        else {
            return;
        };
        let durable =
            super::super::session_init_resume::persistable_resume_session_id_for_provider(
                &self.runtime_provider,
                Some(&runtime_sid),
                runtime_allows_resume_persistence(self.runtime_session_handle.as_ref()).await,
            )
            .is_some();
        state.runtime_session_id = Some(runtime_sid.clone());
        state.usage_state.set_root_session_id(runtime_sid.as_str());
        if !durable {
            send_runtime_session_id(&self.sender, runtime_sid.as_str());
            return;
        }
        info!(self.db_session_id, runtime_session_id = %runtime_sid, "stream_reader: persisting runtime session_id to DB");
        WsSessionPersistence::persist_runtime_session_id_static(
            &self.write_pool,
            self.db_session_id,
            &self.runtime_provider,
            runtime_sid.as_str(),
        )
        .await;
        send_runtime_session_id(&self.sender, runtime_sid.as_str());
    }

    async fn send_mcp_servers_if_init(&self, runtime_event: &RuntimeEvent) -> Result<(), ()> {
        let result = send_mcp_servers_if_init(
            &self.sender,
            &self.sdk_sessions,
            self.db_session_id,
            runtime_event,
        )
        .await;
        if result.is_err() {
            debug!(
                self.db_session_id,
                "WebSocket sender closed during mcp_servers forward"
            );
        }
        result
    }

    /// Emit `session.compacting` when a provider reports a compaction start/end.
    async fn forward_compaction_state(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
    ) {
        let next = if matches!(
            runtime_event.turn_started_source(),
            Some(RuntimeTurnStartedSource::ContextCompaction)
                | Some(RuntimeTurnStartedSource::ManualCompact)
        ) {
            true
        } else if runtime_event.is_compact_boundary() || runtime_event.is_result() {
            false
        } else {
            return;
        };

        if !state.turn_state.set_compacting(next) {
            return;
        }
        let envelope =
            WsEnvelope::session_event(&WsSessionEvent::Compacting(SessionCompactingPayload {
                active: next,
            }))
            .expect("session event payload should serialize");
        let _ = self
            .send_and_mirror(Message::Text(String::from(envelope).into()))
            .await;
    }

    async fn handle_non_result_signal(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
    ) -> bool {
        if runtime_event.is_result() {
            return false;
        }
        if crate::domain::session_status::event_starts_fresh_turn(runtime_event) {
            // New turn: clear any error surfaced in the previous turn so this
            // turn's terminal error-result (if any) can surface (issue #78).
            state.turn_state.mark_fresh_turn_started();
        }
        if !state.turn_state.is_between_turns() {
            self.broadcast_runtime_signal(runtime_event).await;
        }
        runtime_event.is_turn_started_signal()
    }

    async fn broadcast_runtime_signal(&self, runtime_event: &RuntimeEvent) {
        if runtime_event.is_turn_started_signal() {
            WsSessionPersistence::mark_running_static(&self.write_pool, self.db_session_id).await;
        }
        self.session_status_tx
            .stream_event(self.db_session_id, self.feature_id, runtime_event);
    }

    async fn persist_and_forward_event(
        &self,
        state: &mut StreamReaderState,
        runtime_adapter: Option<&dyn AgentRuntimeAdapter>,
        persistence: &mut WsSessionPersistence,
        runtime_event: &RuntimeEvent,
        interrupted_generation: Option<u64>,
    ) {
        let usage_update = state
            .usage_state
            .apply_event(runtime_adapter, runtime_event);
        if usage_update.context_window_changed {
            WsSessionPersistence::update_context_window(
                &self.write_pool,
                self.db_session_id,
                usage_update.snapshot.context_window,
            )
            .await;
        }

        let persisted_message = match persistence.persist_runtime_event(runtime_event).await {
            Ok(message) => message,
            Err(TranscriptPersistenceError::AwaitingReconciliation) => None,
            Err(error) => {
                error!(self.db_session_id, error = %error, "transcript persistence degraded");
                None
            }
        };
        self.publish_transcript_status(persistence, runtime_event.is_result())
            .await;
        // Only stream-event blocks carry a stamped model, so skip the lookup
        // entirely for other events on this per-delta hot path.
        let current_model = runtime_event
            .stream_event()
            .and_then(|_| persistence.current_model_for_event(runtime_event));
        if !usage_update.is_subagent {
            let _ = persist_usage(runtime_event, self.db_session_id, &self.write_pool).await;
        }
        // Any change is worth pushing, including a window that resolved on the
        // `init` event before this turn spent a token — without that the UI
        // keeps scaling by whatever window it last had (a different model's)
        // for the whole turn. The snapshot carries the persisted token totals,
        // so a window-only update restates them rather than blanking the bar.
        if usage_update.changed {
            self.send_usage_update(
                usage_update.snapshot.input_tokens,
                usage_update.snapshot.output_tokens,
                usage_update.snapshot.context_window,
            )
            .await;
        }

        let envelope = self
            .runtime_event_envelope(
                state,
                runtime_event,
                persisted_message,
                current_model,
                interrupted_generation,
            )
            .await;
        // Live forwarding continues even when transcript durability is degraded.
        // The event is mirrored to any other connected
        // device, so a gone owner socket is fine — keep streaming. A `None`
        // envelope means the turn-complete signal was intentionally withheld
        // because a background agent is still alive (issue #58) — keep the turn
        // lifecycle in `active` so the header timer doesn't reset on resume.
        if let Some(envelope) = envelope {
            let _ = self
                .send_and_mirror(Message::Text(String::from(envelope).into()))
                .await;
        }
        if runtime_event.is_result()
            && state.live_background_agents.is_empty()
            && interrupted_generation.is_none()
        {
            if let Err(error) = crate::domain::mcp::control::reply_wait::deliver_completed(
                &self.app_state,
                self.db_session_id,
            )
            .await
            {
                error!(self.db_session_id, error = %error, "failed to deliver MCP session reply");
            }
            self.after_turn_result().await;
        }
    }
}
