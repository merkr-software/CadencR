//! The live status book: the server's one record of every non-idle session's
//! status, gate, turn clock and compaction.
//!
//! Every broadcast is a transition of this book, applied under the lock that
//! stamps the event's `seq`, and every snapshot is a read of it under that same
//! lock. A snapshot is therefore exactly the fold of every event up to its seq:
//! a device that (re)connects sees what the connected ones see — the timer and
//! "compacting" included.

use std::collections::HashMap;

use crate::domain::sessions::models::SessionStatusSnapshotEntry;

use super::closed_gates::ClosedGates;
use super::transition::{next_entry, persisted_clock, transition_cannot_apply, unchanged_by};
pub(super) use super::transition::{Source, Transition};
use super::turn_clock::{CompletedTurn, TurnClock};
use super::{AgentStatus, SessionStatusEvent, TurnOutcome};

/// What an applied change produced.
#[derive(Debug)]
pub(super) struct Applied {
    pub event: SessionStatusEvent,
    /// The turn the change ended, when its transcript records the end.
    pub completed: Option<CompletedTurn>,
    /// The clock to mirror to the DB when its persisted part changed: `Some(None)`
    /// once the session is idle.
    pub persist: Option<Option<TurnClock>>,
}

/// Non-idle sessions keyed by `session_id`, plus any session with running sub-agents.
#[derive(Debug, Default)]
pub(super) struct LiveStatusBook {
    seq: u64,
    sessions: HashMap<i64, SessionStatusSnapshotEntry>,
    /// Non-zero running sub-agent counts keyed by `session_id`: `(feature_id, count)`.
    /// Kept separate from `sessions` so background sub-agents outliving a turn
    /// stay visible without marking the session itself as busy.
    running_subagents: HashMap<i64, (i64, u32)>,
    closed_gates: ClosedGates,
}

impl LiveStatusBook {
    pub(super) fn is_busy(&self, session_id: i64) -> bool {
        self.sessions.contains_key(&session_id)
    }

    pub(super) fn is_waiting_on_gate(&self, session_id: i64) -> bool {
        self.sessions
            .get(&session_id)
            .is_some_and(|entry| entry.status == AgentStatus::Question)
    }

    pub(super) fn busy_non_gate_feature_id(&self, session_id: i64) -> Option<i64> {
        self.sessions
            .get(&session_id)
            .filter(|entry| entry.status == AgentStatus::Agent)
            .map(|entry| entry.feature_id)
    }

    pub(super) fn seq(&self) -> u64 {
        self.seq
    }

    /// Load a persisted non-idle session at boot, before any client connects.
    pub(super) fn seed(&mut self, mut entry: SessionStatusSnapshotEntry) {
        let count = std::mem::take(&mut entry.running_subagents);
        if count > 0 {
            self.running_subagents
                .insert(entry.session_id, (entry.feature_id, count));
        }
        if entry.status != AgentStatus::Idle {
            self.sessions.insert(entry.session_id, entry);
        }
    }

    /// `(session_id, feature_id)` of every tracked session (busy or running sub-agents).
    pub(super) fn tracked(&self) -> Vec<(i64, i64)> {
        let mut tracked: Vec<(i64, i64)> = self
            .sessions
            .values()
            .map(|entry| (entry.session_id, entry.feature_id))
            .collect();
        for (&session_id, &(feature_id, _)) in &self.running_subagents {
            if !self.sessions.contains_key(&session_id) {
                tracked.push((session_id, feature_id));
            }
        }
        tracked
    }

