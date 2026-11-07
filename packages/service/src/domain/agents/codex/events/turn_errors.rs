//! Codex `error` notifications (`{ error: TurnError, willRetry, threadId,
//! turnId }`).
//!
//! - `willRetry: true` is a stream error Codex retries on its own
//!   (reconnect/backoff). It becomes a degraded stream status that clears as
//!   soon as the same thread makes progress again.
//! - `willRetry: false` is the turn's terminal error. It is surfaced right
//!   away as a provider error; the `turn/completed` that follows carries the
//!   same `TurnError`, so the turn id is remembered and that second copy is
//!   not surfaced again.

use std::collections::HashSet;

use serde_json::{json, Value};

use super::super::event_json::{metadata, thread_id};
use crate::domain::agents::adapter::{RuntimeEvent, RuntimeEventKind, RuntimeStreamStatus};

pub(in crate::domain::agents::codex) const CODEX_TURN_FAILED: &str = "CODEX_TURN_FAILED";

#[derive(Default)]
pub(in crate::domain::agents::codex) struct TurnErrorState {
    /// Threads whose stream is currently being retried by Codex.
    retrying_threads: HashSet<String>,
    /// Turns whose terminal error was already surfaced from `error`.
    surfaced_turns: HashSet<String>,
}

impl TurnErrorState {
    pub(in crate::domain::agents::codex) fn was_surfaced(&self, turn_id: &str) -> bool {
        self.surfaced_turns.contains(turn_id)
    }

    pub(super) fn take_surfaced(&mut self, turn_id: &str) -> bool {
        self.surfaced_turns.remove(turn_id)
    }

    /// Root turn start: surfaced-turn bookkeeping is per turn. Retrying
    /// threads are kept so their degraded status is still cleared.
    pub(in crate::domain::agents::codex) fn reset_turns(&mut self) {
        self.surfaced_turns.clear();
    }

    /// Any non-`error` notification from a retrying thread (its
    /// `thread/closed` included) means it stopped retrying; clear the degraded
    /// status once no thread retries. The root `turn/completed` ends every
    /// retry: a thread that never reports again (an abandoned child, a process
    /// gone without its own `turn/completed`) must not keep the stream
    /// degraded forever.
    pub(super) fn recovered_event(
        &mut self,
        method: &str,
        thread: &str,
        is_root_thread: bool,
    ) -> Option<RuntimeEvent> {
        if self.retrying_threads.is_empty() || method == "error" {
            return None;
        }
        if method == "turn/completed" && is_root_thread {
            self.retrying_threads.clear();
        } else if !self.retrying_threads.remove(thread) {
            return None;
        }
        self.retrying_threads
            .is_empty()
            .then(|| RuntimeEvent::stream_status_event(RuntimeStreamStatus::Recovered))
    }
}

pub(super) fn error_notification_events(
    params: &Value,
    state: &mut TurnErrorState,
) -> Vec<RuntimeEvent> {
    let message = turn_error_message(&params["error"]);
    let thread = thread_id(params);
    if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
        tracing::info!(thread, %message, "Codex is retrying after a stream error");
        state.retrying_threads.insert(thread.to_string());
        return vec![RuntimeEvent::stream_status_event(
            RuntimeStreamStatus::Degraded {
                reason: format!("Codex is retrying: {message}"),
            },
        )];
    }
    if let Some(turn_id) = params.get("turnId").and_then(Value::as_str) {
        state.surfaced_turns.insert(turn_id.to_string());
    }
    vec![provider_error_event(thread, message, CODEX_TURN_FAILED)]
}

pub(in crate::domain::agents::codex) fn provider_error_event(
    thread: &str,
    message: String,
    code: &str,
) -> RuntimeEvent {
    RuntimeEvent::new(
        metadata(thread, json!({ "type": "error", "message": message })),
        RuntimeEventKind::ProviderError {
            message,
            code: Some(code.to_string()),
            parent_tool_use_id: None,
        },
    )
}

