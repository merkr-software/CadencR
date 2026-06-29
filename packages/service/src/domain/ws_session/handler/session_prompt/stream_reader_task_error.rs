use tracing::{error, warn};

use crate::domain::agents::adapter::RuntimeEvent;

use super::stream_reader_task::StreamReaderTask;

/// Upper bound on how much of an unrecognized message's raw payload we inline
/// into the conversation. Unknown messages are normally tiny; this only guards
/// against a pathologically large one flooding the transcript.
const MAX_UNKNOWN_PAYLOAD_CHARS: usize = 2000;

/// Paths that surface a provider failure to the conversation as a visible
/// `session.error` (via the shared
/// [`persist_and_emit_error`](StreamReaderTask::persist_and_emit_error)) without
/// tearing down the reader — the agent never just "stops" with no trace.
impl StreamReaderTask {
    /// Surface a non-fatal provider error (e.g. an API 5xx the CLI reports as a
    /// synthetic assistant message). Persist it as an `error` message so it
    /// shows on history reload, and emit a live `session.error` envelope so it
    /// appears immediately. Unlike [`Self::handle_stream_error`], this does NOT
    /// stop the reader: the provider's own `Result` still ends the turn and the
    /// subprocess stays alive for a retry. Returns `true` when handled.
    pub(super) async fn handle_provider_error(&self, runtime_event: &RuntimeEvent) -> bool {
        let Some(error) = runtime_event.provider_error() else {
            return false;
        };
        let code = error.code.unwrap_or("API_ERROR");
        error!(self.db_session_id, code, "provider surfaced an API error");
        self.persist_and_emit_error(code, error.message.to_string(), error.parent_tool_use_id)
            .await;
        true
    }

    /// Surface a provider message the adapter could not recognize at all
    /// (Claude Code: a `type` the SDK has never seen). Without this it degrades
    /// to [`RuntimeEventKind::Other`](crate::domain::agents::adapter::RuntimeEventKind::Other)
    /// and is dropped — exactly the silent stop a user can't diagnose. We
    /// persist it as an `error` message and emit a live `session.error` so the
    /// raw payload always appears in the conversation. Like
    /// [`Self::handle_provider_error`], this does NOT stop the reader. Returns
    /// `true` when handled.
    pub(super) async fn handle_unknown_message(&self, runtime_event: &RuntimeEvent) -> bool {
        let Some(raw) = runtime_event.unknown_message() else {
            return false;
        };
        let message_type = raw
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        let payload = serde_json::to_string_pretty(raw).unwrap_or_else(|_| raw.to_string());
        let mut shown: String = payload.chars().take(MAX_UNKNOWN_PAYLOAD_CHARS).collect();
        if shown.len() < payload.len() {
            shown.push_str("\n… (truncated)");
        }
        let message = format!(
            "Claude Code sent a message Cadencr doesn't recognize yet (type: \"{message_type}\"). \
             Raw payload:\n{shown}"
        );
        warn!(
            self.db_session_id,
            message_type, "surfacing an unrecognized provider message to the conversation"
        );
        self.persist_and_emit_error("UNKNOWN_MESSAGE", message, None)
            .await;
        true
    }

    /// A turn-ending `Result` can itself report failure (Claude Code:
    /// `is_error: true`, e.g. a Bedrock `error_during_execution`). Surface that
    /// to the conversation so the turn doesn't look like a clean stop with no
    /// output — the exact silent failure of issue #78. Skipped when an error
    /// was already surfaced this turn (`already_surfaced`): the CLI can report
    /// an API failure *and* then end the turn with `is_error`, and one bubble is
    /// enough. Returns `true` when it surfaced an error so the caller can mark
    /// the turn. Unlike the handlers above the caller does NOT short-circuit on
    /// this — the result must still flow through the turn-complete path.
    pub(super) async fn surface_result_error(
        &self,
        already_surfaced: bool,
        runtime_event: &RuntimeEvent,
    ) -> bool {
        let Some(error) = runtime_event.result_error() else {
            return false;
        };
        if already_surfaced {
            return false;
        }
        error!(
            self.db_session_id,
            code = error.code,
            "turn ended with an error result"
        );
        self.persist_and_emit_error(&error.code, error.message.clone(), None)
            .await;
        true
    }
}
