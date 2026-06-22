use axum::extract::ws::Message;
use tracing::{debug, error, info};

use crate::domain::agents::adapter::{AgentRuntimeAdapter, RuntimeEvent, RuntimeTurnStartedSource};
use crate::domain::runtime_stream::{
    capture_runtime_session_id, permission_request_payload, persist_usage,
};
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::persistence::{PendingUserInput, WsSessionPersistence};
use crate::domain::ws_session::protocol::{
    PermissionRequestPayload, SessionErrorPayload, WsEnvelope,
};

use super::super::send_runtime_session_id;
use super::mcp_servers::{refresh_mcp_servers_for_active_session, send_mcp_servers_if_init};
use super::stream_reader_background_agents::track_background_agents;
use super::stream_reader_forward::{forward_immediate_event, ForwardOutcome};
use super::stream_reader_task::{StreamReaderState, StreamReaderTask};

impl StreamReaderTask {
    /// Process one runtime event. A closed owner socket is no longer fatal:
    /// every send becomes best-effort because the agent must keep running on
    /// the host after a client (e.g. a sleeping phone) disconnects. The reader
    /// stops only when the runtime stream itself ends, or via deferred teardown
    /// (see [`StreamReaderTask::maybe_teardown_orphaned`]).
    pub(super) async fn handle_runtime_event(
        &self,
        state: &mut StreamReaderState,
        runtime_adapter: Option<&'static dyn AgentRuntimeAdapter>,
        persistence: &mut WsSessionPersistence,
        runtime_event: RuntimeEvent,
    ) {
        state.last_runtime_activity = tokio::time::Instant::now();
        self.forward_compaction_state(state, &runtime_event).await;
        track_background_agents(&mut state.live_background_agents, &runtime_event);

        match forward_immediate_event(self, &runtime_event).await {
            // `prompt_received` / `commands.updated` / `stream_status` are
            // transient UI acks that are never persisted. `SenderClosed` here
            // means only the owner socket is gone — mirrored acks
            // (`prompt_received`, `stream_status`) already reached other viewers
            // before that send — so either outcome just continues the stream.
            ForwardOutcome::Forwarded | ForwardOutcome::SenderClosed => return,
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
            return;
        }

        if self.handle_non_result_signal(state, &runtime_event).await {
            return;
        }

        self.persist_and_forward_event(state, runtime_adapter, persistence, &runtime_event)
            .await;
    }

