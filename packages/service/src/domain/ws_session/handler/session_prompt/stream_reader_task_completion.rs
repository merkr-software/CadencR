use std::path::PathBuf;

use anyhow::Result;
use axum::extract::ws::Message;
use tracing::{error, info};

use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent};
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::persistence::{
    raw_event_with_agent_message_id, PersistedMessageRef, WsSessionPersistence,
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
        let usage_env = WsEnvelope::new(
            "session",
            "usage_update",
            serde_json::to_value(SessionUsageUpdatePayload {
                input_tokens,
                output_tokens,
                context_window,
            })
            .unwrap(),
        );
        let _ = self
            .send_and_mirror(Message::Text(String::from(usage_env).into()))
            .await;
    }

    pub(super) async fn runtime_event_envelope(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
        persisted_message: Option<PersistedMessageRef>,
        current_model: Option<&str>,
    ) -> Option<WsEnvelope> {
        if runtime_event.is_result() {
            return self.result_envelope(state).await;
        }
        let mut block =
            raw_event_with_agent_message_id(runtime_event.raw_json(), persisted_message);
        // Stamp the active model onto the live block (`current_model` is set only
        // for stream events). The block created on `content_block_start` would
        // otherwise rely on the client having applied `message_start` first —
        // unreliable for a remote device that joined the turn late, which then
        // renders the model as "unknown".
        if let (Some(model), serde_json::Value::Object(object)) = (current_model, &mut block) {
            object.insert(
                "model".to_string(),
                serde_json::Value::String(model.to_string()),
            );
        }
        state.message_seq += 1;
        Some(WsEnvelope::new(
            "session",
            "message",
            serde_json::to_value(SessionMessagePayload {
                blocks: vec![block],
                seq: Some(state.message_seq),
            })
            .unwrap(),
        ))
    }

    async fn result_envelope(&self, state: &mut StreamReaderState) -> Option<WsEnvelope> {
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
        if !state.live_background_agents.is_empty() {
            WsSessionPersistence::mark_running_static(&self.write_pool, self.db_session_id).await;
            return None;
        }

        WsSessionPersistence::mark_completed_static(&self.write_pool, self.db_session_id).await;
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
            state.turn_state.record_signal_status(AgentStatus::Idle);
        }
        Some(WsEnvelope::new(
            "session",
            "ended",
            serde_json::to_value(SessionEndedPayload {
                reason: "turn_complete".into(),
            })
            .unwrap(),
        ))
    }

    pub(super) async fn handle_stream_error(&self, state: &StreamReaderState, error: RuntimeError) {
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
        self.surface_session_error(code, message).await;
    }

    /// Persist an error message, pause the session, announce idle, and emit a
    /// live `session.error` — the one proven path the frontend already renders.
    /// Shared by [`Self::handle_stream_error`] and the mid-turn stream-close
    /// path so a surfaced error always looks the same to the client.
    async fn surface_session_error(&self, code: &str, message: String) {
        WsSessionPersistence::mark_paused_static(&self.write_pool, self.db_session_id).await;
        WsSessionPersistence::broadcast_session_status(
            &self.session_status_tx,
            self.db_session_id,
            self.feature_id,
            AgentStatus::Idle,
            None,
        );
        self.persist_and_emit_error(code, message.clone(), None)
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
        WsSessionPersistence::persist_error_message_static(
            &self.write_pool,
            self.db_session_id,
            &message,
            parent_tool_use_id,
        )
        .await;
        let err_env = WsEnvelope::new(
            "session",
            "error",
            serde_json::to_value(SessionErrorPayload {
                code: code.into(),
                message,
                ..Default::default()
            })
            .unwrap(),
        );
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
    pub(super) async fn handle_unexpected_stop(&self, state: &StreamReaderState) {
        error!(
            self.db_session_id,
            "SDK stream closed mid-turn without a result"
        );
        let mut message = "The agent stopped unexpectedly before finishing its turn.".to_string();
        let dump = state
            .diagnostics
            .dump(self.db_session_id, "AGENT_STOPPED", None);
        append_diagnostics_note(&mut message, self.db_session_id, dump);
        self.surface_session_error("AGENT_STOPPED", message).await;
    }

    pub(super) async fn send_stream_closed(&self) {
        info!(self.db_session_id, "SDK stream closed");
        let end_env = WsEnvelope::new(
            "session",
            "ended",
            serde_json::to_value(SessionEndedPayload {
                reason: "stream_closed".into(),
            })
            .unwrap(),
        );
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
