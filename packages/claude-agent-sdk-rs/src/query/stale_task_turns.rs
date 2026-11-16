//! The empty turn Claude Code runs for a background task it lost.
//!
//! A CLI resumed after its previous process died (`kill -9`, a crash, an
//! escalated Stop) first reports each background task that process never saw
//! finish: a `task_notification` (`stopped`, "didn't finish before the
//! previous session ended") for a task this process never started. It closes
//! that notification's own turn with a `result` of zero turns and no API
//! time, and only then takes the prompt it was resumed for. Forwarded, that
//! `result` ended the user's turn before Claude answered: the conversation
//! went idle with no reply, and a client that stopped listening there lost
//! the answer, and the turn state said "complete" for the whole real turn
//! (an interrupt then neither waited for it nor timed out). Such a result is
//! dropped before it reaches either. Anything else between the notification
//! and the result (a prompt echo, a model response) makes it a real turn,
//! and a failed result always ends one.

use std::collections::HashSet;

use crate::messages::{SdkMessage, TaskLifecycleKind};

#[derive(Default)]
pub(super) struct StaleTaskTurns {
    /// Tasks this process started; a notification for any other is stale.
    started: HashSet<String>,
    /// Empty turns stale notifications opened that nothing has happened in
    /// yet: one per notification.
    empty_turns_open: usize,
}

