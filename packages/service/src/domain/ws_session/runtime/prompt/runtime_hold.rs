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
/// then — or, when the task settled while a turn was still replying, right
/// after that turn's `Result` — and the resume turn shows no turn activity
/// until its first model response; this covers that gap so teardown can't
/// slip into it.
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
    /// When the snapshot last dropped to zero from a non-zero count, moved to
    /// the next `Result` after it (see [`Self::observe_at`]).
    drained_at: Option<Instant>,
    /// A drain that landed while a turn was replying, whose notice the
    /// provider delivers once that turn's `Result` is out.
    drained_mid_turn: bool,
    /// The agent's pending wake-up. A newer one replaces it, like the timer.
    wakeup: Option<PendingWakeup>,
}

impl RuntimeHold {
    /// `turn_in_progress`: the reader's view of whether a turn is replying
    /// when `event` arrives.
    pub(in crate::domain::ws_session) fn observe(
        &mut self,
        event: &RuntimeEvent,
        turn_in_progress: bool,
    ) {
        self.observe_at(event, turn_in_progress, Instant::now());
    }

    fn observe_at(&mut self, event: &RuntimeEvent, turn_in_progress: bool, now: Instant) {
        if let Some(live) = event.background_task_count() {
            if live == 0 && self.live_tasks > 0 {
                self.drained_at = Some(now);
                self.drained_mid_turn = turn_in_progress;
            }
            self.live_tasks = live;
        }
        // A task that settles while a turn is still replying has its notice
        // queued until that turn ends, so the resume turn starts at this
        // `Result`, however long after the drain. Restarting the grace here
        // also covers a notice the turn already took in, at the cost of
        // holding the idle runtime (and deferring a respawn) a few seconds
        // longer.
        if event.is_result() && std::mem::take(&mut self.drained_mid_turn) {
            self.drained_at = Some(now);
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
        hold.observe(&snapshot(1), false);
        assert!(hold.holds_runtime());
    }

    #[test]
    fn events_without_a_snapshot_leave_the_count_alone() {
        let mut hold = RuntimeHold::default();
        hold.observe(&snapshot(2), false);
        hold.observe(
            &RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result),
            false,
        );
        assert!(hold.holds_runtime());
    }

    #[test]
    fn draining_keeps_a_grace_for_the_resume_turn_then_releases() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&snapshot(1), false, start);
        hold.observe_at(&snapshot(0), false, start);

        assert!(hold.holds_runtime_at(start + RESUME_GRACE - Duration::from_millis(1)));
        assert!(!hold.holds_runtime_at(start + RESUME_GRACE));
    }

    fn result() -> RuntimeEvent {
        RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result)
    }

    /// Claude Code queues the notice of a task that settles while a turn is
    /// still producing its reply, and opens the resume turn only once that
    /// turn's `Result` is out — possibly long after the drain.
    #[test]
    fn a_task_settled_during_a_turn_keeps_the_grace_after_that_turn_ends() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&snapshot(1), true, start);
        hold.observe_at(&snapshot(0), true, start + Duration::from_secs(1));
        let turn_end = start + Duration::from_secs(40);
        hold.observe_at(&result(), false, turn_end);

        assert!(hold.holds_runtime_at(turn_end + RESUME_GRACE - Duration::from_millis(1)));
        assert!(!hold.holds_runtime_at(turn_end + RESUME_GRACE));
    }

    #[test]
    fn only_the_first_result_after_a_drain_restarts_the_grace() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&snapshot(1), true, start);
        hold.observe_at(&snapshot(0), true, start);
        hold.observe_at(&result(), false, start + Duration::from_secs(20));
        let resume_end = start + Duration::from_secs(60);
        hold.observe_at(&result(), false, resume_end);

        assert!(!hold.holds_runtime_at(resume_end));
    }

    /// An idle drain makes the provider open the resume turn at once; that
    /// turn's `Result` owes nothing, so a settings respawn isn't deferred.
    #[test]
    fn the_result_of_a_resume_after_an_idle_drain_starts_no_grace() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&snapshot(1), false, start);
        hold.observe_at(&snapshot(0), false, start);
        let resume_end = start + Duration::from_secs(30);
        hold.observe_at(&result(), false, resume_end);

        assert!(!hold.holds_runtime_at(resume_end));
    }

    #[test]
    fn a_result_without_a_settled_task_holds_nothing() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&result(), false, start);
        assert!(!hold.holds_runtime_at(start));
    }

    #[test]
    fn an_empty_snapshot_without_prior_tasks_does_not_start_a_grace() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&snapshot(0), false, start);
        assert!(!hold.holds_runtime_at(start));
    }

    #[test]
    fn a_wakeup_holds_until_it_is_due_plus_the_grace() {
        let start = Instant::now();
        let delay = Duration::from_secs(120);
        let mut hold = RuntimeHold::default();
        hold.observe_at(&wakeup(delay), false, start);

        assert!(hold.holds_runtime_at(start + delay));
        assert!(!hold.holds_runtime_at(start + delay + RESUME_GRACE));
    }

    #[test]
    fn a_newer_wakeup_replaces_the_pending_one() {
        let start = Instant::now();
        let mut hold = RuntimeHold::default();
        hold.observe_at(&wakeup(Duration::from_secs(3600)), false, start);
        hold.observe_at(&wakeup(Duration::from_secs(60)), false, start);
        assert!(!hold.holds_runtime_at(start + Duration::from_secs(120)));
    }

    #[test]
    fn a_cancelled_wakeup_releases_the_runtime() {
        let mut hold = RuntimeHold::default();
        hold.observe(&wakeup(Duration::from_secs(600)), false);
        hold.observe(
            &other().with_scheduled_wakeup(Some(ScheduledWakeup::Cancelled)),
            false,
        );
        assert!(!hold.holds_runtime());
    }

    #[test]
    fn a_rejected_scheduling_call_releases_the_runtime() {
        let mut hold = RuntimeHold::default();
        hold.observe(&wakeup(Duration::from_secs(600)), false);
        hold.observe(&tool_result("toolu_other", true), false);
        assert!(hold.holds_runtime(), "another tool's failure is unrelated");
        hold.observe(&tool_result("toolu_wake", false), false);
        assert!(hold.holds_runtime(), "an accepted call arms the wake-up");
        hold.observe(&tool_result("toolu_wake", true), false);
        assert!(!hold.holds_runtime());
    }
}
