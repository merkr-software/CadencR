//! Keeping a runtime alive while it still owes the agent a resume.
//!
//! A provider can launch work that outlives the turn: Claude Code's
//! `run_in_background` shell commands, agents and monitors, or a
//! `ScheduleWakeup` timer. The turn emits its `Result`, the session goes idle,
//! and the runtime re-invokes the agent with a new turn once the task settles
//! or the timer fires. Closing or respawning the runtime in between kills that
//! work and the resume never happens — the agent looks stuck until the user
//! nudges it. Deferred teardown and the prompt-time respawn consult
//! [`RuntimeHold`] (shared through [`super::runtime_hold_registry`]). Conforms
//! to `.claude/rules/inline-rust-tests.md`.

use std::time::Duration;

use tokio::time::Instant;

use crate::domain::agents::adapter::{RuntimeEvent, RuntimeUserContentBlock, ScheduledWakeup};

/// How long the runtime stays protected after its last background task
/// settled or its wake-up came due. The provider starts the resume turn right
/// then; this covers a slow start so teardown can't slip into that gap.
const RESUME_GRACE: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct PendingWakeup {
    tool_use_id: String,
    due: Instant,
}

#[derive(Debug, Default)]
pub(in crate::domain::ws_session) struct RuntimeHold {
    /// Live task count from the provider's latest snapshot.
    live_tasks: usize,
    /// When the snapshot last dropped to zero from a non-zero count.
    drained_at: Option<Instant>,
    /// The agent's pending wake-up. A newer one replaces it, like the timer.
    wakeup: Option<PendingWakeup>,
}

impl RuntimeHold {
    pub(in crate::domain::ws_session) fn observe(&mut self, event: &RuntimeEvent) {
        self.observe_at(event, Instant::now());
    }

    fn observe_at(&mut self, event: &RuntimeEvent, now: Instant) {
        if let Some(live) = event.background_task_count() {
            if live == 0 && self.live_tasks > 0 {
                self.drained_at = Some(now);
            }
            self.live_tasks = live;
        }
        match event.scheduled_wakeup() {
            Some(ScheduledWakeup::Scheduled {
                tool_use_id,
                due_in,
            }) => {
                self.wakeup = Some(PendingWakeup {
                    tool_use_id: tool_use_id.clone(),
                    due: now + *due_in,
                });
            }
            Some(ScheduledWakeup::Cancelled) => self.wakeup = None,
            None => {}
        }
        if self.wakeup_was_rejected(event) {
            self.wakeup = None;
        }
    }

    /// A wake-up whose scheduling call failed was never armed.
    fn wakeup_was_rejected(&self, event: &RuntimeEvent) -> bool {
        let (Some(wakeup), Some(message)) = (&self.wakeup, event.user_message()) else {
            return false;
        };
        message.content.iter().any(|block| {
            matches!(
                block,
                RuntimeUserContentBlock::ToolResult { tool_use_id: Some(id), is_error: true, .. }
                    if *id == wakeup.tool_use_id
            )
        })
    }

    /// Whether closing the runtime now would lose background work, a pending
    /// wake-up, or the resume turn either is about to trigger.
    pub(in crate::domain::ws_session) fn holds_runtime(&self) -> bool {
        self.holds_runtime_at(Instant::now())
    }

    fn holds_runtime_at(&self, now: Instant) -> bool {
        let within_grace = |since: Instant| now < since + RESUME_GRACE;
        self.live_tasks > 0
            || self.drained_at.is_some_and(within_grace)
            || self
                .wakeup
                .as_ref()
                .is_some_and(|wakeup| within_grace(wakeup.due))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeEventKind, RuntimeEventMetadata, RuntimeUserMessage,
    };

    fn other() -> RuntimeEvent {
        RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
    }

    fn snapshot(live: usize) -> RuntimeEvent {
        other().with_background_task_count(Some(live))
    }

    fn wakeup(due_in: Duration) -> RuntimeEvent {
        other().with_scheduled_wakeup(Some(ScheduledWakeup::Scheduled {
            tool_use_id: "toolu_wake".into(),
            due_in,
        }))
    }

    fn tool_result(tool_use_id: &str, is_error: bool) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::UserMessage {
                message: RuntimeUserMessage {
                    content: vec![RuntimeUserContentBlock::ToolResult {
                        tool_use_id: Some(tool_use_id.into()),
                        is_error,
                        content: Value::Null,
                    }],
                },
                parent_tool_use_id: None,
            },
        )
    }

    #[test]
    fn a_fresh_runtime_holds_nothing() {
        assert!(!RuntimeHold::default().holds_runtime());
    }

    #[test]
    fn a_live_task_holds_the_runtime() {
        let mut hold = RuntimeHold::default();
        hold.observe(&snapshot(1));
        assert!(hold.holds_runtime());
    }

    #[test]
    fn events_without_a_snapshot_leave_the_count_alone() {
        let mut hold = RuntimeHold::default();
        hold.observe(&snapshot(2));
        hold.observe(&RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::Result,
        ));
        assert!(hold.holds_runtime());
    }

    #[test]
    fn draining_keeps_a_grace_for_the_resume_turn_then_releases() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&snapshot(1), start);
        hold.observe_at(&snapshot(0), start);

        assert!(hold.holds_runtime_at(start + RESUME_GRACE - Duration::from_millis(1)));
        assert!(!hold.holds_runtime_at(start + RESUME_GRACE));
    }

    #[test]
    fn an_empty_snapshot_without_prior_tasks_does_not_start_a_grace() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&snapshot(0), start);
        assert!(!hold.holds_runtime_at(start));
    }

    #[test]
    fn a_wakeup_holds_until_it_is_due_plus_the_grace() {
        let start = Instant::now();
        let delay = Duration::from_secs(120);
        let mut hold = RuntimeHold::default();
        hold.observe_at(&wakeup(delay), start);

        assert!(hold.holds_runtime_at(start + delay));
        assert!(!hold.holds_runtime_at(start + delay + RESUME_GRACE));
    }

    #[test]
    fn a_newer_wakeup_replaces_the_pending_one() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&wakeup(Duration::from_secs(3600)), start);
        hold.observe_at(&wakeup(Duration::from_secs(60)), start);
        assert!(!hold.holds_runtime_at(start + Duration::from_secs(120)));
    }

    #[test]
    fn a_cancelled_wakeup_releases_the_runtime() {
        let mut hold = RuntimeHold::default();
        hold.observe(&wakeup(Duration::from_secs(600)));
        hold.observe(&other().with_scheduled_wakeup(Some(ScheduledWakeup::Cancelled)));
        assert!(!hold.holds_runtime());
    }

    #[test]
    fn a_rejected_scheduling_call_releases_the_runtime() {
        let mut hold = RuntimeHold::default();
        hold.observe(&wakeup(Duration::from_secs(600)));
        hold.observe(&tool_result("toolu_other", true));
        assert!(hold.holds_runtime(), "another tool's failure is unrelated");
        hold.observe(&tool_result("toolu_wake", false));
        assert!(hold.holds_runtime(), "an accepted call arms the wake-up");
        hold.observe(&tool_result("toolu_wake", true));
        assert!(!hold.holds_runtime());
    }
}
