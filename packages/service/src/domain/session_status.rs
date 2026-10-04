//! Single source of truth for agent status (idle / agent / question).
//!
//! See `.claude/plans/nous-avons-encore-des-idempotent-sundae.md` for the
//! design rationale. The short version:
//!
//! - Every status mutation goes through [`SessionStatusBroadcaster::broadcast`].
//! - The wire format is per-session: every event carries `session_id` so a
//!   feature with session and sub-agent activity doesn't collapse into a
//!   single ambiguous turn.
//! - [`derive_status_from_db`] is the canonical mapping from the persisted
//!   DB columns (`status`, `pending_*`) to the 3-value [`AgentStatus`]. It
//!   is what the snapshot path uses to hydrate clients on (re)connect.
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

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::broadcast;

mod provider;

#[cfg(test)]
pub use provider::ProviderSignal;
pub use provider::{event_starts_fresh_turn, provider_signal_for_event};

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

/// Live status update broadcast to subscribed WS clients.
#[derive(Clone, Debug, Serialize, bon::Builder)]
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
    /// Only an explicit successful response resolves this gate on other devices.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_request_id: Option<String>,
    /// Server wall-clock (epoch ms) when the current turn started. Carried on
    /// `Agent` events (and in the snapshot for a running session) so every
    /// connected client anchors its elapsed timer to one source of truth
    /// instead of each device's local clock-at-first-render.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_started_at_ms: Option<i64>,
    #[builder(default)]
    pub seq: u64,
}

/// The single writer for live agent status. Wraps a tokio broadcast channel
/// + a monotonic seq counter so the frontend can reject out-of-order events.
///
/// Cloning is cheap (`broadcast::Sender` and `Arc<AtomicU64>` both share
/// state). Stored on `AppState`; every status mutation goes through
/// [`Self::broadcast`].
#[derive(Clone, Debug)]
pub struct SessionStatusBroadcaster {
    tx: broadcast::Sender<SessionStatusEvent>,
    seq: Arc<AtomicU64>,
}

impl SessionStatusBroadcaster {
    pub fn new(tx: broadcast::Sender<SessionStatusEvent>, seq: Arc<AtomicU64>) -> Self {
        Self { tx, seq }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionStatusEvent> {
        self.tx.subscribe()
    }

    /// Read the counter without advancing it. Used to stamp snapshot
    /// payloads so a snapshot built at instant T tells the frontend
    /// "every event with seq > T is yours, every event with seq <= T was
    /// folded into this snapshot".
    pub fn current_seq(&self) -> u64 {
        self.seq.load(Ordering::Relaxed)
    }

    /// Stamp a fresh seq, send the event. Returns the new seq.
    ///
    /// Send errors are intentionally swallowed — `broadcast::Sender::send`
    /// only fails when there are no receivers, which is the normal state
    /// when no client is connected.
    pub fn broadcast(
        &self,
        session_id: i64,
        feature_id: i64,
        status: AgentStatus,
        kind: Option<PendingKind>,
    ) -> u64 {
        let derived = derive_broadcast_status(status, kind);
        self.broadcast_inner(
            session_id,
            feature_id,
            derived.status,
            derived.kind,
            None,
            None,
        )
    }

    /// Broadcast a pending user-input gate with its stable request identity.
    pub fn broadcast_gate(
        &self,
        session_id: i64,
        feature_id: i64,
        kind: PendingKind,
        request_id: String,
    ) -> u64 {
        self.broadcast_inner(
            session_id,
            feature_id,
            AgentStatus::Question,
            Some(kind),
            Some(request_id),
            None,
        )
    }

    /// Broadcast that a turn has started, carrying the server-stamped start
    /// time so all clients render a synchronized elapsed timer.
    pub fn broadcast_running_with_start(
        &self,
        session_id: i64,
        feature_id: i64,
        turn_started_at_ms: i64,
    ) -> u64 {
        self.broadcast_inner(
            session_id,
            feature_id,
            AgentStatus::Agent,
            None,
            None,
            Some(turn_started_at_ms),
        )
    }

    fn broadcast_inner(
        &self,
        session_id: i64,
        feature_id: i64,
        status: AgentStatus,
        kind: Option<PendingKind>,
        request_id: Option<String>,
        turn_started_at_ms: Option<i64>,
    ) -> u64 {
        self.broadcast_event(SessionStatusEvent {
            session_id,
            feature_id,
            status,
            kind,
            request_id,
            resolved_request_id: None,
            turn_started_at_ms,
            seq: 0,
        })
    }

    pub(crate) fn broadcast_event(&self, mut event: SessionStatusEvent) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        event.seq = seq;
        let _ = self.tx.send(event);
        seq
    }
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

/// Pure mapping from persisted state to the canonical 3-value status.
///
/// Pending columns win over `status_col` because a row that's persisted as
/// `paused` while a permission is pending is semantically a Question, not
/// an Idle. `running` without any pending column is Agent. Everything else
/// is Idle. This is the rule encoded in `get_feature_turn_states` today,
/// just normalized to 3 values.
fn derive_broadcast_status(status: AgentStatus, kind: Option<PendingKind>) -> DerivedSessionStatus {
    match status {
        AgentStatus::Idle => DerivedSessionStatus::idle(),
        AgentStatus::Agent => DerivedSessionStatus::agent(),
        AgentStatus::Question => DerivedSessionStatus { status, kind },
    }
}

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

    #[tokio::test]
    async fn gate_broadcast_carries_request_identity() {
        let (tx, _) = tokio::sync::broadcast::channel(4);
        let broadcaster = SessionStatusBroadcaster::new(tx, Arc::new(AtomicU64::new(0)));
        let mut rx = broadcaster.subscribe();

        broadcaster.broadcast_gate(7, 8, PendingKind::Permission, "req-42".into());

        let event = rx.recv().await.unwrap();
        assert_eq!(event.status, AgentStatus::Question);
        assert_eq!(event.kind, Some(PendingKind::Permission));
        assert_eq!(event.request_id.as_deref(), Some("req-42"));
    }
}