    /// Apply a transition. `None` when it changes nothing (a repeat, or stream
    /// activity under a pending gate); otherwise what to broadcast and record.
    pub(super) fn apply(&mut self, transition: &Transition, now_ms: i64) -> Option<Applied> {
        if self.shows_a_closed_gate(transition, now_ms) {
            return None;
        }
        let current = self.sessions.get(&transition.session_id);
        if transition_cannot_apply(current, transition) {
            return None;
        }
        // Every stream delta of a working turn lands here: skip building (and
        // cloning the clock into) an entry equal to the current one.
        if transition.outcome.is_none()
            && current.is_some_and(|entry| unchanged_by(entry, transition))
        {
            return None;
        }
        let next = next_entry(current, transition, now_ms);
        // A failed outcome is news even for an already-idle session.
        if next.as_ref() == current && transition.outcome.is_none() {
            return None;
        }
        let persist = (persisted_clock(current) != persisted_clock(next.as_ref()))
            .then(|| next.as_ref().map(|entry| entry.clock.clone()));
        let completed = match (&next, current) {
            (None, Some(ended)) => {
                ended
                    .clock
                    .clone()
                    .finish(ended.session_id, ended.feature_id, now_ms)
            }
            _ => None,
        };
        match next {
            Some(entry) => self.sessions.insert(transition.session_id, entry),
            None => self.sessions.remove(&transition.session_id),
        };
        let event = self.event(
            transition.session_id,
            transition.feature_id,
            transition.outcome,
            now_ms,
        );
        Some(Applied {
            event,
            completed,
            persist,
        })
    }

    /// Track gates closing and opening; true when `transition` would show
    /// again a gate that closed after its turn's end read it as pending.
    fn shows_a_closed_gate(&mut self, transition: &Transition, now_ms: i64) -> bool {
        let session_id = transition.session_id;
        match (&transition.source, transition.request_id.as_deref()) {
            (Source::GateResponse { request_id } | Source::GateDismissed { request_id }, _) => {
                self.closed_gates.record(session_id, request_id, now_ms);
                false
            }
            (Source::GateLeftPending, Some(request_id)) => {
                self.closed_gates.contains(session_id, request_id)
            }
            (Source::Authoritative, Some(request_id)) => {
                self.closed_gates.reopen(session_id, request_id);
                false
            }
            _ => false,
        }
    }

    /// The CLI reports the model running a busy session's root agent.
    pub(super) fn observe_model(
        &mut self,
        session_id: i64,
        model: &str,
        now_ms: i64,
    ) -> Option<Applied> {
        let entry = self.sessions.get_mut(&session_id)?;
        if !entry.clock.observe_model(model) {
            return None;
        }
        let (feature_id, clock) = (entry.feature_id, entry.clock.clone());
        let event = self.event(session_id, feature_id, None, now_ms);
        Some(Applied {
            event,
            completed: None,
            persist: Some(Some(clock)),
        })
    }

    /// The provider started or finished compacting a busy session's context.
    /// An idle session is never compacting: its entry is gone.
    pub(super) fn set_compacting(
        &mut self,
        session_id: i64,
        active: bool,
        now_ms: i64,
    ) -> Option<Applied> {
        let entry = self.sessions.get_mut(&session_id)?;
        if entry.compacting == active {
            return None;
        }
        entry.compacting = active;
        let feature_id = entry.feature_id;
        Some(self.event_only(session_id, feature_id, now_ms))
    }

    /// Record how many sub-agents are currently running in `session_id`.
    /// Works whether the session's main turn is working, gated, or idle.
    pub(super) fn set_running_subagents(
        &mut self,
        session_id: i64,
        feature_id: i64,
        count: u32,
        now_ms: i64,
    ) -> Option<Applied> {
        if self.subagent_count(session_id) == count {
            return None;
        }
        if count == 0 {
            self.running_subagents.remove(&session_id);
        } else {
            self.running_subagents
                .insert(session_id, (feature_id, count));
        }
        Some(self.event_only(session_id, feature_id, now_ms))
    }

    /// Clear a deleted session's status and any running sub-agents in one event.
    pub(super) fn forget_session(
        &mut self,
        session_id: i64,
        feature_id: i64,
        now_ms: i64,
    ) -> Option<Applied> {
        if !self.sessions.contains_key(&session_id) {
            return self.set_running_subagents(session_id, feature_id, 0, now_ms);
        }
        self.running_subagents.remove(&session_id);
        self.apply(
            &Transition::new(session_id, feature_id, AgentStatus::Idle),
            now_ms,
        )
    }

    fn event_only(&mut self, session_id: i64, feature_id: i64, now_ms: i64) -> Applied {
        Applied {
            event: self.event(session_id, feature_id, None, now_ms),
            completed: None,
            persist: None,
        }
    }

    fn subagent_count(&self, session_id: i64) -> u32 {
        self.running_subagents
            .get(&session_id)
            .map_or(0, |(_, count)| *count)
    }

