//! Sub-agent facts read off an OpenCode child session's message snapshot.
//!
//! The polling listener already fetches every child's cumulative messages to
//! stream its content; the same snapshot says which model and reasoning
//! variant the child runs on, how many tokens and tool calls it has used and,
//! once its last assistant message stops, how it ended. A foreground child's
//! end is settled by its parent's `task` tool update, so only a background
//! child (whose tool call returned at launch) gets its status from here.

use std::time::{Duration, Instant};

use opencode_sdk_rs::{Message, MessagePart, MessageRole, TokenUsage};
use serde_json::Value;

use crate::domain::agents::adapter::{
    stop_reason, summarize_subagent_result, RuntimeSubagentPatch, RuntimeSubagentStatus,
};

/// Running children report at most once a second; a finished one at once.
const MIN_REPORT_INTERVAL: Duration = Duration::from_secs(1);

/// OpenCode's `MessageV2.AbortedError` name: the user aborted the child.
const ABORTED_ERROR: &str = "MessageAbortedError";

#[derive(Debug, Clone, PartialEq)]
pub(super) enum ChildEnd {
    Completed,
    Failed(String),
    Aborted,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct ChildSnapshot {
    model: Option<String>,
    reasoning_effort: Option<String>,
    total_tokens: Option<u64>,
    tool_use_count: Option<u64>,
    end: Option<ChildEnd>,
    duration_ms: Option<u64>,
    last_text: Option<String>,
}

impl ChildSnapshot {
    pub(super) fn read(messages: &[Message]) -> Self {
        let assistants: Vec<&Message> = messages
            .iter()
            .filter(|message| matches!(message.role, MessageRole::Assistant))
            .collect();
        let latest = |field: fn(&Message) -> Option<String>| {
            assistants.iter().rev().find_map(|message| field(message))
        };
        let tool_uses = assistants
            .iter()
            .flat_map(|message| &message.parts)
            .filter(|part| matches!(part, MessagePart::ToolUse { .. }))
            .count();
        let last = messages
            .last()
            .filter(|message| matches!(message.role, MessageRole::Assistant));
        let end = last.and_then(child_end);
        Self {
            model: latest(|message| message.model.clone()),
            reasoning_effort: latest(|message| message.variant.clone()),
            total_tokens: assistants
                .iter()
                .rev()
                .find_map(|message| message.tokens.as_ref())
                .map(total_tokens),
            tool_use_count: u64::try_from(tool_uses).ok().filter(|count| *count > 0),
            duration_ms: end
                .as_ref()
                .and(last)
                .and_then(|last| elapsed_ms(messages.first()?, last)),
            // Only a completed child's report is read, once it has ended.
            last_text: last
                .filter(|_| matches!(end, Some(ChildEnd::Completed)))
                .and_then(last_text),
            end,
        }
    }

    pub(super) fn is_finished(&self) -> bool {
        self.end.is_some()
    }

