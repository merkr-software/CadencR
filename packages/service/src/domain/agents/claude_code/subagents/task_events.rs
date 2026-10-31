//! Claude Code's task lifecycle messages, read off the raw JSON.
//!
//! The CLI tags them `type: "system"` with subtypes the SDK does not type, so
//! they arrive as `SdkMessage::Unknown`. Shapes (CLI 2.1.312 emitters and
//! `@anthropic-ai/claude-agent-sdk` 0.3.156 `sdk.d.ts`):
//!
//! - `task_started`: `{task_id, tool_use_id?, description, subagent_type?,
//!   task_type?, prompt?, is_backgrounded?, owned_by_subagent?, …}`
//! - `task_progress`: `{task_id, tool_use_id?, description, subagent_type?,
//!   usage: {total_tokens, tool_uses, duration_ms}, last_tool_name?, summary?}`
//! - `task_notification`: `{task_id, tool_use_id?, status: completed | failed |
//!   stopped, reason?, summary, output_file, usage?}`
//! - `task_updated`: `{task_id, patch: {status?: pending | running | completed |
//!   failed | killed | paused, error?, is_backgrounded?, description?, …}}` —
//!   no `tool_use_id`, so it is resolved through the `task_id`.

use serde_json::Value;

use crate::domain::agents::adapter::{non_empty_str, RuntimeSubagentPatch, RuntimeSubagentStatus};

/// Counters a task reports while it runs and when it ends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct TaskUsage {
    total_tokens: Option<u64>,
    tool_uses: Option<u64>,
    duration_ms: Option<u64>,
}

impl TaskUsage {
    fn parse(value: Option<&Value>) -> Option<Self> {
        let value = value?;
        // The CLI fills zeros when it tracked no progress for the task
        // (`tokenCount ?? 0`), so a zero token count means "not reported".
        let total_tokens = count(value.get("total_tokens")).filter(|tokens| *tokens > 0);
        let usage = Self {
            total_tokens,
            tool_uses: total_tokens.and(count(value.get("tool_uses"))),
            duration_ms: count(value.get("duration_ms")).filter(|ms| *ms > 0),
        };
        (usage != Self::default()).then_some(usage)
    }

