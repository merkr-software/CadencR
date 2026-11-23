//! Pure transition rules for [`super::live::LiveStatusBook`].

use crate::domain::sessions::models::SessionStatusSnapshotEntry;

use super::turn_clock::TurnClock;
use super::{AgentStatus, PendingKind, TurnOutcome};

/// Who is asking for a transition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Source {
    /// The code path that owns the change: a prompt, a gate, a stop, a turn end.
    Authoritative,
    /// Resolves this request only; a newer gate must keep its pending status.
    GateResponse { request_id: String },
    /// Closes a gate the agent never waited on. Applies only while the session
    /// still shows that gate: a turn start or end, or a newer gate, published
    /// meanwhile already tells the truth.
    GateDismissed { request_id: String },
    /// A turn ended with a gate still pending. Shows it only over that turn's
    /// working status (a reply sent while the gate waited); a gate resolved or
    /// replaced meanwhile already moved the book on.
    GateLeftPending,
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

/// `(turn_started_at_ms, waiting_ms, waiting_since_ms, models)` of a clock.
pub(super) type PersistedClock<'a> = (Option<i64>, i64, Option<i64>, &'a [String]);

/// The part of a clock the DB mirrors (the reported model's name is derived).
pub(super) fn persisted_clock(
    entry: Option<&SessionStatusSnapshotEntry>,
) -> Option<PersistedClock<'_>> {
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

pub(super) fn transition_cannot_apply(
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
        Source::GateDismissed { request_id } => !current.is_some_and(|entry| {
            entry.status == AgentStatus::Question
                && entry.request_id.as_deref() == Some(request_id.as_str())
        }),
        Source::GateLeftPending => !current.is_some_and(|entry| entry.status == AgentStatus::Agent),
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
pub(super) fn unchanged_by(entry: &SessionStatusSnapshotEntry, transition: &Transition) -> bool {
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
pub(super) fn next_entry(
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
        running_subagents: 0,
    })
}