    /// Facts for the child's carrier. Only a background child's end becomes
    /// its status: a foreground one is settled by the parent's tool update.
    pub(super) fn patch(&self, child_session_id: &str, background: bool) -> RuntimeSubagentPatch {
        let mut patch = RuntimeSubagentPatch {
            child_session_id: Some(child_session_id.to_string()),
            model_resolved: self.model.is_some(),
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            total_tokens: self.total_tokens,
            tool_use_count: self.tool_use_count,
            duration_ms: self.duration_ms,
            ..RuntimeSubagentPatch::default()
        };
        match (&self.end, background) {
            (Some(ChildEnd::Completed), true) => {
                patch.status = Some(RuntimeSubagentStatus::Completed);
                patch.result_summary = self
                    .last_text
                    .as_deref()
                    .and_then(summarize_subagent_result);
            }
            (Some(ChildEnd::Failed(reason)), true) => {
                patch.status = Some(RuntimeSubagentStatus::Failed);
                patch.status_reason = summarize_subagent_result(reason);
            }
            (Some(ChildEnd::Aborted), true) => {
                patch.status = Some(RuntimeSubagentStatus::Stopped);
                patch.status_reason = Some(stop_reason::INTERRUPTED.to_string());
            }
            _ => {}
        }
        patch
    }
}

/// Throttles one child's reports and drops repeats.
#[derive(Debug, Default)]
pub(super) struct ChildReporter {
    sent: Option<RuntimeSubagentPatch>,
    sent_at: Option<Instant>,
}

impl ChildReporter {
    pub(super) fn next(
        &mut self,
        patch: RuntimeSubagentPatch,
        finished: bool,
        now: Instant,
    ) -> Option<RuntimeSubagentPatch> {
        if self.sent.as_ref() == Some(&patch) {
            return None;
        }
        let recent = self
            .sent_at
            .is_some_and(|at| now.duration_since(at) < MIN_REPORT_INTERVAL);
        if recent && !finished {
            return None;
        }
        self.sent = Some(patch.clone());
        self.sent_at = Some(now);
        Some(patch)
    }
}

/// How the child's last assistant message ended, if it ended the run.
/// OpenCode keeps prompting while a step finishes on `tool-calls` (or
/// `unknown`); `task.ts` also fails a task whose final message holds a
/// failed tool call.
fn child_end(message: &Message) -> Option<ChildEnd> {
    if message.error_name.as_deref() == Some(ABORTED_ERROR) {
        return Some(ChildEnd::Aborted);
    }
    if let Some(error) = &message.error {
        return Some(ChildEnd::Failed(error.clone()));
    }
    match message.finish.as_deref() {
        None | Some("tool-calls" | "unknown") => None,
        Some(_) => Some(failed_tool(message).map_or(ChildEnd::Completed, ChildEnd::Failed)),
    }
}

fn failed_tool(message: &Message) -> Option<String> {
    message.parts.iter().rev().find_map(|part| match part {
        MessagePart::ToolUse { name, input, .. }
            if input.get("status").and_then(Value::as_str) == Some("error") =>
        {
            Some(format!("{name} failed"))
        }
        _ => None,
    })
}

fn last_text(message: &Message) -> Option<String> {
    message.parts.iter().rev().find_map(|part| match part {
        MessagePart::Text { text, .. } if !text.trim().is_empty() => Some(text.clone()),
        _ => None,
    })
}

fn total_tokens(tokens: &TokenUsage) -> u64 {
    tokens
        .total
        .unwrap_or_else(|| tokens.total_input() + tokens.output + tokens.reasoning)
}

fn elapsed_ms(first: &Message, last: &Message) -> Option<u64> {
    let started: u64 = first.created_at.as_deref()?.parse().ok()?;
    let ended: u64 = last.completed_at.as_deref()?.parse().ok()?;
    ended.checked_sub(started)
}

#[cfg(test)]
mod tests {
    use super::{ChildReporter, ChildSnapshot};
    use crate::domain::agents::adapter::RuntimeSubagentStatus;
    use opencode_sdk_rs::parse_message_from;
    use serde_json::{json, Value};
    use std::time::{Duration, Instant};

    /// `GET /session/{child}/message` entries (opencode 1.19 `MessageV2.WithParts`).
    fn message(value: Value) -> opencode_sdk_rs::Message {
        parse_message_from(&value).expect("message")
    }

    fn prompt() -> opencode_sdk_rs::Message {
        message(json!({
            "info": { "id": "msg_1", "sessionID": "ses_child", "role": "user", "time": { "created": 1000 } },
            "parts": [{ "id": "prt_1", "type": "text", "text": "Audit auth" }]
        }))
    }

    fn step(finish: Option<&str>, completed: Option<u64>) -> opencode_sdk_rs::Message {
        message(json!({
            "info": {
                "id": "msg_2", "sessionID": "ses_child", "role": "assistant",
                "providerID": "anthropic", "modelID": "claude-haiku-5-5", "variant": "high",
                "finish": finish,
                "tokens": { "input": 900, "output": 80, "reasoning": 20, "cache": { "read": 1000, "write": 0 } },
                "time": { "created": 1500, "completed": completed }
            },
            "parts": [
                { "id": "prt_2", "type": "tool", "tool": "read", "callID": "c1",
                  "state": { "status": "completed", "input": { "filePath": "a.rs" }, "output": "…" } },
                { "id": "prt_3", "type": "text", "text": "Found 2 issues" },
                { "id": "prt_4", "type": "step-finish", "reason": finish }
            ]
        }))
    }

