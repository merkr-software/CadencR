//! Detecting Claude Code's run-in-background `Agent`/`Task` lifecycle.
//!
//! A `run_in_background` launch lets the main turn end (emit `Result`) while a
//! detached agent keeps working; the CLI auto-resumes the main agent once it
//! finishes. The shared stream reader uses the signal derived here to keep the
//! session "working" across that gap instead of going idle the moment the
//! launching turn completes (issue #58). It also counts every live background
//! task (shell commands included) so the runtime is not torn down while one
//! still has to report back. Conforms to `.claude/rules/inline-rust-tests.md`.

use serde_json::Value;

use crate::domain::agents::adapter::BackgroundAgentSignal;

/// Terminal task statuses reported on `system/task_notification` (`completed`,
/// `failed`, `stopped`) and `system/task_updated` (`completed`, `failed`,
/// `killed`). A background agent that reaches any of these is no longer
/// running. Kept permissive so an unforeseen terminal label still releases the
/// session instead of pinning it to a phantom "working" state.
fn is_terminal_task_status(status: Option<&str>) -> bool {
    status.is_some_and(|status| super::subagents::terminal_task_status(status).is_some())
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
        // A stopped agent's end is first reported as a `killed` patch.
        Some("task_updated")
            if is_terminal_task_status(raw.pointer("/patch/status").and_then(Value::as_str)) =>
        {
            Some(BackgroundAgentSignal::Finished {
                agent_id: task_id.to_string(),
            })
        }
        _ => None,
    }
}

/// Count the background tasks still alive, from Claude Code's
/// `system/background_tasks_changed` snapshot. The CLI emits it whenever its
/// set of `run_in_background` tasks changes (a shell command, agent or monitor
/// starts or settles), always listing every live task, so its length is
/// authoritative regardless of task type. Foreground shells nested in an agent
/// never appear in it.
///
/// Like the task lifecycle above, the subtype is untyped by the SDK and arrives
/// as `SdkMessage::Unknown` with the raw JSON preserved.
pub(super) fn background_task_count(msg: &claude_agent_sdk_rs::SdkMessage) -> Option<usize> {
    let claude_agent_sdk_rs::SdkMessage::Unknown(raw) = msg else {
        return None;
    };
    if raw.get("type").and_then(Value::as_str) != Some("system")
        || raw.get("subtype").and_then(Value::as_str) != Some("background_tasks_changed")
    {
        return None;
    }
    raw.get("tasks").and_then(Value::as_array).map(Vec::len)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{background_agent_signal, background_task_count};
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
    fn stopped_and_killed_background_agents_are_finished() {
        // SDK 0.3.156 `SDKTaskNotificationMessage.status` includes `stopped`;
        // a stopped agent was pinning the session as working forever.
        assert_eq!(
            signal(json!({
                "type": "system", "subtype": "task_notification", "uuid": "u", "session_id": "s",
                "task_id": "task-abc", "tool_use_id": "toolu_1", "status": "stopped",
                "output_file": "", "summary": "Audit codex"
            })),
            Some(BackgroundAgentSignal::Finished {
                agent_id: "task-abc".into()
            })
        );
        // `SDKTaskUpdatedMessage.patch.status` reports the kill first.
        assert_eq!(
            signal(json!({
                "type": "system", "subtype": "task_updated", "uuid": "u", "session_id": "s",
                "task_id": "task-abc", "run_id": "r1",
                "patch": { "status": "killed", "end_time": 1761800000000u64 }
            })),
            Some(BackgroundAgentSignal::Finished {
                agent_id: "task-abc".into()
            })
        );
    }

    #[test]
    fn non_terminal_task_updates_are_not_finished() {
        for status in ["running", "paused", "pending"] {
            assert_eq!(
                signal(json!({
                    "type": "system", "subtype": "task_updated", "uuid": "u", "session_id": "s",
                    "task_id": "task-abc", "patch": { "status": status }
                })),
                None,
                "{status}"
            );
        }
        assert_eq!(
            signal(json!({
                "type": "system", "subtype": "task_updated", "uuid": "u", "session_id": "s",
                "task_id": "task-abc", "patch": { "is_backgrounded": true }
            })),
            None
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

    fn task_count(value: serde_json::Value) -> Option<usize> {
        let msg: claude_agent_sdk_rs::SdkMessage =
            serde_json::from_value(value).expect("valid sdk message");
        background_task_count(&msg)
    }

    #[test]
    fn background_tasks_changed_counts_every_live_task() {
        // Real wire shape (CLI 2.1.310) after two `run_in_background` Bash calls.
        assert_eq!(
            task_count(json!({
                "type": "system", "subtype": "background_tasks_changed",
                "uuid": "u", "session_id": "s",
                "tasks": [
                    { "task_id": "bwhoajb5w", "run_id": "r1", "task_type": "local_bash",
                      "description": "Background sleep 12 then echo a" },
                    { "task_id": "a9c32227", "run_id": "r2", "task_type": "local_agent",
                      "subagent_type": "general-purpose", "description": "Agent" }
                ]
            })),
            Some(2)
        );
    }

    #[test]
    fn background_tasks_changed_with_no_tasks_is_a_zero_snapshot() {
        assert_eq!(
            task_count(json!({
                "type": "system", "subtype": "background_tasks_changed",
                "uuid": "u", "session_id": "s", "tasks": []
            })),
            Some(0)
        );
    }

    #[test]
    fn task_lifecycle_messages_are_not_snapshots() {
        assert_eq!(
            task_count(json!({
                "type": "system", "subtype": "task_started", "uuid": "u", "session_id": "s",
                "task_id": "task-bash", "tool_use_id": "toolu_2", "task_type": "local_bash"
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
