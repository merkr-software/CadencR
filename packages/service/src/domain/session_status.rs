//! Single source of truth for agent status (idle / agent / question).
//!
//! See `.claude/plans/nous-avons-encore-des-idempotent-sundae.md` for the
//! design rationale. The short version:
//!
//! - Every status mutation goes through [`SessionStatusBroadcaster`], which
//!   applies it to the in-memory live book (`live`) and broadcasts it under one
//!   lock. Snapshots read that same book, so a (re)connecting device always
//!   sees exactly what connected devices were sent.
//! - The wire format is per-session: every event carries `session_id` so a
//!   feature with session and sub-agent activity doesn't collapse into a
//!   single ambiguous turn.
//! - [`derive_status_from_db`] is the canonical mapping from the persisted
//!   DB columns (`status`, `pending_*`) to the 3-value [`AgentStatus`]. It
//!   seeds the live book at boot, when gates persisted by the previous process
//!   must still show.
//!
//! No call site outside this module decides what an "agent is working" or
//! "agent is asking" event looks like — they emit a [`ProviderSignal`] and
//! the broker translates.
//!
//! Provider neutrality is enforced by [`RuntimeStreamEvent`]'s exhaustive
//! match in [`provider_signal_for_stream_event`]: adding a new variant
//! without a mapping is a compile error.
//!
//! Conforms to `.claude/rules/inline-rust-tests.md` (tests live below).

use serde::Serialize;

mod broadcaster;
mod journal;
mod live;
mod provider;
mod turn_clock;

pub use broadcaster::{restore_at_boot, SessionStatusBroadcaster, SessionStatusSnapshot};
use journal::close_stale_turns;
pub use journal::{transcript_block_message, TurnJournal};
pub use provider::{event_starts_fresh_turn, provider_signal_for_event, ProviderSignal};
pub use turn_clock::{CompletedTurn, TurnClock};

/// The canonical 3-value agent status, identical wire format on Rust and TS.
///
/// `Idle` — no active turn, no pending input.
/// `Agent` — runtime is producing output for this session.
/// `Question` — turn paused waiting for the user (carries a [`PendingKind`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle,
    Agent,
    Question,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DerivedSessionStatus {
    pub status: AgentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<PendingKind>,
}

impl DerivedSessionStatus {
    pub fn idle() -> Self {
        Self {
            status: AgentStatus::Idle,
            kind: None,
        }
    }

    pub fn agent() -> Self {
        Self {
            status: AgentStatus::Agent,
            kind: None,
        }
    }

    pub fn question(kind: PendingKind) -> Self {
        Self {
            status: AgentStatus::Question,
            kind: Some(kind),
        }
    }

    pub fn is_idle(self) -> bool {
        self.status == AgentStatus::Idle
    }
}

/// The two DB-backed user-input gate kinds. Mirrors
/// [`crate::domain::ws_session::persistence::PendingUserInputKind`] — kept
/// separate so this module has no dependency on `ws_session/persistence`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PendingKind {
    Permission,
    Question,
}

/// How a turn that just went idle ended, when that matters to the user. Only
/// failures are reported: a turn that completed normally carries no outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnOutcome {
    /// The turn stopped on an error (provider error, stream failure, dispatch
    /// failure) instead of completing.
    Failed,
}

/// Live status update broadcast to subscribed WS clients.
#[derive(Clone, Debug, Serialize)]
pub struct SessionStatusEvent {
    pub session_id: i64,
    pub feature_id: i64,
    pub status: AgentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<PendingKind>,
    /// Request id for the currently active user-input gate. This lets remote
    /// surfaces distinguish a resolved historical gate from a newer gate of
    /// the same kind on the same session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// The running turn's clock — start, time spent waiting on the user, the
    /// model the CLI reports — carried on every non-idle event and snapshot
    /// entry, so every client derives the same timer from one source of truth
    /// instead of each device's local clock-at-first-render. Empty on idle.
    #[serde(flatten)]
    pub clock: TurnClock,
    /// The provider is compacting the conversation's context. Lives here, not
    /// on the session socket, so a device that missed its end still reads the
    /// truth from the next event or snapshot.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub compacting: bool,
    /// Set on the `Idle` event that ends a failed turn, so clients can flag the
    /// conversation until someone opens it. Never part of a snapshot: like
    /// "unread", a failure is relative to who has seen it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TurnOutcome>,
    pub seq: u64,
    /// Server wall-clock when the event was emitted, so a client can measure
    /// its own clock's skew.
    pub server_now_ms: i64,
}

