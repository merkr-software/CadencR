use crate::domain::ws_session::protocol::WsSessionEvent;
use std::path::PathBuf;

use anyhow::Result;
use axum::extract::ws::Message;
use tracing::{error, info};

use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent};
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::persistence::{
    raw_event_with_agent_message_id, PersistedEventRef, WsSessionPersistence,
};
use crate::domain::ws_session::protocol::{
    SessionEndedPayload, SessionErrorPayload, SessionMessagePayload, SessionUsageUpdatePayload,
    WsEnvelope,
};

use super::stream_reader_task::{StreamReaderState, StreamReaderTask};

impl StreamReaderTask {
    pub(super) async fn send_usage_update(
        &self,
        input_tokens: u64,
        output_tokens: u64,
        context_window: Option<u64>,
    ) {
        let usage_env =
            WsEnvelope::session_event(&WsSessionEvent::UsageUpdate(SessionUsageUpdatePayload {
                input_tokens,
                output_tokens,
                context_window,
            }))
            .expect("session event payload should serialize");
        let _ = self
            .send_and_mirror(Message::Text(String::from(usage_env).into()))
            .await;
    }

    pub(super) async fn runtime_event_envelope(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
        persisted_message: Option<PersistedEventRef>,
        current_model: Option<&str>,
        interrupted_generation: Option<u64>,
    ) -> Option<WsEnvelope> {
        if runtime_event.is_result() {
            let failed = runtime_event.result_error().is_some();
            return self
                .result_envelope(state, interrupted_generation, failed)
                .await;
        }
        // Phase 3 migration seam: v1 index-based events are assigned stable
        // canonical ids and materialized before the legacy desktop projection.
        // Keeping this immediately consumed prevents an unwired shadow model.
        state
            .canonical_projection
            .apply_runtime_event(runtime_event);
        // Init and Other are operational signals, not transcript blocks. Their
        // meaningful state has already been consumed by the stream reader
        // (runtime id, MCP servers, usage, permissions, and provider-specific
        // observers), so forwarding their provider-native raw JSON only makes
        // the desktop parser warn about an unknown message type.
        if runtime_event.is_operational_only() {
            return None;
        }
        let projected_model = state
            .canonical_projection
            .model_for_event(runtime_event)
            .or(current_model);
        let mut block =
            raw_event_with_agent_message_id(runtime_event.raw_json(), persisted_message);
        // Stamp the active model onto the live block (`current_model` is set only
        // for stream events). The block created on `content_block_start` would
        // otherwise rely on the client having applied `message_start` first —
        // unreliable for a remote device that joined the turn late, which then
        // renders the model as "unknown".
        if let (Some(model), serde_json::Value::Object(object)) = (projected_model, &mut block) {
            object.insert(
                "model".to_string(),
                serde_json::Value::String(model.to_string()),
            );
        }
        state.message_seq += 1;
        Some(
            WsEnvelope::session_event(&WsSessionEvent::Message(SessionMessagePayload {
                blocks: vec![block],
                seq: Some(state.message_seq),
            }))
            .expect("session event payload should serialize"),
        )
    }

