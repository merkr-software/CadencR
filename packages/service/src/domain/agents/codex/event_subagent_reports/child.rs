//! One child thread's lifecycle, reduced to registry patches.
//!
//! Codex reports the same ending several ways (the child's own
//! `turn/completed`, its thread going idle or closed, the parent's
//! `subAgentActivity` and `agentsStates`), in no guaranteed order. Each
//! signal carries a [`Strength`]: a weaker one never overwrites how a child
//! already ended, so a completed child closed by its parent stays completed,
//! while the child's own turn end corrects a weaker guess.
use std::time::{Duration, Instant};

use crate::domain::agents::adapter::{RuntimeSubagentPatch, RuntimeSubagentStatus};

/// At most one token report per child per interval; the latest total is
/// flushed with the child's next lifecycle patch.
const TOKEN_REPORT_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Strength {
    /// Thread bookkeeping (idle, closed, shut down): ends only a child seen running.
    Inferred,
    /// The parent's view (`subAgentActivity`, `agentsStates`) or a thread error.
    Reported,
    /// The child's own `turn/completed`: also corrects a weaker ending.
    Turn,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct End {
    status: RuntimeSubagentStatus,
    reason: Option<String>,
    summary: Option<String>,
    strength: Strength,
}

impl End {
    pub(super) fn completed(strength: Strength) -> Self {
        Self::new(RuntimeSubagentStatus::Completed, None, strength)
    }

    pub(super) fn stopped(reason: &str, strength: Strength) -> Self {
        Self::new(RuntimeSubagentStatus::Stopped, Some(reason), strength)
    }

    /// Failed with `error` as both its reason and its summary.
    pub(super) fn failed(error: &str, strength: Strength) -> Self {
        let error = crate::domain::agents::adapter::summarize_subagent_result(error);
        Self {
            summary: error.clone(),
            ..Self::new(RuntimeSubagentStatus::Failed, error.as_deref(), strength)
        }
    }

    pub(super) fn new(
        status: RuntimeSubagentStatus,
        reason: Option<&str>,
        strength: Strength,
    ) -> Self {
        Self {
            status,
            reason: reason.map(ToOwned::to_owned),
            summary: None,
            strength,
        }
    }

    pub(super) fn with_summary(mut self, summary: Option<String>) -> Self {
        if self.summary.is_none() {
            self.summary = summary;
        }
        self
    }
}

pub(super) enum ChildChange {
    /// Configuration Codex reports for the child (nickname, role, model…).
    Config(RuntimeSubagentPatch),
    /// Spawned or loaded active: running, with no status change to report.
    Spawned,
    /// A child turn started: the child runs (again, when it was resumed).
    Started {
        turn: Option<String>,
    },
    TurnEnded {
        turn: Option<String>,
        end: End,
        duration_ms: Option<u64>,
    },
    Settled(End),
    /// Head of the child's final answer, its report once it completes.
    Report(String),
    /// Cumulative tokens of the child thread.
    Tokens(u64),
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Phase {
    #[default]
    Unseen,
    Running,
    Settled(Strength),
}

#[derive(Debug, Default)]
pub(super) struct ChildReport {
    phase: Phase,
    turn: Option<String>,
    active_ms: Option<u64>,
    report: Option<String>,
    tokens: TokenGauge,
    announced: bool,
}

impl ChildReport {
    /// True once: the first fact about a child also names its thread.
    pub(super) fn announce(&mut self) -> bool {
        !std::mem::replace(&mut self.announced, true)
    }

    pub(super) fn apply(&mut self, change: ChildChange, now: Instant) -> RuntimeSubagentPatch {
        match change {
            ChildChange::Config(patch) => patch,
            ChildChange::Spawned => {
                if self.phase == Phase::Unseen {
                    self.phase = Phase::Running;
                }
                RuntimeSubagentPatch::default()
            }
            ChildChange::Started { turn } => self.start(turn, now),
            ChildChange::TurnEnded {
                turn,
                end,
                duration_ms,
            } => self.end_turn(turn.as_deref(), end, duration_ms, now),
            ChildChange::Settled(end) => self.settle(end, now),
            ChildChange::Report(summary) => self.record_report(summary),
            ChildChange::Tokens(total) => RuntimeSubagentPatch {
                total_tokens: self.tokens.observe(total, now),
                ..RuntimeSubagentPatch::default()
            },
        }
    }

    fn start(&mut self, turn: Option<String>, now: Instant) -> RuntimeSubagentPatch {
        if turn.is_some() {
            self.turn = turn;
        }
        if self.phase != Phase::Running {
            self.phase = Phase::Running;
            self.report = None;
        }
        // Always said: the carrier may have been settled by the root's turn
        // end while this child kept going. An unchanged status is a no-op.
        RuntimeSubagentPatch {
            status: Some(RuntimeSubagentStatus::Running),
            ..self.tokens_patch(now)
        }
    }

    fn end_turn(
        &mut self,
        turn: Option<&str>,
        end: End,
        duration_ms: Option<u64>,
        now: Instant,
    ) -> RuntimeSubagentPatch {
        if let (Some(active), Some(ended)) = (self.turn.as_deref(), turn) {
            if active != ended {
                // An older turn's late end says nothing about the current one.
                return self.tokens_patch(now);
            }
        }
        self.turn = None;
        if let Some(ms) = duration_ms {
            self.active_ms = Some(self.active_ms.unwrap_or(0).saturating_add(ms));
        }
        self.settle(end, now)
    }

    fn settle(&mut self, end: End, now: Instant) -> RuntimeSubagentPatch {
        let applies = match self.phase {
            Phase::Unseen => end.strength >= Strength::Reported,
            Phase::Running => true,
            Phase::Settled(previous) => end.strength == Strength::Turn && previous < Strength::Turn,
        };
        if !applies {
            // Already ended: a later report can still fill in its summary.
            return RuntimeSubagentPatch {
                result_summary: end.summary,
                ..self.tokens_patch(now)
            };
        }
        self.phase = Phase::Settled(end.strength);
        let summary = match end.status {
            RuntimeSubagentStatus::Completed => end.summary.or_else(|| self.report.clone()),
            _ => end.summary,
        };
        RuntimeSubagentPatch {
            status: Some(end.status),
            status_reason: end.reason,
            result_summary: summary,
            duration_ms: self.active_ms,
            ..self.tokens_patch(now)
        }
    }

    fn record_report(&mut self, summary: String) -> RuntimeSubagentPatch {
        self.report = Some(summary.clone());
        match self.phase {
            Phase::Settled(_) => RuntimeSubagentPatch {
                result_summary: Some(summary),
                ..RuntimeSubagentPatch::default()
            },
            Phase::Unseen | Phase::Running => RuntimeSubagentPatch::default(),
        }
    }

    fn tokens_patch(&mut self, now: Instant) -> RuntimeSubagentPatch {
        RuntimeSubagentPatch {
            total_tokens: self.tokens.flush(now),
            ..RuntimeSubagentPatch::default()
        }
    }
}

#[derive(Debug, Default)]
struct TokenGauge {
    latest: Option<u64>,
    sent: Option<u64>,
    sent_at: Option<Instant>,
}

impl TokenGauge {
    fn observe(&mut self, total: u64, now: Instant) -> Option<u64> {
        self.latest = Some(total);
        let due = self
            .sent_at
            .is_none_or(|at| now.saturating_duration_since(at) >= TOKEN_REPORT_INTERVAL);
        if due {
            self.flush(now)
        } else {
            None
        }
    }

    /// The latest total, when it differs from the last one sent.
    fn flush(&mut self, now: Instant) -> Option<u64> {
        let latest = self.latest.filter(|total| self.sent != Some(*total))?;
        self.sent = Some(latest);
        self.sent_at = Some(now);
        Some(latest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use RuntimeSubagentStatus::{Completed, Failed, Running, Stopped};

    fn status(report: &mut ChildReport, change: ChildChange) -> Option<RuntimeSubagentStatus> {
        report.apply(change, Instant::now()).status
    }

    #[test]
    fn weaker_endings_never_overwrite_and_turn_end_corrects_them() {
        let mut report = ChildReport::default();
        // Closed before it was ever seen running: nothing to say.
        let closed = ChildChange::Settled(End::stopped("closed", Strength::Inferred));
        assert_eq!(status(&mut report, closed), None);
        assert_eq!(
            status(
                &mut report,
                ChildChange::Started {
                    turn: Some("t1".into())
                }
            ),
            Some(Running)
        );
        let idle = ChildChange::Settled(End::completed(Strength::Inferred));
        assert_eq!(status(&mut report, idle), Some(Completed));
        // The child's own failed turn corrects the idle guess…
        let failed = ChildChange::TurnEnded {
            turn: Some("t1".into()),
            end: End::failed("capacity", Strength::Turn),
            duration_ms: Some(1_500),
        };
        let patch = report.apply(failed, Instant::now());
        assert_eq!(patch.status, Some(Failed));
        assert_eq!(patch.status_reason.as_deref(), Some("capacity"));
        assert_eq!(patch.duration_ms, Some(1_500));
        // …and the parent closing it afterwards changes nothing.
        let shutdown = ChildChange::Settled(End::stopped("closed", Strength::Inferred));
        assert_eq!(status(&mut report, shutdown), None);
        let completed = ChildChange::Settled(End::completed(Strength::Reported));
        assert_eq!(status(&mut report, completed), None);
    }

    #[test]
    fn resume_runs_again_and_accumulates_active_time() {
        let mut report = ChildReport::default();
        report.apply(
            ChildChange::Started {
                turn: Some("t1".into()),
            },
            Instant::now(),
        );
        report.apply(ChildChange::Report("first answer".into()), Instant::now());
        let first = report.apply(
            ChildChange::TurnEnded {
                turn: Some("t1".into()),
                end: End::completed(Strength::Turn),
                duration_ms: Some(2_000),
            },
            Instant::now(),
        );
        assert_eq!(first.result_summary.as_deref(), Some("first answer"));
        assert_eq!(
            status(
                &mut report,
                ChildChange::Started {
                    turn: Some("t2".into())
                }
            ),
            Some(Running)
        );
        // A stale end of the first turn does not end the resumed one.
        let stale = ChildChange::TurnEnded {
            turn: Some("t1".into()),
            end: End::completed(Strength::Turn),
            duration_ms: Some(9),
        };
        assert_eq!(status(&mut report, stale), None);
        let second = report.apply(
            ChildChange::TurnEnded {
                turn: Some("t2".into()),
                end: End::stopped("interrupted", Strength::Turn),
                duration_ms: Some(500),
            },
            Instant::now(),
        );
        assert_eq!(second.status, Some(Stopped));
        assert_eq!(second.status_reason.as_deref(), Some("interrupted"));
        assert_eq!(second.duration_ms, Some(2_500));
        // The first run's report is not the resumed run's.
        assert_eq!(second.result_summary, None);
    }

    #[test]
    fn report_after_ending_fills_the_summary() {
        let mut report = ChildReport::default();
        report.apply(ChildChange::Spawned, Instant::now());
        let done = report.apply(
            ChildChange::Settled(End::completed(Strength::Reported)),
            Instant::now(),
        );
        assert_eq!(done.status, Some(Completed));
        let late = report.apply(ChildChange::Report("found it".into()), Instant::now());
        assert_eq!(late.status, None);
        assert_eq!(late.result_summary.as_deref(), Some("found it"));
    }

    #[test]
    fn tokens_are_throttled_and_flushed_with_the_ending() {
        let start = Instant::now();
        let mut report = ChildReport::default();
        report.apply(ChildChange::Started { turn: None }, start);
        let tokens = |report: &mut ChildReport, total, at| {
            report.apply(ChildChange::Tokens(total), at).total_tokens
        };
        assert_eq!(tokens(&mut report, 100, start), Some(100));
        assert_eq!(
            tokens(&mut report, 200, start + Duration::from_millis(400)),
            None
        );
        assert_eq!(
            tokens(&mut report, 300, start + Duration::from_millis(900)),
            None
        );
        assert_eq!(
            tokens(&mut report, 400, start + Duration::from_millis(1_000)),
            Some(400)
        );
        assert_eq!(
            tokens(&mut report, 500, start + Duration::from_millis(1_200)),
            None
        );
        let end = report.apply(
            ChildChange::TurnEnded {
                turn: None,
                end: End::completed(Strength::Turn),
                duration_ms: None,
            },
            start + Duration::from_millis(1_300),
        );
        assert_eq!(end.total_tokens, Some(500));
        assert_eq!(end.duration_ms, None);
        // Nothing new to flush: an unchanged total is not re-sent.
        assert_eq!(
            tokens(&mut report, 500, start + Duration::from_secs(5)),
            None
        );
    }

    #[test]
    fn announces_once() {
        let mut report = ChildReport::default();
        assert!(report.announce());
        assert!(!report.announce());
    }
}
