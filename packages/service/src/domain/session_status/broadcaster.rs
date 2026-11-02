use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::broadcast;

use crate::domain::agents::adapter::RuntimeEvent;
use crate::domain::sessions::models::SessionStatusSnapshotEntry;

use super::journal::{JournalEntry, TurnJournal};
use super::live::{Applied, LiveStatusBook, Source, Transition};
use super::{
    derive_broadcast_status, event_starts_fresh_turn, provider_signal_for_event, AgentStatus,
    PendingKind, SessionStatusEvent, TurnOutcome,
};

/// The live status of every non-idle session, as sent to a (re)connecting
/// client. Read from the same book, under the same lock, as the events.
#[derive(Clone, Debug, Serialize)]
pub struct SessionStatusSnapshot {
    pub states: HashMap<String, SessionStatusSnapshotEntry>,
    /// Every later event has a higher seq; every earlier one is folded in.
    pub seq: u64,
    /// Identifies this server process: `seq` restarts at zero with every
    /// process, so a client compares seqs only within one epoch.
    pub epoch: i64,
    pub server_now_ms: i64,
}

/// The single writer for live agent status. Wraps a tokio broadcast channel
/// plus the [`LiveStatusBook`] every event is a transition of, so the
/// snapshot a client receives can never disagree with the events it gets.
///
/// Cloning is cheap (shared state). Stored on `AppState`.
#[derive(Clone, Debug)]
pub struct SessionStatusBroadcaster {
    tx: broadcast::Sender<SessionStatusEvent>,
    book: Arc<Mutex<LiveStatusBook>>,
    journal: Arc<TurnJournal>,
    epoch: i64,
}

impl SessionStatusBroadcaster {
    pub fn new(tx: broadcast::Sender<SessionStatusEvent>) -> Self {
        Self {
            tx,
            book: Arc::default(),
            journal: Arc::default(),
            epoch: now_ms(),
        }
    }