impl StaleTaskTurns {
    /// Whether `msg` only closes the empty turn of a stale task notification.
    pub(super) fn closes_empty_turn(&mut self, msg: &SdkMessage) -> bool {
        match msg {
            SdkMessage::TaskLifecycle(event) => {
                let Some(task_id) = event.task_id() else {
                    return false;
                };
                match event.kind() {
                    TaskLifecycleKind::Started => {
                        self.started.insert(task_id.to_string());
                    }
                    TaskLifecycleKind::Notification if !self.started.contains(task_id) => {
                        self.empty_turns_open += 1;
                    }
                    _ => {}
                }
                false
            }
            SdkMessage::Assistant { .. }
            | SdkMessage::StreamEvent { .. }
            | SdkMessage::User { .. } => {
                self.empty_turns_open = 0;
                false
            }
            SdkMessage::Result {
                subtype,
                is_error,
                num_turns,
                duration_api_ms,
                ..
            } => {
                let empty =
                    subtype == "success" && !*is_error && *num_turns == 0 && *duration_api_ms == 0;
                if self.empty_turns_open == 0 || !empty {
                    self.empty_turns_open = 0;
                    return false;
                }
                self.empty_turns_open -= 1;
                true
            }
            // A result that failed to decode still ends a turn.
            SdkMessage::Malformed(malformed) if malformed.is_result() => {
                self.empty_turns_open = 0;
                false
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn message(value: Value) -> SdkMessage {
        SdkMessage::from_raw(value)
    }

    fn notification(task_id: &str) -> SdkMessage {
        message(json!({
            "type": "system", "subtype": "task_notification", "uuid": "u", "session_id": "s",
            "task_id": task_id, "tool_use_id": "toolu_1", "status": "stopped",
            "output_file": "",
            "summary": "Background shell command didn't finish before the previous session ended"
        }))
    }

    fn started(task_id: &str) -> SdkMessage {
        message(json!({
            "type": "system", "subtype": "task_started", "uuid": "u", "session_id": "s",
            "task_id": task_id, "tool_use_id": "toolu_1", "task_type": "local_bash",
            "is_backgrounded": true
        }))
    }

    fn init() -> SdkMessage {
        message(json!({
            "type": "system", "subtype": "init", "uuid": "u", "session_id": "s",
            "cwd": "/tmp", "tools": [], "mcp_servers": [], "model": "haiku",
            "permission_mode": "default", "slash_commands": []
        }))
    }

    fn result(num_turns: u64, duration_api_ms: u64) -> SdkMessage {
        message(json!({
            "type": "result", "subtype": "success", "uuid": "u", "session_id": "s",
            "duration_ms": 10, "duration_api_ms": duration_api_ms, "is_error": false,
            "num_turns": num_turns, "result": "", "stop_reason": null, "total_cost_usd": 0.0,
            "usage": { "input_tokens": 0, "output_tokens": 0 }, "permission_denials": []
        }))
    }

    fn user_echo() -> SdkMessage {
        message(json!({
            "type": "user", "uuid": "u", "session_id": "s", "parent_tool_use_id": null,
            "message": { "role": "user", "content": "Which number?" }
        }))
    }

    fn assistant() -> SdkMessage {
        message(json!({
            "type": "assistant", "uuid": "u", "session_id": "s", "parent_tool_use_id": null,
            "message": { "id": "m", "role": "assistant", "model": "haiku",
                         "content": [{ "type": "text", "text": "99" }] }
        }))
    }

    /// The frames a CLI resumed after `kill -9` emitted live (2.1.312): the
    /// stale notification's zero-turn result, then the prompt's real turn.
    #[test]
    fn a_resumed_cli_s_stale_notification_turn_is_dropped_and_the_prompt_s_turn_kept() {
        let mut turns = StaleTaskTurns::default();
        let frames = [
            notification("bul7dea5x"),
            init(),
            result(0, 0),
            init(),
            user_echo(),
            assistant(),
            result(1, 2091),
        ];
        let dropped: Vec<bool> = frames
            .iter()
            .map(|frame| turns.closes_empty_turn(frame))
            .collect();
        assert_eq!(dropped, [false, false, true, false, false, false, false]);
    }

    #[test]
    fn a_task_this_process_started_ends_in_a_real_turn() {
        let mut turns = StaleTaskTurns::default();
        assert!(!turns.closes_empty_turn(&started("b1")));
        assert!(!turns.closes_empty_turn(&notification("b1")));
        assert!(!turns.closes_empty_turn(&result(0, 0)));
    }

    #[test]
    fn work_after_the_notification_makes_the_turn_real() {
        for activity in [user_echo(), assistant()] {
            let mut turns = StaleTaskTurns::default();
            turns.closes_empty_turn(&notification("gone"));
            turns.closes_empty_turn(&activity);
            assert!(!turns.closes_empty_turn(&result(0, 0)));
        }
    }

    #[test]
    fn only_a_turn_with_no_model_call_is_empty() {
        let mut turns = StaleTaskTurns::default();
        turns.closes_empty_turn(&notification("gone"));
        assert!(!turns.closes_empty_turn(&result(1, 800)));
        // Each notification opens at most one empty turn.
        assert!(!turns.closes_empty_turn(&result(0, 0)));
    }

    #[test]
    fn a_failed_result_always_ends_its_turn() {
        let mut turns = StaleTaskTurns::default();
        turns.closes_empty_turn(&notification("gone"));
        let failed = message(json!({
            "type": "result", "subtype": "error_during_execution", "uuid": "u",
            "session_id": "s", "duration_ms": 10, "duration_api_ms": 0, "is_error": true,
            "num_turns": 0, "result": "", "stop_reason": null, "total_cost_usd": 0.0,
            "usage": { "input_tokens": 0, "output_tokens": 0 }, "permission_denials": []
        }));
        assert!(!turns.closes_empty_turn(&failed));
    }

    #[test]
    fn each_lost_task_s_empty_turn_is_dropped() {
        let mut turns = StaleTaskTurns::default();
        for frame in [notification("a"), notification("b"), init()] {
            assert!(!turns.closes_empty_turn(&frame));
        }
        assert!(turns.closes_empty_turn(&result(0, 0)));
        assert!(!turns.closes_empty_turn(&init()));
        assert!(turns.closes_empty_turn(&result(0, 0)));
        assert!(
            !turns.closes_empty_turn(&result(0, 0)),
            "two notifications, two turns"
        );
    }

    #[test]
    fn a_malformed_result_ends_the_empty_turn() {
        let mut turns = StaleTaskTurns::default();
        turns.closes_empty_turn(&notification("gone"));
        // No subtype: the result fails to decode.
        let malformed = message(json!({ "type": "result", "session_id": "s", "is_error": false }));
        assert!(
            matches!(&malformed, SdkMessage::Malformed(m) if m.is_result()),
            "{malformed:?}"
        );
        assert!(!turns.closes_empty_turn(&malformed));
        assert!(!turns.closes_empty_turn(&result(0, 0)));
    }
}