    pub(super) fn into_patch(self) -> RuntimeSubagentPatch {
        RuntimeSubagentPatch {
            total_tokens: self.total_tokens,
            tool_use_count: self.tool_uses,
            duration_ms: self.duration_ms,
            ..RuntimeSubagentPatch::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum TaskEvent {
    Started {
        task_id: String,
        tool_use_id: Option<String>,
        agent_type: Option<String>,
        description: Option<String>,
        backgrounded: Option<bool>,
    },
    Progress {
        task_id: String,
        tool_use_id: Option<String>,
        usage: Option<TaskUsage>,
    },
    Notification {
        task_id: String,
        tool_use_id: Option<String>,
        status: String,
        reason: Option<String>,
        summary: Option<String>,
        usage: Option<TaskUsage>,
    },
    Updated {
        task_id: String,
        status: Option<String>,
        error: Option<String>,
        backgrounded: Option<bool>,
    },
}

impl TaskEvent {
    pub(super) fn parse(raw: &Value) -> Option<Self> {
        if raw.get("type").and_then(Value::as_str) != Some("system") {
            return None;
        }
        let task_id = text(raw.get("task_id"))?;
        let tool_use_id = text(raw.get("tool_use_id"));
        let event = match raw.get("subtype").and_then(Value::as_str)? {
            "task_started" => Self::Started {
                task_id,
                tool_use_id,
                agent_type: text(raw.get("subagent_type")),
                description: text(raw.get("description")),
                backgrounded: raw.get("is_backgrounded").and_then(Value::as_bool),
            },
            "task_progress" => Self::Progress {
                task_id,
                tool_use_id,
                usage: TaskUsage::parse(raw.get("usage")),
            },
            "task_notification" => Self::Notification {
                task_id,
                tool_use_id,
                status: text(raw.get("status"))?,
                reason: text(raw.get("reason")),
                summary: text(raw.get("summary")),
                usage: TaskUsage::parse(raw.get("usage")),
            },
            "task_updated" => {
                let patch = raw.get("patch");
                Self::Updated {
                    task_id,
                    status: text(patch.and_then(|patch| patch.get("status"))),
                    error: text(patch.and_then(|patch| patch.get("error"))),
                    backgrounded: patch
                        .and_then(|patch| patch.get("is_backgrounded"))
                        .and_then(Value::as_bool),
                }
            }
            _ => return None,
        };
        Some(event)
    }

    pub(super) fn task_id(&self) -> &str {
        match self {
            Self::Started { task_id, .. }
            | Self::Progress { task_id, .. }
            | Self::Notification { task_id, .. }
            | Self::Updated { task_id, .. } => task_id,
        }
    }

    pub(super) fn tool_use_id(&self) -> Option<&str> {
        match self {
            Self::Started { tool_use_id, .. }
            | Self::Progress { tool_use_id, .. }
            | Self::Notification { tool_use_id, .. } => tool_use_id.as_deref(),
            Self::Updated { .. } => None,
        }
    }
}

/// The sub-agent status a task lifecycle label ends in; `None` while the task
/// still runs (`pending`, `running`, `paused`, `in_progress`…). Kept
/// permissive so an unforeseen terminal label still releases the task.
pub(in crate::domain::agents::claude_code) fn terminal_task_status(
    label: &str,
) -> Option<RuntimeSubagentStatus> {
    match label {
        "completed" => Some(RuntimeSubagentStatus::Completed),
        "failed" | "error" | "incomplete" | "timed_out" => Some(RuntimeSubagentStatus::Failed),
        "stopped" | "killed" | "cancelled" | "canceled" | "aborted" => {
            Some(RuntimeSubagentStatus::Stopped)
        }
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(non_empty_str)
}

fn count(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.is_finite() && *number >= 0.0)
            .map(|number| number.round() as u64)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{terminal_task_status, TaskEvent, TaskUsage};
    use crate::domain::agents::adapter::RuntimeSubagentStatus;

    #[test]
    fn parses_task_started_from_the_cli_emitter_shape() {
        // CLI 2.1.312 `task_started` emitter fields (run_id, spawn_depth… ignored).
        let event = TaskEvent::parse(&json!({
            "type": "system", "subtype": "task_started", "uuid": "u", "session_id": "s",
            "task_id": "a8f3c2", "run_id": "r1", "owned_by_subagent": false,
            "tool_use_id": "toolu_1", "description": "Audit codex",
            "subagent_type": "Explore", "is_backgrounded": true, "spawn_depth": 1,
            "task_type": "local_agent", "prompt": "Look at codex"
        }));
        assert_eq!(
            event,
            Some(TaskEvent::Started {
                task_id: "a8f3c2".into(),
                tool_use_id: Some("toolu_1".into()),
                agent_type: Some("Explore".into()),
                description: Some("Audit codex".into()),
                backgrounded: Some(true),
            })
        );
    }

    #[test]
    fn parses_task_progress_usage() {
        let event = TaskEvent::parse(&json!({
            "type": "system", "subtype": "task_progress", "uuid": "u", "session_id": "s",
            "task_id": "a8f3c2", "tool_use_id": "toolu_1", "description": "Audit codex",
            "usage": { "total_tokens": 1200, "tool_uses": 3, "duration_ms": 4500 },
            "last_tool_name": "Read"
        }))
        .unwrap();
        let TaskEvent::Progress { usage, .. } = event else {
            panic!("expected progress, got {event:?}");
        };
        let patch = usage.unwrap().into_patch();
        assert_eq!(patch.total_tokens, Some(1200));
        assert_eq!(patch.tool_use_count, Some(3));
        assert_eq!(patch.duration_ms, Some(4500));
    }

    #[test]
    fn parses_task_notification_with_optional_reason() {
        let event = TaskEvent::parse(&json!({
            "type": "system", "subtype": "task_notification", "uuid": "u", "session_id": "s",
            "task_id": "a8f3c2", "run_id": "r1", "tool_use_id": "toolu_1",
            "status": "stopped", "reason": "user_stop", "output_file": "/tmp/out",
            "summary": "Audit codex",
            "usage": { "total_tokens": 0, "tool_uses": 0, "duration_ms": 0 }
        }))
        .unwrap();
        assert_eq!(event.task_id(), "a8f3c2");
        assert_eq!(event.tool_use_id(), Some("toolu_1"));
        let TaskEvent::Notification {
            status,
            reason,
            usage,
            ..
        } = event
        else {
            panic!("expected notification");
        };
        assert_eq!(status, "stopped");
        assert_eq!(reason.as_deref(), Some("user_stop"));
        // The CLI's zero-filled usage (no progress tracked) carries nothing.
        assert_eq!(usage, None);
    }

    #[test]
    fn parses_task_updated_patch_without_tool_use_id() {
        let event = TaskEvent::parse(&json!({
            "type": "system", "subtype": "task_updated", "uuid": "u", "session_id": "s",
            "task_id": "a8f3c2", "run_id": "r1",
            "patch": { "status": "failed", "end_time": 1761800000000u64, "error": "rate limited" }
        }))
        .unwrap();
        assert_eq!(event.tool_use_id(), None);
        assert_eq!(
            event,
            TaskEvent::Updated {
                task_id: "a8f3c2".into(),
                status: Some("failed".into()),
                error: Some("rate limited".into()),
                backgrounded: None,
            }
        );
    }

    #[test]
    fn ignores_other_system_messages_and_missing_task_ids() {
        assert_eq!(
            TaskEvent::parse(&json!({
                "type": "system", "subtype": "background_tasks_changed", "task_id": "x", "tasks": []
            })),
            None
        );
        assert_eq!(
            TaskEvent::parse(&json!({"type": "system", "subtype": "task_started"})),
            None
        );
        assert_eq!(
            TaskEvent::parse(
                &json!({"type": "assistant", "subtype": "task_started", "task_id": "x"})
            ),
            None
        );
    }

    #[test]
    fn maps_terminal_labels() {
        assert_eq!(
            terminal_task_status("completed"),
            Some(RuntimeSubagentStatus::Completed)
        );
        assert_eq!(
            terminal_task_status("failed"),
            Some(RuntimeSubagentStatus::Failed)
        );
        for label in ["stopped", "killed", "cancelled", "aborted"] {
            assert_eq!(
                terminal_task_status(label),
                Some(RuntimeSubagentStatus::Stopped),
                "{label}"
            );
        }
        for label in ["pending", "running", "paused", "in_progress"] {
            assert_eq!(terminal_task_status(label), None, "{label}");
        }
    }

    #[test]
    fn fractional_counts_round() {
        assert_eq!(
            TaskUsage::parse(Some(&json!({"duration_ms": 12.6}))),
            Some(TaskUsage {
                total_tokens: None,
                tool_uses: None,
                duration_ms: Some(13),
            })
        );
    }
}