    /// Where the book's turn clocks and finished turns wait to be written.
    pub fn journal(&self) -> Arc<TurnJournal> {
        Arc::clone(&self.journal)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionStatusEvent> {
        self.tx.subscribe()
    }

    /// Load the sessions persisted as running or gated, at boot.
    pub fn seed(&self, entries: impl IntoIterator<Item = SessionStatusSnapshotEntry>) {
        let mut book = self.lock();
        for entry in entries {
            book.seed(entry);
        }
    }

    pub fn snapshot(&self) -> SessionStatusSnapshot {
        let book = self.lock();
        SessionStatusSnapshot {
            states: book.snapshot(),
            seq: book.seq(),
            epoch: self.epoch,
            server_now_ms: now_ms(),
        }
    }

    /// Whether a session has a live turn or a pending user-input gate.
    pub fn is_busy(&self, session_id: i64) -> bool {
        self.lock().is_busy(session_id)
    }

    /// Broadcast a status transition of the current turn. Returns the new
    /// seq, or `None` when nothing changed.
    pub fn broadcast(
        &self,
        session_id: i64,
        feature_id: i64,
        status: AgentStatus,
        kind: Option<PendingKind>,
    ) -> Option<u64> {
        let derived = derive_broadcast_status(status, kind);
        self.apply(Transition {
            kind: derived.kind,
            ..Transition::new(session_id, feature_id, derived.status)
        })
    }

    /// Broadcast a pending user-input gate with its stable request identity.
    pub fn broadcast_gate(
        &self,
        session_id: i64,
        feature_id: i64,
        kind: PendingKind,
        request_id: String,
    ) -> Option<u64> {
        self.apply(Transition {
            kind: Some(kind),
            request_id: Some(request_id),
            ..Transition::new(session_id, feature_id, AgentStatus::Question)
        })
    }

    /// Resolve a gate without clearing one published during answer delivery.
    pub fn broadcast_gate_resolved(
        &self,
        session_id: i64,
        feature_id: i64,
        request_id: &str,
        status: AgentStatus,
    ) -> Option<u64> {
        self.apply(Transition {
            source: Source::GateResponse {
                request_id: request_id.to_string(),
            },
            ..Transition::new(session_id, feature_id, status)
        })
    }

    /// An agent prompt was dispatched: an idle session starts a turn, a busy
    /// one keeps the turn it is in (the prompt steers it).
    pub fn broadcast_running(&self, session_id: i64, feature_id: i64) -> Option<u64> {
        self.apply(Transition::new(session_id, feature_id, AgentStatus::Agent))
    }

    /// A user shell command runs in the conversation. It keeps the session busy
    /// but is not an agent turn, so it gets no closing transcript line.
    pub fn broadcast_shell_running(&self, session_id: i64, feature_id: i64) -> Option<u64> {
        self.apply(Transition {
            summarized: false,
            ..Transition::new(session_id, feature_id, AgentStatus::Agent)
        })
    }

    /// Broadcast that the session went idle because its turn failed.
    pub fn broadcast_turn_failed(&self, session_id: i64, feature_id: i64) -> Option<u64> {
        self.apply(Transition {
            outcome: Some(TurnOutcome::Failed),
            ..Transition::new(session_id, feature_id, AgentStatus::Idle)
        })
    }

    /// Reflect a runtime event. Called for every event of a live turn, so
    /// repeats are absorbed here. Stream activity never answers a pending
    /// gate, and only an event that starts a turn brings an idle session back.
    pub fn stream_event(
        &self,
        session_id: i64,
        feature_id: i64,
        event: &RuntimeEvent,
    ) -> Option<u64> {
        let signal = provider_signal_for_event(event)?;
        self.apply(Transition {
            source: Source::Stream {
                starts_turn: event_starts_fresh_turn(event),
            },
            ..Transition::new(session_id, feature_id, signal.status())
        })
    }

    /// The CLI reports the model running the session's root agent. Shown on
    /// the "Working" line and recorded in the turn's closing line.
    pub fn observe_model(&self, session_id: i64, model: &str) -> Option<u64> {
        let mut book = self.lock();
        let applied = book.observe_model(session_id, model, now_ms())?;
        Some(self.publish(applied))
    }

    /// The provider started or finished compacting the session's context.
    pub fn set_compacting(&self, session_id: i64, active: bool) -> Option<u64> {
        let mut book = self.lock();
        let applied = book.set_compacting(session_id, active, now_ms())?;
        Some(self.publish(applied))
    }

    /// Mark idle every tracked session whose row is gone (its feature or
    /// project was deleted): no turn will ever end for it to say so.
    pub async fn forget_deleted_sessions(&self, pool: &SqlitePool) -> Result<(), sqlx::Error> {
        let tracked = self.lock().tracked();
        if tracked.is_empty() {
            return Ok(());
        }
        let ids = serde_json::to_string(&tracked.iter().map(|(id, _)| id).collect::<Vec<_>>())
            .expect("session ids serialize");
        let existing: HashSet<i64> = sqlx::query_scalar(
            "SELECT id FROM agent_sessions WHERE id IN (SELECT value FROM json_each(?))",
        )
        .bind(ids)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
        for (session_id, feature_id) in tracked {
            if !existing.contains(&session_id) {
                self.broadcast(session_id, feature_id, AgentStatus::Idle, None);
            }
        }
        Ok(())
    }

    /// Apply and send under one lock, so the channel order is the seq order.
    /// Send errors are intentionally ignored — `broadcast::Sender::send` only
    /// fails when there are no receivers, the normal state with no client.
    fn apply(&self, transition: Transition) -> Option<u64> {
        let mut book = self.lock();
        let applied = book.apply(&transition, now_ms())?;
        Some(self.publish(applied))
    }

    /// Queue what the change persists and broadcast it. Runs under the book
    /// lock, so the journal receives changes in `seq` order.
    fn publish(&self, applied: Applied) -> u64 {
        let Applied {
            event,
            completed,
            persist,
        } = applied;
        if let Some(clock) = persist {
            self.journal.push(JournalEntry::Clock {
                session_id: event.session_id,
                clock,
            });
        }
        if let Some(turn) = completed {
            self.journal.push(JournalEntry::Completed(turn));
        }
        let seq = event.seq;
        let _ = self.tx.send(event);
        seq
    }

    fn lock(&self) -> MutexGuard<'_, LiveStatusBook> {
        // The book is plain data mutated in one step; a panic elsewhere can't
        // leave it half-written.
        self.book
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Bring the status book back at boot, before any client can connect: close
/// the turns a stopped service cut off (they ended with it), seed the gates and
/// turn clocks it persisted, then start writing the book's changes.
pub async fn restore_at_boot(state: &crate::app_state::AppState) -> anyhow::Result<()> {
    let closed = super::close_stale_turns(&state.write_pool)
        .await
        .map_err(|error| anyhow::anyhow!("failed to close stale turns: {error}"))?;
    if closed > 0 {
        tracing::info!(closed, "closed turns a stopped service cut off");
    }
    let persisted =
        crate::domain::sessions::repository::get_session_status_snapshot(&state.read_pool)
            .await
            .map_err(|error| anyhow::anyhow!("failed to seed session statuses: {error}"))?;
    let broadcaster = &state.session_status_tx;
    broadcaster.seed(persisted.into_values());
    broadcaster
        .journal()
        .spawn_writer(state.write_pool.clone(), state.ws_feature_senders.clone());
    Ok(())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeEventKind, RuntimeEventMetadata, RuntimeStreamEvent,
    };

    fn broadcaster() -> SessionStatusBroadcaster {
        let (tx, _) = broadcast::channel(16);
        SessionStatusBroadcaster::new(tx)
    }

    fn message_start() -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::StreamEvent {
                event: RuntimeStreamEvent::MessageStart {
                    model: None,
                    input_tokens: None,
                },
                parent_tool_use_id: None,
            },
        )
    }

    #[test]
    fn a_turn_the_cli_opens_itself_records_its_model_once_it_is_open() {
        let broadcaster = broadcaster();
        // The stream reader reports the model before the event opens the turn:
        // an idle session has no clock to carry it, so it reports it again.
        assert!(broadcaster.observe_model(7, "opus").is_none());
        assert!(broadcaster.set_compacting(7, true).is_none());

        broadcaster.stream_event(7, 8, &message_start());
        assert!(broadcaster.observe_model(7, "opus").is_some());
        assert!(broadcaster.observe_model(7, "opus").is_none());

        let entry = &broadcaster.snapshot().states["7"];
        assert_eq!(entry.clock.model.as_deref(), Some("opus"));
    }

    #[tokio::test]
    async fn failed_turn_goes_idle_with_a_failed_outcome() {
        let broadcaster = broadcaster();
        let mut rx = broadcaster.subscribe();

        broadcaster.broadcast(7, 8, AgentStatus::Agent, None);
        broadcaster.broadcast(7, 8, AgentStatus::Idle, None);
        broadcaster.broadcast_turn_failed(7, 8);

        rx.recv().await.unwrap();
        let completed = rx.recv().await.unwrap();
        assert_eq!(completed.outcome, None);
        assert!(serde_json::to_value(&completed)
            .unwrap()
            .get("outcome")
            .is_none());
        let failed = rx.recv().await.unwrap();
        assert_eq!(failed.status, AgentStatus::Idle);
        assert_eq!(failed.outcome, Some(TurnOutcome::Failed));
        assert_eq!(serde_json::to_value(&failed).unwrap()["outcome"], "failed");
        assert!(failed.seq > completed.seq);
    }

    #[tokio::test]
    async fn gate_broadcast_carries_request_identity_and_the_turn_start() {
        let broadcaster = broadcaster();
        let mut rx = broadcaster.subscribe();

        broadcaster.broadcast_running(7, 8);
        broadcaster.broadcast_gate(7, 8, PendingKind::Permission, "req-42".into());

        let started = rx.recv().await.unwrap();
        let event = rx.recv().await.unwrap();
        assert_eq!(event.status, AgentStatus::Question);
        assert_eq!(event.kind, Some(PendingKind::Permission));
        assert_eq!(event.request_id.as_deref(), Some("req-42"));
        assert_eq!(
            event.clock.turn_started_at_ms,
            started.clock.turn_started_at_ms
        );
    }

    #[test]
    fn a_delayed_answer_cannot_overwrite_the_next_questions_status() {
        let broadcaster = broadcaster();
        broadcaster.broadcast_gate(7, 8, PendingKind::Question, "first".into());
        // The next form arrives while the previous answer is being persisted.
        broadcaster.broadcast_gate(7, 8, PendingKind::Question, "second".into());
        let mut rx = broadcaster.subscribe();
        assert!(broadcaster
            .broadcast_gate_resolved(7, 8, "first", AgentStatus::Agent)
            .is_none());
        assert!(rx.try_recv().is_err());
        let pending = &broadcaster.snapshot().states["7"];
        assert_eq!(pending.status, AgentStatus::Question);
        assert_eq!(pending.request_id.as_deref(), Some("second"));
        assert!(broadcaster
            .broadcast_gate_resolved(7, 8, "second", AgentStatus::Agent)
            .is_some());
        assert_eq!(
            broadcaster.snapshot().states["7"].status,
            AgentStatus::Agent
        );
    }

    #[tokio::test]
    async fn stream_repeats_are_absorbed_and_the_snapshot_folds_the_events() {
        let broadcaster = broadcaster();
        let mut rx = broadcaster.subscribe();

        broadcaster.broadcast_running(7, 8);
        broadcaster.stream_event(7, 8, &message_start());

        let event = rx.recv().await.unwrap();
        assert!(rx.try_recv().is_err(), "stream repeat must be absorbed");
        let snapshot = broadcaster.snapshot();
        assert_eq!(snapshot.seq, event.seq);
        assert_eq!(
            snapshot.states["7"].clock.turn_started_at_ms,
            event.clock.turn_started_at_ms
        );
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["epoch"], broadcaster.epoch);
        assert!(wire["server_now_ms"].as_i64().unwrap() > 0);
    }

    #[tokio::test]
    async fn model_and_compaction_reach_every_device_and_idle_clears_them() {
        let broadcaster = broadcaster();
        broadcaster.broadcast_running(7, 8);
        let mut rx = broadcaster.subscribe();

        broadcaster.observe_model(7, "claude-opus-5-5");
        broadcaster.set_compacting(7, true);
        let reported = rx.recv().await.unwrap();
        assert_eq!(reported.clock.model.as_deref(), Some("claude-opus-5-5"));
        let compacting = rx.recv().await.unwrap();
        assert!(compacting.compacting);
        assert_eq!(
            serde_json::to_value(&compacting).unwrap()["compacting"],
            true
        );
        assert!(broadcaster.snapshot().states["7"].compacting);

        broadcaster.broadcast(7, 8, AgentStatus::Idle, None);
        let idle = rx.recv().await.unwrap();
        assert!(!idle.compacting);
        assert!(serde_json::to_value(&idle)
            .unwrap()
            .get("compacting")
            .is_none());
        assert!(broadcaster.snapshot().states.is_empty());
    }

    #[tokio::test]
    async fn deleted_sessions_are_forgotten() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_sessions (id) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        let broadcaster = broadcaster();
        broadcaster.broadcast_running(1, 10);
        broadcaster.broadcast_running(2, 20);
        let mut rx = broadcaster.subscribe();

        broadcaster.forget_deleted_sessions(&pool).await.unwrap();

        let event = rx.recv().await.unwrap();
        assert_eq!((event.session_id, event.status), (2, AgentStatus::Idle));
        assert!(rx.try_recv().is_err());
        assert_eq!(broadcaster.snapshot().states.len(), 1);
    }
}
