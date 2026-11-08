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

use super::turn_clock::{CompletedTurn, TurnClock};
use super::{AgentStatus, PendingKind, SessionStatusEvent, TurnOutcome};

/// Who is asking for a transition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Source {
    /// The code path that owns the change: a prompt, a gate, a stop, a turn end.
    Authoritative,
    /// Resolves this request only; a newer gate must keep its pending status.
    GateResponse { request_id: String },
    /// Runtime stream activity. It proves the turn is alive but cannot answer a
    /// pending gate, so it never turns a `Question` back into `Agent`; and only
    /// an event that `starts_turn` revives a session another path marked idle
    /// (trailing deltas of an interrupted turn must not).
    Stream { starts_turn: bool },
}

#[derive(Clone, Debug)]
pub(super) struct Transition {
    pub session_id: i64,
    pub feature_id: i64,
    pub status: AgentStatus,
    pub kind: Option<PendingKind>,
    pub request_id: Option<String>,
    pub outcome: Option<TurnOutcome>,
    pub source: Source,
    /// Whether a turn this transition starts gets a closing transcript line.
    pub summarized: bool,
}

impl Transition {
    /// An authoritative transition of the current turn; callers override the rest.
    pub(super) fn new(session_id: i64, feature_id: i64, status: AgentStatus) -> Self {
        Self {
            session_id,
            feature_id,
            status,
            kind: None,
            request_id: None,
            outcome: None,
            source: Source::Authoritative,
            summarized: true,
        }
    }
}

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

/// Non-idle sessions keyed by `session_id`.
#[derive(Debug, Default)]
pub(super) struct LiveStatusBook {
    seq: u64,
    sessions: HashMap<i64, SessionStatusSnapshotEntry>,
}

impl LiveStatusBook {
    pub(super) fn is_busy(&self, session_id: i64) -> bool {
        self.sessions.contains_key(&session_id)
    }

    pub(super) fn seq(&self) -> u64 {
        self.seq
    }

    /// Load a persisted non-idle session at boot, before any client connects.
    pub(super) fn seed(&mut self, entry: SessionStatusSnapshotEntry) {
        if entry.status != AgentStatus::Idle {
            self.sessions.insert(entry.session_id, entry);
        }
    }

    /// `(session_id, feature_id)` of every non-idle session.
    pub(super) fn tracked(&self) -> Vec<(i64, i64)> {
        self.sessions
            .values()
            .map(|entry| (entry.session_id, entry.feature_id))
            .collect()
    }

    /// Apply a transition. `None` when it changes nothing (a repeat, or stream
    /// activity under a pending gate); otherwise what to broadcast and record.
    pub(super) fn apply(&mut self, transition: &Transition, now_ms: i64) -> Option<Applied> {
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
        let event = self.event(session_id, feature_id, None, now_ms);
        Some(Applied {
            event,
            completed: None,
            persist: None,
        })
    }

    /// Every non-idle session, keyed by `session_id` for the wire.
    pub(super) fn snapshot(&self) -> HashMap<String, SessionStatusSnapshotEntry> {
        self.sessions
            .iter()
            .map(|(session_id, entry)| (session_id.to_string(), entry.clone()))
            .collect()
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
            outcome,
            seq: self.seq,
            server_now_ms: now_ms,
        }
    }
}

/// The part of a clock the DB mirrors (the reported model's name is derived).
fn persisted_clock(
    entry: Option<&SessionStatusSnapshotEntry>,
) -> Option<(Option<i64>, i64, Option<i64>, &[String])> {
    entry.map(|entry| {
        let clock = &entry.clock;
        (
            clock.turn_started_at_ms,
            clock.waiting_ms,
            clock.waiting_since_ms,
            clock.models.as_slice(),
        )
    })
}

fn transition_cannot_apply(
    current: Option<&SessionStatusSnapshotEntry>,
    transition: &Transition,
) -> bool {
    match &transition.source {
        Source::Authoritative => false,
        Source::GateResponse { request_id } => current.is_some_and(|entry| {
            entry.status == AgentStatus::Question
                && entry
                    .request_id
                    .as_ref()
                    .is_some_and(|pending| pending != request_id)
        }),
        Source::Stream { starts_turn } if transition.status == AgentStatus::Agent => {
            match current {
                Some(entry) => entry.status == AgentStatus::Question,
                None => !starts_turn,
            }
        }
        Source::Stream { .. } => false,
    }
}

/// Whether [`next_entry`] would rebuild `entry` as it is.
fn unchanged_by(entry: &SessionStatusSnapshotEntry, transition: &Transition) -> bool {
    let gate_open = entry.clock.waiting_since_ms.is_some();
    entry.status == transition.status
        && entry.feature_id == transition.feature_id
        && entry.kind == transition.kind
        && entry.request_id == transition.request_id
        && entry.clock.turn_started_at_ms.is_some()
        && gate_open == (transition.status == AgentStatus::Question)
}

/// A busy session keeps its turn: a prompt sent while it works steers the same
/// turn, so only a session leaving idle starts a clock.
fn next_entry(
    current: Option<&SessionStatusSnapshotEntry>,
    transition: &Transition,
    now_ms: i64,
) -> Option<SessionStatusSnapshotEntry> {
    if transition.status == AgentStatus::Idle {
        return None;
    }
    let mut clock = match current {
        Some(entry) => entry.clock.clone(),
        None => TurnClock::start(now_ms, transition.summarized),
    };
    // A gate persisted before turns had a clock starts one when it resumes.
    clock.turn_started_at_ms.get_or_insert(now_ms);
    match transition.status {
        AgentStatus::Question => clock.open_gate(now_ms),
        _ => clock.close_gate(now_ms),
    }
    Some(SessionStatusSnapshotEntry {
        session_id: transition.session_id,
        feature_id: transition.feature_id,
        status: transition.status,
        kind: transition.kind,
        request_id: transition.request_id.clone(),
        clock,
        compacting: current.is_some_and(|entry| entry.compacting),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        });
        let resumed = event(book.apply(&authoritative(AgentStatus::Agent), 5));
        assert_eq!(resumed.clock.turn_started_at_ms, Some(5));
    }
}