/// `TurnError.message`, followed by `additionalDetails` when Codex has any.
fn turn_error_message(error: &Value) -> String {
    let text = |key: &str| {
        error
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let message = text("message").unwrap_or("Codex reported an error without details");
    match text("additionalDetails") {
        Some(details) => format!("{message}\n\n{details}"),
        None => message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::super::event_state::IndexState;
    use super::super::notification_events;
    use crate::domain::agents::adapter::{RuntimeEvent, RuntimeStreamStatus};

    fn error(will_retry: bool, thread: &str, message: &str) -> serde_json::Value {
        json!({
            "threadId": thread,
            "turnId": format!("{thread}-turn"),
            "willRetry": will_retry,
            "error": { "message": message, "codexErrorInfo": null, "additionalDetails": null }
        })
    }

    fn degraded_reason(event: &RuntimeEvent) -> Option<&str> {
        match event.stream_status()? {
            RuntimeStreamStatus::Degraded { reason } => Some(reason),
            RuntimeStreamStatus::Recovered => None,
        }
    }

    fn is_recovered(event: &RuntimeEvent) -> bool {
        matches!(event.stream_status(), Some(RuntimeStreamStatus::Recovered))
    }

    #[test]
    fn retrying_error_degrades_stream_until_the_thread_progresses() {
        let mut indexes = IndexState::for_root_thread("root");
        let retry = error(true, "root", "Reconnecting... 2/5");
        let events = notification_events("error", retry, None, &mut indexes);

        assert_eq!(events.len(), 1);
        assert_eq!(
            degraded_reason(&events[0]),
            Some("Codex is retrying: Reconnecting... 2/5")
        );
        assert!(events[0].provider_error().is_none());

        let delta = json!({ "threadId": "root", "itemId": "msg", "delta": "hi" });
        let events = notification_events("item/agentMessage/delta", delta, None, &mut indexes);
        assert!(is_recovered(&events[0]));
        assert!(events.len() > 1, "the delta itself still streams");

        let delta = json!({ "threadId": "root", "itemId": "msg", "delta": "!" });
        let events = notification_events("item/agentMessage/delta", delta, None, &mut indexes);
        assert!(!events.iter().any(is_recovered), "recovered is sent once");
    }

    #[test]
    fn unrelated_thread_progress_does_not_clear_a_retry() {
        let mut indexes = IndexState::for_root_thread("root");
        notification_events("error", error(true, "root", "retry"), None, &mut indexes);

        let other = json!({ "threadId": "elsewhere", "turn": { "id": "t" } });
        let events = notification_events("turn/started", other, None, &mut indexes);

        assert!(!events.iter().any(is_recovered));
    }

    fn with_child() -> IndexState {
        let mut indexes = IndexState::for_root_thread("root");
        assert!(indexes.record_subagent_thread("child", "toolu_spawn"));
        indexes
    }

    fn root_turn_completed(indexes: &mut IndexState) -> Vec<RuntimeEvent> {
        let params = json!({ "threadId": "root", "turn": { "id": "rt", "status": "completed" } });
        notification_events("turn/completed", params, None, indexes)
    }

    #[test]
    fn root_turn_end_clears_a_child_that_never_reports_again() {
        let mut indexes = with_child();
        notification_events("error", error(true, "child", "retry"), None, &mut indexes);

        let events = root_turn_completed(&mut indexes);
        assert_eq!(events.iter().filter(|event| is_recovered(event)).count(), 1);

        let delta = json!({ "threadId": "child", "itemId": "msg", "delta": "late" });
        let events = notification_events("item/agentMessage/delta", delta, None, &mut indexes);
        assert!(
            !events.iter().any(is_recovered),
            "the retry was already cleared"
        );
    }

    #[test]
    fn root_turn_end_without_a_retry_reports_no_recovery() {
        let mut indexes = with_child();
        assert!(!root_turn_completed(&mut indexes).iter().any(is_recovered));
    }

    #[test]
    fn child_turn_end_clears_only_that_child() {
        let mut indexes = with_child();
        assert!(indexes.record_subagent_thread("other", "toolu_other"));
        notification_events("error", error(true, "child", "retry"), None, &mut indexes);
        notification_events("error", error(true, "other", "retry"), None, &mut indexes);

        let params = json!({ "threadId": "child", "turn": { "id": "ct", "status": "completed" } });
        let events = notification_events("turn/completed", params, None, &mut indexes);
        assert!(!events.iter().any(is_recovered), "`other` still retries");

        let events = notification_events(
            "thread/closed",
            json!({ "threadId": "other" }),
            None,
            &mut indexes,
        );
        assert!(
            events.iter().any(is_recovered),
            "closing the last retrying thread"
        );
    }

    #[test]
    fn terminal_error_surfaces_details_and_is_remembered_for_its_turn() {
        let mut indexes = IndexState::for_root_thread("root");
        let params = json!({
            "threadId": "root",
            "turnId": "turn-1",
            "willRetry": false,
            "error": {
                "message": "Usage limit reached",
                "codexErrorInfo": "usageLimitExceeded",
                "additionalDetails": "Try again at 5pm."
            }
        });
        let events = notification_events("error", params, None, &mut indexes);

        let error = events[0].provider_error().expect("visible provider error");
        assert_eq!(error.message, "Usage limit reached\n\nTry again at 5pm.");
        assert_eq!(error.code, Some("CODEX_TURN_FAILED"));
        assert!(indexes.turn_errors.was_surfaced("turn-1"));
    }

    #[test]
    fn terminal_error_without_message_still_surfaces() {
        let mut indexes = IndexState::for_root_thread("root");
        let params = json!({ "threadId": "root", "turnId": "t", "willRetry": false, "error": {} });
        let events = notification_events("error", params, None, &mut indexes);

        assert_eq!(
            events[0].provider_error().unwrap().message,
            "Codex reported an error without details"
        );
    }
}