    async fn result_envelope(
        &self,
        state: &mut StreamReaderState,
        interrupted_generation: Option<u64>,
        failed: bool,
    ) -> Option<WsEnvelope> {
        state.canonical_projection.finish_turn();
        state.turn_state.mark_result();

        // Issue #58: a `run_in_background` Agent/Task can still be alive after
        // this turn's `Result` (it launches, the turn ends, then the CLI
        // auto-resumes the main agent once the background agent finishes). While
        // one is live the session is NOT idle: keep it `running` so the header
        // shows the working spinner, the reconnect snapshot derives Agent (the
        // DB stays `running`), and deferred teardown's `turn_running` guard
        // won't kill the detached agent.
        //
        // Returning `None` here suppresses the turn-complete envelope, which is
        // what keeps the header's "Working - Xs" timer ticking: that envelope is
        // the only signal that flips the frontend turn lifecycle to `terminal`,
        // and the CLI's auto-resume would otherwise start a brand-new turn,
        // resetting elapsed time to 0s. The resume turn's final `Result` arrives
        // with the set empty and ends the turn normally below.
        if interrupted_generation.is_none() && !state.live_background_agents.is_empty() {
            WsSessionPersistence::mark_running_static(&self.write_pool, self.db_session_id).await;
            return None;
        }
        if let Some(generation) = interrupted_generation {
            return self.interrupted_result_envelope(state, generation).await;
        }

        WsSessionPersistence::mark_completed_static(&self.write_pool, self.db_session_id).await;
        if let Err(error) = crate::domain::sessions::user_messages::resolve_pending_delivery_states(
            &self.write_pool,
            self.db_session_id,
            "delivery_unknown",
        )
        .await
        {
            error!(self.db_session_id, error = %error, "failed to resolve pending prompt receipts at turn end");
        }
        let has_pending_user_input =
            WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id)
                .await
                .is_some_and(|row| row.has_pending_user_input());
        if !has_pending_user_input {
            // A result reporting failure ends the turn as failed. A surfaced
            // error alone does not: an unrecognized message or a retried
            // provider error still lets the turn complete.
            let status_tx = &self.session_status_tx;
            if failed {
                status_tx.broadcast_turn_failed(self.db_session_id, self.feature_id);
            } else {
                status_tx.broadcast(self.db_session_id, self.feature_id, AgentStatus::Idle, None);
            }
        }
        Some(
            WsEnvelope::session_event(&WsSessionEvent::Ended(SessionEndedPayload {
                reason: "turn_complete".into(),
                received_prompt_message_uuids: std::mem::take(
                    &mut state.received_prompt_message_uuids,
                ),
            }))
            .expect("session event payload should serialize"),
        )
    }

    async fn interrupted_result_envelope(
        &self,
        state: &mut StreamReaderState,
        interrupted_generation: u64,
    ) -> Option<WsEnvelope> {
        if !self
            .app_state
            .active_turns
            .is_current_generation(self.db_session_id, interrupted_generation)
            .await
        {
            info!(
                self.db_session_id,
                interrupted_generation,
                "superseded interrupted turn ended without changing the current turn"
            );
            return None;
        }
        WsSessionPersistence::mark_completed_static(&self.write_pool, self.db_session_id).await;
        // Both ways a stopped turn ends (its runtime's interrupted result, or
        // the runtime closing mid-interrupt) pass here exactly once.
        WsSessionPersistence::persist_turn_interrupted_static(&self.write_pool, self.db_session_id)
            .await;
        let has_pending_user_input =
            WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id)
                .await
                .is_some_and(|row| row.has_pending_user_input());
        if !has_pending_user_input {
            WsSessionPersistence::broadcast_session_status(
                &self.session_status_tx,
                self.db_session_id,
                self.feature_id,
                AgentStatus::Idle,
                None,
            );
        }
        Some(
            WsEnvelope::session_event(&WsSessionEvent::Ended(SessionEndedPayload {
                reason: "turn_interrupted".into(),
                received_prompt_message_uuids: std::mem::take(
                    &mut state.received_prompt_message_uuids,
                ),
            }))
            .expect("session event payload should serialize"),
        )
    }

    pub(super) async fn handle_stream_error(
        &self,
        state: &mut StreamReaderState,
        error: RuntimeError,
    ) {
        let code = match &error {
            RuntimeError::CompactFailed(_) => "COMPACT_ERROR",
            _ => "SDK_ERROR",
        };
        let mut message = error.to_string();
        error!(self.db_session_id, error = %message, "SDK stream error");
        let dump = state
            .diagnostics
            .dump(self.db_session_id, code, Some(&message));
        append_diagnostics_note(&mut message, self.db_session_id, dump);
        let receipts = std::mem::take(&mut state.received_prompt_message_uuids);
        self.surface_session_error(code, message, receipts).await;
    }

    /// Persist an error message, pause the session, announce idle, and emit a
    /// live `session.error` — the one proven path the frontend already renders.
    /// Shared by [`Self::handle_stream_error`] and the mid-turn stream-close
    /// path so a surfaced error always looks the same to the client.
    async fn surface_session_error(
        &self,
        code: &str,
        message: String,
        received_prompt_message_uuids: Vec<String>,
    ) {
        self.fail_receipts_and_pause("after stream error").await;
        self.session_status_tx
            .broadcast_turn_failed(self.db_session_id, self.feature_id);
        self.persist_and_emit_error_with_receipts(
            code,
            message.clone(),
            None,
            received_prompt_message_uuids,
        )
        .await;
        if let Err(error) = crate::domain::mcp::control::reply_wait::deliver_failed(
            &self.app_state,
            self.db_session_id,
            &message,
        )
        .await
        {
            error!(self.db_session_id, error = %error, "failed to deliver MCP failure reply");
        }
    }

    /// Persist an `error` message and emit a live, mirrored `session.error` —
    /// the one path the frontend already renders. Does NOT change session
    /// status; callers that must pause the session (e.g.
    /// [`Self::surface_session_error`]) do so themselves first. Shared with the
    /// keep-the-turn-alive provider-error / unrecognized-message paths in
    /// `stream_reader_task_event`.
    pub(super) async fn persist_and_emit_error(
        &self,
        code: &str,
        message: String,
        parent_tool_use_id: Option<&str>,
    ) {
        self.persist_and_emit_error_with_receipts(code, message, parent_tool_use_id, Vec::new())
            .await;
    }

    async fn persist_and_emit_error_with_receipts(
        &self,
        code: &str,
        message: String,
        parent_tool_use_id: Option<&str>,
        received_prompt_message_uuids: Vec<String>,
    ) {
        WsSessionPersistence::persist_error_message_static(
            &self.write_pool,
            self.db_session_id,
            &message,
            parent_tool_use_id,
        )
        .await;
        let err_env = WsEnvelope::session_event(&WsSessionEvent::Error(SessionErrorPayload {
            code: code.into(),
            message,
            received_prompt_message_uuids,
            ..Default::default()
        }))
        .expect("session event payload should serialize");
        let _ = self
            .send_and_mirror(Message::Text(String::from(err_env).into()))
            .await;
    }

    /// The SDK stream closed cleanly (no error) while a turn was still in
    /// progress — i.e. the `claude` process went away before emitting its
    /// `Result`. The SDK already surfaces a non-zero/`stderr` exit as an error
    /// (handled via [`Self::handle_stream_error`]); this covers the genuinely
    /// silent case (clean code-0 exit, empty stderr) so the user sees an error
    /// instead of an agent that simply froze.
    pub(super) async fn handle_unexpected_stop(&self, state: &mut StreamReaderState) {
        error!(
            self.db_session_id,
            "SDK stream closed mid-turn without a result"
        );
        let mut message = "The agent stopped unexpectedly before finishing its turn.".to_string();
        let dump = state
            .diagnostics
            .dump(self.db_session_id, "AGENT_STOPPED", None);
        append_diagnostics_note(&mut message, self.db_session_id, dump);
        let receipts = std::mem::take(&mut state.received_prompt_message_uuids);
        self.surface_session_error("AGENT_STOPPED", message, receipts)
            .await;
    }

    /// End an intentionally interrupted turn without an error bubble,
    /// diagnostics dump, or failed parent reply. If a newer prompt has already
    /// started, its generation remains running; otherwise the stopped child
    /// becomes idle and can be resumed by the next message.
    pub(super) async fn handle_interrupted_end(
        &self,
        state: &mut StreamReaderState,
        interrupted_generation: u64,
    ) {
        info!(
            self.db_session_id,
            interrupted_generation, "agent turn stopped intentionally"
        );
        if let Some(end_env) = self
            .interrupted_result_envelope(state, interrupted_generation)
            .await
        {
            let _ = self
                .send_and_mirror(Message::Text(String::from(end_env).into()))
                .await;
        }
    }

    pub(super) async fn send_stream_closed(&self, state: &mut StreamReaderState) {
        info!(self.db_session_id, "SDK stream closed");
        let end_env = WsEnvelope::session_event(&WsSessionEvent::Ended(SessionEndedPayload {
            reason: "stream_closed".into(),
            received_prompt_message_uuids: std::mem::take(&mut state.received_prompt_message_uuids),
        }))
        .expect("session event payload should serialize");
        let _ = self
            .send_and_mirror(Message::Text(String::from(end_env).into()))
            .await;
    }
}

/// Append a pointer to the saved diagnostics dump — or a note that saving it
/// failed — to a session error `message`. A failed dump must never hide the
/// underlying agent error, but it is still surfaced (never swallowed).
fn append_diagnostics_note(message: &mut String, db_session_id: i64, dump: Result<PathBuf>) {
    match dump {
        Ok(path) => message.push_str(&format!("\n\nDiagnostics saved to: {}", path.display())),
        Err(err) => {
            error!(db_session_id, error = %err, "failed to save diagnostics dump");
            message.push_str("\n\n(Failed to save stream diagnostics to disk.)");
        }
    }
}