/// The persisted-DB columns we need to derive a status. Mirrors the
/// relevant subset of `AgentSessionRow`/`SessionRow` so this module has no
/// dependency on either struct.
#[derive(Clone, Copy, Debug)]
pub struct DbStatusInputs<'a> {
    /// `agent_sessions.status` — see persistence module for the legal set
    /// (`idle | running | paused | completed | error | waiting`). This
    /// module only branches on `running` vs. anything else.
    pub status_col: &'a str,
    pub pending_permission: bool,
    pub pending_question: bool,
}

/// Normalize a broadcast so only `Question` ever carries a kind.
fn derive_broadcast_status(status: AgentStatus, kind: Option<PendingKind>) -> DerivedSessionStatus {
    match status {
        AgentStatus::Idle => DerivedSessionStatus::idle(),
        AgentStatus::Agent => DerivedSessionStatus::agent(),
        AgentStatus::Question => DerivedSessionStatus { status, kind },
    }
}

/// Pure mapping from persisted state to the canonical 3-value status.
///
/// Pending columns win over `status_col` because a row that's persisted as
/// `paused` while a permission is pending is semantically a Question, not
/// an Idle. `running` without any pending column is Agent. Everything else
/// is Idle. This is the rule encoded in `get_feature_turn_states` today,
/// just normalized to 3 values.
pub fn derive_status_from_db(inputs: DbStatusInputs<'_>) -> DerivedSessionStatus {
    // Question wins. Order of precedence matches today's SQL `MAX(CASE …)`:
    // question > permission.
    if inputs.pending_question {
        return DerivedSessionStatus::question(PendingKind::Question);
    }
    if inputs.pending_permission {
        return DerivedSessionStatus::question(PendingKind::Permission);
    }
    if inputs.status_col == "running" {
        return DerivedSessionStatus::agent();
    }
    DerivedSessionStatus::idle()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db_inputs(status_col: &str) -> DbStatusInputs<'_> {
        DbStatusInputs {
            status_col,
            pending_permission: false,
            pending_question: false,
        }
    }

    #[test]
    fn agent_status_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&AgentStatus::Idle).unwrap(),
            "\"idle\""
        );
        assert_eq!(
            serde_json::to_string(&AgentStatus::Agent).unwrap(),
            "\"agent\""
        );
        assert_eq!(
            serde_json::to_string(&AgentStatus::Question).unwrap(),
            "\"question\""
        );
    }

    #[test]
    fn pending_kind_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&PendingKind::Permission).unwrap(),
            "\"permission\""
        );
        assert_eq!(
            serde_json::to_string(&PendingKind::Question).unwrap(),
            "\"question\""
        );
    }

    #[test]
    fn derive_running_with_no_pending_is_agent() {
        assert_eq!(
            derive_status_from_db(db_inputs("running")),
            DerivedSessionStatus::agent()
        );
    }

    #[test]
    fn derive_idle_default() {
        assert_eq!(
            derive_status_from_db(db_inputs("idle")),
            DerivedSessionStatus::idle()
        );
        assert_eq!(
            derive_status_from_db(db_inputs("paused")),
            DerivedSessionStatus::idle()
        );
        assert_eq!(
            derive_status_from_db(db_inputs("completed")),
            DerivedSessionStatus::idle()
        );
    }

    #[test]
    fn derive_pending_question_wins_over_running() {
        let mut input = db_inputs("running");
        input.pending_question = true;
        assert_eq!(
            derive_status_from_db(input),
            DerivedSessionStatus::question(PendingKind::Question)
        );
    }

    #[test]
    fn derive_pending_permission_wins_over_paused() {
        let mut input = db_inputs("paused");
        input.pending_permission = true;
        assert_eq!(
            derive_status_from_db(input),
            DerivedSessionStatus::question(PendingKind::Permission)
        );
    }

    #[test]
    fn derive_status_normalizes_broadcast_kind_to_one_shape() {
        assert_eq!(
            derive_broadcast_status(AgentStatus::Idle, Some(PendingKind::Permission)),
            DerivedSessionStatus::idle()
        );
        assert_eq!(
            derive_broadcast_status(AgentStatus::Agent, Some(PendingKind::Question)),
            DerivedSessionStatus::agent()
        );
        assert_eq!(
            derive_broadcast_status(AgentStatus::Question, Some(PendingKind::Permission)),
            DerivedSessionStatus::question(PendingKind::Permission)
        );
    }
}