    async fn handle_permission_request(
        &self,
        runtime_adapter: Option<&'static dyn AgentRuntimeAdapter>,
        runtime_event: &RuntimeEvent,
    ) -> bool {
        let Some(request) = runtime_adapter
            .and_then(|adapter| adapter.parse_permission_request(runtime_event.raw_json()))
        else {
            return false;
        };
        let is_question = request.tool_name == "AskUserQuestion";
        let payload: PermissionRequestPayload = permission_request_payload(request);
        let question_payload = is_question.then(|| {
            serde_json::json!({
                "tool_name": payload.tool_name.clone(),
                "tool_input": payload.tool_input.clone(),
                "request_id": payload.request_id.clone(),
                "pattern": payload.pattern.clone(),
            })
        });
        self.persist_pending_user_input(&payload, question_payload.as_ref())
            .await;
        let envelope = WsEnvelope::new(
            "session",
            "permission.request",
            serde_json::to_value(&payload).unwrap(),
        );
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
        WsSessionPersistence::mark_awaiting_user_static(
            &self.write_pool,
            &self.session_status_tx,
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
            capture_runtime_session_id(runtime_event, &mut state.needs_session_id_capture)
        else {
            return;
        };
        state.runtime_session_id = Some(runtime_sid.clone());
        state.usage_state.set_root_session_id(&runtime_sid);
        info!(self.db_session_id, runtime_session_id = %runtime_sid, "stream_reader: persisting runtime session_id to DB");
        WsSessionPersistence::persist_runtime_session_id_static(
            &self.write_pool,
            self.db_session_id,
            &self.runtime_provider,
            &runtime_sid,
        )
        .await;
        send_runtime_session_id(&self.sender, &runtime_sid);
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

    /// Surface a non-fatal provider error (e.g. an API 5xx the CLI reports as a
    /// synthetic assistant message). Persist it as an `error` message so it
    /// shows on history reload, and emit a live `session.error` envelope so it
    /// appears immediately. Unlike [`Self::handle_stream_error`], this does NOT
    /// stop the reader: the provider's own `Result` still ends the turn and the
    /// subprocess stays alive for a retry. Returns `true` when handled.
    async fn handle_provider_error(&self, runtime_event: &RuntimeEvent) -> bool {
        let Some(error) = runtime_event.provider_error() else {
            return false;
        };
        let code = error.code.unwrap_or("API_ERROR");
        error!(self.db_session_id, code, "provider surfaced an API error");
        WsSessionPersistence::persist_error_message_static(
            &self.write_pool,
            self.db_session_id,
            error.message,
            error.parent_tool_use_id,
        )
        .await;
        let envelope = WsEnvelope::new(
            "session",
            "error",
            serde_json::to_value(SessionErrorPayload {
                code: code.to_string(),
                message: error.message.to_string(),
                ..Default::default()
            })
            .unwrap(),
        );
        let _ = self
            .send_and_mirror(Message::Text(String::from(envelope).into()))
            .await;
        true
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

        if state.compacting == next {
            return;
        }
        state.compacting = next;
        let envelope = WsEnvelope::new(
            "session",
            "compacting",
            serde_json::json!({ "active": next }),
        );
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
            state.between_turns = false;
        }
        if !state.between_turns {
            self.broadcast_runtime_signal(state, runtime_event).await;
        }
        runtime_event.is_turn_started_signal()
    }

    async fn broadcast_runtime_signal(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
    ) {
        let Some(signal) = crate::domain::session_status::provider_signal_for_event(runtime_event)
        else {
            return;
        };
        let next = signal.status();
        if state.last_signal_status == Some(next) {
            return;
        }
        if runtime_event.is_turn_started_signal() && next == AgentStatus::Agent {
            WsSessionPersistence::mark_running_static(&self.write_pool, self.db_session_id).await;
        }
        WsSessionPersistence::broadcast_session_signal(
            &self.session_status_tx,
            self.db_session_id,
            self.feature_id,
            signal,
        );
        state.last_signal_status = Some(next);
    }

    async fn persist_and_forward_event(
        &self,
        state: &mut StreamReaderState,
        runtime_adapter: Option<&'static dyn AgentRuntimeAdapter>,
        persistence: &mut WsSessionPersistence,
        runtime_event: &RuntimeEvent,
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

        let persisted_message = persistence.persist_runtime_event(runtime_event).await;
        // Only stream-event blocks carry a stamped model, so skip the lookup
        // entirely for other events on this per-delta hot path.
        let current_model = runtime_event
            .stream_event()
            .and_then(|_| persistence.current_model_for_event(runtime_event));
        if !usage_update.is_subagent {
            let _ = persist_usage(runtime_event, self.db_session_id, &self.write_pool).await;
        }
        if usage_update.changed
            && (usage_update.snapshot.input_tokens > 0 || usage_update.snapshot.output_tokens > 0)
        {
            self.send_usage_update(
                usage_update.snapshot.input_tokens,
                usage_update.snapshot.output_tokens,
                usage_update.snapshot.context_window,
            )
            .await;
        }

        let envelope = self
            .runtime_event_envelope(state, runtime_event, persisted_message, current_model)
            .await;
        // The event is already persisted and mirrored to any other connected
        // device, so a gone owner socket is fine — keep streaming. A `None`
        // envelope means the turn-complete signal was intentionally withheld
        // because a background agent is still alive (issue #58) — keep the turn
        // lifecycle in `active` so the header timer doesn't reset on resume.
        if let Some(envelope) = envelope {
            let _ = self
                .send_and_mirror(Message::Text(String::from(envelope).into()))
                .await;
        }
        if runtime_event.is_result() {
            let _ = self.refresh_mcp_servers_after_turn().await;
            self.drain_queued_message_after_result().await;
        }
    }

    async fn drain_queued_message_after_result(&self) {
        let has_pending_user_input =
            WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id)
                .await
                .is_some_and(|row| row.has_pending_user_input());
        if has_pending_user_input {
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

    async fn refresh_mcp_servers_after_turn(&self) -> Result<(), ()> {
        let result = refresh_mcp_servers_for_active_session(
            &self.sender,
            &self.sdk_sessions,
            self.db_session_id,
        )
        .await;
        if result.is_err() {
            debug!(
                self.db_session_id,
                "WebSocket sender closed during post-turn mcp_servers refresh"
            );
        }
        result
    }
}