    /// Every non-idle session (plus idle ones with live sub-agents), keyed by `session_id`.
    pub(super) fn snapshot(&self) -> HashMap<String, SessionStatusSnapshotEntry> {
        let mut states: HashMap<String, SessionStatusSnapshotEntry> = self
            .sessions
            .iter()
            .map(|(&session_id, entry)| {
                let mut snapshot = entry.clone();
                snapshot.running_subagents = self.subagent_count(session_id);
                (session_id.to_string(), snapshot)
            })
            .collect();
        for (&session_id, &(feature_id, count)) in &self.running_subagents {
            if !self.sessions.contains_key(&session_id) {
                states.insert(
                    session_id.to_string(),
                    SessionStatusSnapshotEntry {
                        session_id,
                        feature_id,
                        status: AgentStatus::Idle,
                        kind: None,
                        request_id: None,
                        clock: TurnClock::default(),
                        compacting: false,
                        running_subagents: count,
                    },
                );
            }
        }
        states
    }

    /// The event announcing the session's current entry (idle when it has none).
    fn event(
        &mut self,
        session_id: i64,
        feature_id: i64,
        outcome: Option<TurnOutcome>,
        now_ms: i64,
    ) -> SessionStatusEvent {
        self.seq += 1;
        let entry = self.sessions.get(&session_id);
        SessionStatusEvent {
            session_id,
            feature_id,
            status: entry.map_or(AgentStatus::Idle, |entry| entry.status),
            kind: entry.and_then(|entry| entry.kind),
            request_id: entry.and_then(|entry| entry.request_id.clone()),
            clock: entry.map(|entry| entry.clock.clone()).unwrap_or_default(),
            compacting: entry.is_some_and(|entry| entry.compacting),
            running_subagents: self.subagent_count(session_id),
            outcome,
            seq: self.seq,
            server_now_ms: now_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session_status::PendingKind;

    fn authoritative(status: AgentStatus) -> Transition {
        Transition {
            kind: (status == AgentStatus::Question).then_some(PendingKind::Permission),
            ..Transition::new(7, 8, status)
        }
    }

    fn stream(starts_turn: bool) -> Transition {
        Transition {
            source: Source::Stream { starts_turn },
            ..Transition::new(7, 8, AgentStatus::Agent)
        }
    }

    fn event(applied: Option<Applied>) -> SessionStatusEvent {
        applied.expect("transition applies").event
    }

    #[test]
    fn a_turn_keeps_its_start_through_gates_steers_and_stream_activity() {
        let mut book = LiveStatusBook::default();
        let started = event(book.apply(&authoritative(AgentStatus::Agent), 1_000));
        assert_eq!(started.clock.turn_started_at_ms, Some(1_000));

        let gate = event(book.apply(&authoritative(AgentStatus::Question), 2_000));
        assert_eq!(gate.clock.turn_started_at_ms, Some(1_000));
        assert_eq!(gate.clock.waiting_since_ms, Some(2_000));
        let resumed = event(book.apply(&authoritative(AgentStatus::Agent), 3_500));
        assert_eq!(resumed.clock.turn_started_at_ms, Some(1_000));
        assert_eq!(resumed.clock.waiting_ms, 1_500);
        assert_eq!(resumed.clock.waiting_since_ms, None);
        // A prompt sent while the agent works steers the same turn.
        assert!(book
            .apply(&authoritative(AgentStatus::Agent), 4_000)
            .is_none());
        assert!(book.apply(&stream(false), 4_000).is_none());
        assert_eq!(book.snapshot()["7"].clock.turn_started_at_ms, Some(1_000));
    }

    #[test]
    fn going_idle_closes_the_turn_and_the_next_one_starts_fresh() {
        let mut book = LiveStatusBook::default();
        book.apply(&authoritative(AgentStatus::Agent), 1_000);
        book.observe_model(7, "opus", 1_100);
        book.apply(&authoritative(AgentStatus::Question), 2_000);

        let ended = book
            .apply(&authoritative(AgentStatus::Idle), 5_000)
            .unwrap();
        let turn = ended.completed.expect("an agent turn is summarized");
        assert_eq!((turn.started_at_ms, turn.ended_at_ms), (1_000, 5_000));
        assert_eq!(turn.waiting_ms, 3_000);
        assert_eq!(turn.models, ["opus"]);
        assert_eq!(ended.persist, Some(None));
        assert_eq!(ended.event.clock, TurnClock::default());

        let next = event(book.apply(&authoritative(AgentStatus::Agent), 9_000));
        assert_eq!(next.clock.turn_started_at_ms, Some(9_000));
        assert_eq!(next.clock.waiting_ms, 0);
    }

    #[test]
    fn an_unsummarized_turn_ends_without_a_record() {
        let mut book = LiveStatusBook::default();
        let shell = Transition {
            summarized: false,
            ..authoritative(AgentStatus::Agent)
        };
        book.apply(&shell, 1);
        let ended = book.apply(&authoritative(AgentStatus::Idle), 2).unwrap();
        assert!(ended.completed.is_none());
    }

    #[test]
    fn the_reported_model_and_compaction_ride_the_entry() {
        let mut book = LiveStatusBook::default();
        assert!(book.observe_model(7, "opus", 1).is_none(), "idle: no turn");
        book.apply(&authoritative(AgentStatus::Agent), 1);

        let reported = book.observe_model(7, "opus", 2).unwrap();
        assert_eq!(reported.event.clock.model.as_deref(), Some("opus"));
        assert!(reported.persist.is_some());
        assert!(book.observe_model(7, "opus", 3).is_none());

        let compacting = book.set_compacting(7, true, 4).unwrap().event;
        assert!(compacting.compacting);
        assert_eq!(compacting.status, AgentStatus::Agent);
        assert!(book.set_compacting(7, true, 5).is_none());
        assert!(book.snapshot()["7"].compacting);

        book.apply(&authoritative(AgentStatus::Idle), 6);
        assert!(book.set_compacting(7, true, 7).is_none());
        assert!(book.snapshot().is_empty(), "idle clears compaction");
    }

    #[test]
    fn only_clock_changes_are_persisted() {
        let mut book = LiveStatusBook::default();
        assert!(book
            .apply(&authoritative(AgentStatus::Agent), 1)
            .unwrap()
            .persist
            .is_some());
        let gate = Transition {
            request_id: Some("r-1".into()),
            ..authoritative(AgentStatus::Question)
        };
        assert!(book.apply(&gate, 2).unwrap().persist.is_some());
        let newer_gate = Transition {
            request_id: Some("r-2".into()),
            ..authoritative(AgentStatus::Question)
        };
        let applied = book.apply(&newer_gate, 3).unwrap();
        assert!(applied.persist.is_none(), "the wait keeps running");
        assert_eq!(applied.event.clock.waiting_since_ms, Some(2));
        assert!(book.set_compacting(7, true, 4).unwrap().persist.is_none());
    }

    #[test]
    fn repeats_are_not_broadcast_and_do_not_consume_a_seq() {
        let mut book = LiveStatusBook::default();
        assert!(book.apply(&authoritative(AgentStatus::Agent), 1).is_some());
        assert!(book.apply(&authoritative(AgentStatus::Agent), 2).is_none());
        assert!(book.apply(&authoritative(AgentStatus::Idle), 3).is_some());
        assert!(book.apply(&authoritative(AgentStatus::Idle), 4).is_none());
        assert_eq!(book.seq(), 2);
    }

    #[test]
    fn stream_activity_cannot_answer_a_pending_gate() {
        let mut book = LiveStatusBook::default();
        book.apply(&authoritative(AgentStatus::Question), 1);

        assert!(book.apply(&stream(true), 2).is_none());
        assert_eq!(book.snapshot()["7"].status, AgentStatus::Question);
        assert!(book.apply(&authoritative(AgentStatus::Agent), 3).is_some());
    }

    #[test]
    fn only_a_turn_start_revives_a_session_another_path_marked_idle() {
        let mut book = LiveStatusBook::default();
        book.apply(&authoritative(AgentStatus::Agent), 1);
        book.apply(&authoritative(AgentStatus::Idle), 2);

        assert!(book.apply(&stream(false), 3).is_none());
        assert_eq!(
            event(book.apply(&stream(true), 4)).status,
            AgentStatus::Agent
        );
    }

    #[test]
    fn idle_sessions_leave_the_snapshot_and_a_failure_is_always_reported() {
        let mut book = LiveStatusBook::default();
        book.apply(&authoritative(AgentStatus::Agent), 1);
        book.apply(&authoritative(AgentStatus::Idle), 2);
        assert!(book.snapshot().is_empty());
        assert!(book.tracked().is_empty());

        let failed = Transition {
            outcome: Some(TurnOutcome::Failed),
            ..authoritative(AgentStatus::Idle)
        };
        let applied = book.apply(&failed, 3).unwrap();
        assert_eq!(applied.event.outcome, Some(TurnOutcome::Failed));
        assert_eq!(applied.event.clock.turn_started_at_ms, None);
        assert!(applied.completed.is_none());
    }

    #[test]
    fn a_seeded_gate_keeps_its_persisted_clock() {
        let mut book = LiveStatusBook::default();
        book.seed(SessionStatusSnapshotEntry {
            session_id: 7,
            feature_id: 8,
            status: AgentStatus::Question,
            kind: Some(PendingKind::Question),
            request_id: Some("req-1".into()),
            clock: TurnClock::restored(Some(100), 50, Some(400), vec!["opus".into()]),
            compacting: false,
            running_subagents: 0,
        });

        assert_eq!(book.seq(), 0);
        assert_eq!(book.tracked(), vec![(7, 8)]);
        assert_eq!(book.snapshot()["7"].request_id.as_deref(), Some("req-1"));
        let answered = event(book.apply(&authoritative(AgentStatus::Agent), 1_000));
        assert_eq!(answered.clock.turn_started_at_ms, Some(100));
        assert_eq!(answered.clock.waiting_ms, 650);
        assert_eq!(answered.clock.model.as_deref(), Some("opus"));
    }

    #[test]
    fn a_seeded_gate_without_a_clock_starts_one_when_it_resumes() {
        let mut book = LiveStatusBook::default();
        book.seed(SessionStatusSnapshotEntry {
            session_id: 7,
            feature_id: 8,
            status: AgentStatus::Question,
            kind: Some(PendingKind::Permission),
            request_id: None,
            clock: TurnClock::restored(None, 0, None, Vec::new()),
            compacting: false,
            running_subagents: 0,
        });
        let resumed = event(book.apply(&authoritative(AgentStatus::Agent), 5));
        assert_eq!(resumed.clock.turn_started_at_ms, Some(5));
    }

    #[test]
    fn running_subagents_ride_events_and_outlive_an_idle_turn() {
        let mut book = LiveStatusBook::default();
        book.apply(&authoritative(AgentStatus::Agent), 1);

        let started = event(book.set_running_subagents(7, 8, 2, 2));
        assert_eq!(started.status, AgentStatus::Agent);
        assert_eq!(started.running_subagents, 2);
        assert_eq!(book.snapshot()["7"].running_subagents, 2);
        // Unchanged counts emit nothing and consume no seq.
        assert!(book.set_running_subagents(7, 8, 2, 3).is_none());

        // Turn goes idle while a background sub-agent is still running: the
        // session is no longer busy, yet its count stays in events and snapshots.
        let idle = event(book.apply(&authoritative(AgentStatus::Idle), 4));
        assert_eq!(idle.status, AgentStatus::Idle);
        assert_eq!(idle.running_subagents, 2);
        assert!(!book.is_busy(7));
        assert_eq!(book.snapshot()["7"].status, AgentStatus::Idle);
        assert_eq!(book.snapshot()["7"].running_subagents, 2);
        assert_eq!(book.tracked(), vec![(7, 8)]);

        let done = event(book.set_running_subagents(7, 8, 0, 5));
        assert_eq!(done.running_subagents, 0);
        assert!(book.snapshot().is_empty());
        assert!(book.tracked().is_empty());

        // Forgetting a busy session with running sub-agents clears both in one event.
        book.apply(&authoritative(AgentStatus::Agent), 6);
        book.set_running_subagents(7, 8, 1, 7);
        let forgotten = event(book.forget_session(7, 8, 8));
        assert_eq!(forgotten.status, AgentStatus::Idle);
        assert_eq!(forgotten.running_subagents, 0);
        assert!(book.snapshot().is_empty());
        assert!(book.tracked().is_empty());
    }
}