    #[test]
    fn running_child_reports_model_effort_tokens_and_tools() {
        let snapshot = ChildSnapshot::read(&[prompt(), step(Some("tool-calls"), Some(1800))]);
        assert!(!snapshot.is_finished());
        let patch = snapshot.patch("ses_child", false);
        assert_eq!(patch.child_session_id.as_deref(), Some("ses_child"));
        assert_eq!(patch.model.as_deref(), Some("anthropic/claude-haiku-5-5"));
        assert!(patch.model_resolved);
        assert_eq!(patch.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(patch.total_tokens, Some(2000));
        assert_eq!(patch.tool_use_count, Some(1));
        assert_eq!(patch.status, None);
        assert_eq!(patch.duration_ms, None);
    }

    #[test]
    fn finished_foreground_child_reports_duration_but_no_status() {
        let snapshot = ChildSnapshot::read(&[prompt(), step(Some("stop"), Some(4000))]);
        assert!(snapshot.is_finished());
        let patch = snapshot.patch("ses_child", false);
        assert_eq!(patch.duration_ms, Some(3000));
        assert_eq!(patch.status, None);
        assert_eq!(patch.result_summary, None);
    }

    #[test]
    fn finished_background_child_completes_or_fails() {
        let done = ChildSnapshot::read(&[prompt(), step(Some("stop"), Some(4000))]);
        let patch = done.patch("ses_child", true);
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Completed));
        assert_eq!(patch.result_summary.as_deref(), Some("Found 2 issues"));

        let errored = message(json!({
            "info": {
                "id": "msg_3", "sessionID": "ses_child", "role": "assistant",
                "error": { "name": "APIError", "data": { "message": "overloaded" } },
                "time": { "created": 1500, "completed": 1600 }
            },
            "parts": []
        }));
        let failed = ChildSnapshot::read(&[prompt(), errored]).patch("ses_child", true);
        assert_eq!(failed.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(failed.status_reason.as_deref(), Some("overloaded"));
    }

    #[test]
    fn an_aborted_background_child_is_stopped_not_failed() {
        let aborted = message(json!({
            "info": {
                "id": "msg_3", "sessionID": "ses_child", "role": "assistant",
                "error": { "name": "MessageAbortedError", "data": { "message": "The operation was aborted." } },
                "time": { "created": 1500, "completed": 1600 }
            },
            "parts": []
        }));
        let patch = ChildSnapshot::read(&[prompt(), aborted]).patch("ses_child", true);
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Stopped));
        assert_eq!(patch.status_reason.as_deref(), Some("interrupted"));
    }

    #[test]
    fn a_failed_tool_in_the_final_message_fails_the_child() {
        let last = message(json!({
            "info": { "id": "msg_2", "sessionID": "ses_child", "role": "assistant", "finish": "stop",
                      "time": { "created": 1500, "completed": 2000 } },
            "parts": [{ "id": "prt_2", "type": "tool", "tool": "bash", "callID": "c1",
                        "state": { "status": "error", "input": { "command": "false" }, "error": "exit 1" } }]
        }));
        let patch = ChildSnapshot::read(&[prompt(), last]).patch("ses_child", true);
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(patch.status_reason.as_deref(), Some("Bash failed"));
    }

    #[test]
    fn a_trailing_user_message_means_the_child_runs_again() {
        let mut follow_up = prompt();
        follow_up.id = "msg_9".into();
        let snapshot = ChildSnapshot::read(&[prompt(), step(Some("stop"), Some(4000)), follow_up]);
        assert!(!snapshot.is_finished());
    }

    #[test]
    fn reporter_throttles_running_children_and_drops_repeats() {
        let mut reporter = ChildReporter::default();
        let at = |ms: u64| Instant::now() + Duration::from_millis(ms);
        let t0 = Instant::now();
        let running = ChildSnapshot::read(&[prompt()]).patch("ses_child", false);
        assert!(reporter.next(running, false, t0).is_some());
        let busier = ChildSnapshot::read(&[prompt(), step(Some("tool-calls"), None)])
            .patch("ses_child", false);
        let throttled = t0 + Duration::from_millis(500);
        assert!(reporter.next(busier.clone(), false, throttled).is_none());
        let due = t0 + Duration::from_millis(1200);
        assert!(reporter.next(busier.clone(), false, due).is_some());
        assert!(reporter.next(busier, false, at(5_000)).is_none(), "repeat");
        let done = ChildSnapshot::read(&[prompt(), step(Some("stop"), Some(4000))])
            .patch("ses_child", true);
        let soon = due + Duration::from_millis(100);
        assert!(
            reporter.next(done, true, soon).is_some(),
            "a finish is never throttled"
        );
    }
}
