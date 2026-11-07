//! Claude Code's background-task lifecycle `system` frames.
//!
//! The CLI reports `run_in_background` agents, shells and monitors through
//! `type: "system"` frames whose payload shape varies per subtype and keeps
//! growing (`task_started`, `task_progress`, `task_notification`,
//! `task_updated`, `background_tasks_changed`). They are recognized explicitly
//! and kept verbatim so consumers read their fields off the wire payload,
//! instead of relying on a decoding failure to route them to
//! [`SdkMessage::Unknown`](super::SdkMessage::Unknown).

use serde::Serialize;
use serde_json::Value;

use super::raw_session_id;

/// Which background-task lifecycle frame a [`TaskLifecycleEvent`] carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLifecycleKind {
    /// `system/task_started`: a task (agent, shell, monitor) was launched.
    Started,
    /// `system/task_progress`: running counters for a task.
    Progress,
    /// `system/task_notification`: a task came to rest (terminal `status`).
    Notification,
    /// `system/task_updated`: a partial `patch` of a task's state.
    Updated,
    /// `system/background_tasks_changed`: snapshot of every live task.
    BackgroundTasksChanged,
}

impl TaskLifecycleKind {
    /// Every lifecycle kind, in wire order.
    pub const ALL: [TaskLifecycleKind; 5] = [
        TaskLifecycleKind::Started,
        TaskLifecycleKind::Progress,
        TaskLifecycleKind::Notification,
        TaskLifecycleKind::Updated,
        TaskLifecycleKind::BackgroundTasksChanged,
    ];

    /// The `subtype` the CLI tags this frame with.
    pub fn subtype(self) -> &'static str {
        match self {
            TaskLifecycleKind::Started => "task_started",
            TaskLifecycleKind::Progress => "task_progress",
            TaskLifecycleKind::Notification => "task_notification",
            TaskLifecycleKind::Updated => "task_updated",
            TaskLifecycleKind::BackgroundTasksChanged => "background_tasks_changed",
        }
    }

    fn from_subtype(subtype: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.subtype() == subtype)
    }
}

/// A background-task lifecycle frame, with its wire payload preserved.
///
/// Serializes as the raw payload itself, so the frame reaches diagnostics and
/// any raw consumer exactly as the CLI sent it.
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct TaskLifecycleEvent {
    #[serde(skip)]
    kind: TaskLifecycleKind,
    raw: Value,
}

impl TaskLifecycleEvent {
    /// Recognize a lifecycle frame by its `type` / `subtype` tags. Returns the
    /// payload back when it is not one.
    pub(super) fn recognize(raw: Value) -> Result<Self, Value> {
        let kind = (raw.get("type").and_then(Value::as_str) == Some("system"))
            .then(|| raw.get("subtype").and_then(Value::as_str))
            .flatten()
            .and_then(TaskLifecycleKind::from_subtype);
        match kind {
            Some(kind) => Ok(Self { kind, raw }),
            None => Err(raw),
        }
    }

    pub fn kind(&self) -> TaskLifecycleKind {
        self.kind
    }

    /// The frame exactly as the CLI sent it (`type` and `subtype` included).
    pub fn raw(&self) -> &Value {
        &self.raw
    }

    /// The task handle; absent on `background_tasks_changed` snapshots.
    pub fn task_id(&self) -> Option<&str> {
        self.raw.get("task_id").and_then(Value::as_str)
    }

    pub fn session_id(&self) -> Option<&str> {
        raw_session_id(&self.raw)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{TaskLifecycleEvent, TaskLifecycleKind};

    #[test]
    fn recognizes_every_lifecycle_subtype_and_keeps_the_payload() {
        for kind in TaskLifecycleKind::ALL {
            let raw = json!({
                "type": "system", "subtype": kind.subtype(), "uuid": "u",
                "session_id": "s", "task_id": "t1", "future_field": { "x": 1 }
            });
            let event = TaskLifecycleEvent::recognize(raw.clone()).expect("lifecycle frame");
            assert_eq!(event.kind(), kind);
            assert_eq!(event.raw(), &raw);
            assert_eq!(event.task_id(), Some("t1"));
            assert_eq!(event.session_id(), Some("s"));
            assert_eq!(serde_json::to_value(&event).unwrap(), raw);
        }
    }

    #[test]
    fn leaves_other_frames_untouched() {
        for raw in [
            json!({ "type": "system", "subtype": "init", "session_id": "s" }),
            json!({ "type": "system", "subtype": "task_summary", "detail": null }),
            json!({ "type": "task_started", "task_id": "t1" }),
            json!({ "type": "system" }),
        ] {
            assert_eq!(TaskLifecycleEvent::recognize(raw.clone()).unwrap_err(), raw);
        }
    }

    #[test]
    fn snapshot_without_task_id_or_session_id() {
        let event = TaskLifecycleEvent::recognize(json!({
            "type": "system", "subtype": "background_tasks_changed", "session_id": "", "tasks": []
        }))
        .expect("lifecycle frame");
        assert_eq!(event.kind(), TaskLifecycleKind::BackgroundTasksChanged);
        assert_eq!(event.task_id(), None);
        assert_eq!(event.session_id(), None);
    }
}
