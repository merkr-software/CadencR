//! Detecting Claude Code's run-in-background `Agent`/`Task` lifecycle.
//!
//! A `run_in_background` launch lets the main turn end (emit `Result`) while a
//! detached agent keeps working; the CLI auto-resumes the main agent once it
//! finishes. The shared stream reader uses the signal derived here to keep the
//! session "working" across that gap instead of going idle the moment the
//! launching turn completes (issue #58). Conforms to
//! `.claude/rules/inline-rust-tests.md`.

use serde_json::Value;

use crate::domain::agents::adapter::BackgroundAgentSignal;

/// Terminal task statuses reported on `system/task_notification`. A background
/// agent that reaches any of these is no longer running. Kept permissive so an
/// unforeseen terminal label still releases the session instead of pinning it
/// to a phantom "working" state.
fn is_terminal_task_status(status: Option<&str>) -> bool {
    matches!(
        status,
        Some(
            "completed"
                | "failed"
                | "cancelled"
                | "canceled"
                | "error"
                | "incomplete"
                | "timed_out"
                | "aborted"
        )
    )
}

/// Derive a [`BackgroundAgentSignal`] from the Claude Code task lifecycle.
///
/// A `run_in_background` `Agent`/`Task` launch surfaces as a
/// `system/task_started` with `task_type: "local_agent"`, and its completion as
/// a `system/task_notification` carrying a terminal `status`. Both reference the
/// same `task_id`, which we use as the opaque agent handle. Foreground
/// `local_agent` tasks emit the same pair, but their completion always precedes
/// the launching turn's `Result`, so tracking them is harmless. Nested
/// `local_bash` tasks are `task_type != "local_agent"` on start, so their
/// notifications never match a tracked agent.
///
/// The CLI tags these as `type: "system"` with a `subtype` the SDK does not
/// type, so they arrive as `SdkMessage::Unknown` with the raw JSON preserved —
/// we read the fields straight off that value.
pub(super) fn background_agent_signal(
    msg: &claude_agent_sdk_rs::SdkMessage,
) -> Option<BackgroundAgentSignal> {
    let raw = match msg {
        claude_agent_sdk_rs::SdkMessage::Unknown(raw) => raw,
        _ => return None,
    };
    if raw.get("type").and_then(Value::as_str) != Some("system") {
        return None;
    }
    let task_id = raw.get("task_id").and_then(Value::as_str)?;
    match raw.get("subtype").and_then(Value::as_str) {
        Some("task_started")
            if raw.get("task_type").and_then(Value::as_str) == Some("local_agent") =>
        {
            Some(BackgroundAgentSignal::Started {
                agent_id: task_id.to_string(),
            })
        }
        Some("task_notification")
            if is_terminal_task_status(raw.get("status").and_then(Value::as_str)) =>
        {
            Some(BackgroundAgentSignal::Finished {
                agent_id: task_id.to_string(),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::background_agent_signal;
    use crate::domain::agents::adapter::BackgroundAgentSignal;

    fn signal(value: serde_json::Value) -> Option<BackgroundAgentSignal> {
        let msg: claude_agent_sdk_rs::SdkMessage =
            serde_json::from_value(value).expect("valid sdk message");
        background_agent_signal(&msg)
    }

    #[test]
    fn task_started_for_local_agent_is_started() {
        // Real wire shape: a `run_in_background` launch surfaces as
        // `system/task_started` with `task_type: "local_agent"`. The CLI tags
        // it `type: "system"`, so the SDK yields `Unknown(raw)`.
        assert_eq!(
            signal(json!({
                "type": "system", "subtype": "task_started", "uuid": "u", "session_id": "s",
                "task_id": "task-abc", "tool_use_id": "toolu_1",
                "task_type": "local_agent", "subagent_type": "general-purpose"
            })),
            Some(BackgroundAgentSignal::Started {
                agent_id: "task-abc".into()
            })
        );
    }

    #[test]
    fn task_started_for_local_bash_is_not_an_agent() {
        // A nested shell task inside an agent is not itself a background agent.
        assert_eq!(
            signal(json!({
                "type": "system", "subtype": "task_started", "uuid": "u", "session_id": "s",
                "task_id": "task-bash", "tool_use_id": "toolu_2", "task_type": "local_bash"
            })),
            None
        );
    }

    #[test]
    fn task_notification_completed_is_finished() {
        // The "came to rest" completion releases the agent, keyed by `task_id`.
        assert_eq!(
            signal(json!({
                "type": "system", "subtype": "task_notification", "uuid": "u", "session_id": "s",
                "task_id": "task-abc", "tool_use_id": "toolu_1",
                "status": "completed", "summary": "Agent came to rest"
            })),
            Some(BackgroundAgentSignal::Finished {
                agent_id: "task-abc".into()
            })
        );
    }

    #[test]
    fn task_notification_in_progress_is_not_finished() {
        assert_eq!(
            signal(json!({
                "type": "system", "subtype": "task_notification", "uuid": "u", "session_id": "s",
                "task_id": "task-abc", "status": "in_progress"
            })),
            None
        );
    }

    #[test]
    fn plain_assistant_message_has_no_signal() {
        assert_eq!(
            signal(json!({
                "type": "assistant", "uuid": "u", "session_id": "s",
                "message": { "id": "m", "model": "claude-opus-4-8",
                    "content": [{ "type": "text", "text": "hi" }] }
            })),
            None
        );
    }
}
