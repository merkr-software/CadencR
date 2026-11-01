//! Writes what the live status book decides about turns to the database.
//!
//! The book is synchronous (it stamps `seq` under a plain mutex), so it queues
//! its writes here instead of awaiting them: a turn clock to mirror on
//! `agent_sessions` when a transition moved it, and the closing transcript line
//! of every finished turn. One writer drains the queue in order. A prompt
//! flushes it before persisting its own user message, so a turn's closing line
//! always sits before the prompt that opens the next one.

use std::sync::Mutex;

use axum::extract::ws::Message;
use sqlx::SqlitePool;

use crate::domain::sessions::models::AgentBlock;
use crate::domain::ws_session::protocol::{
    SessionTranscriptBlockPayload, WsEnvelope, WsSessionEvent,
};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use super::turn_clock::{CompletedTurn, TurnClock};

/// Transcript row type of a finished turn's closing line.
pub const TURN_SUMMARY_MESSAGE_TYPE: &str = "turn_summary";

#[derive(Debug)]
pub(super) enum JournalEntry {
    Clock {
        session_id: i64,
        clock: Option<TurnClock>,
    },
    Completed(CompletedTurn),
}

/// The queue between the status book and the database.
#[derive(Debug, Default)]
pub struct TurnJournal {
    queue: Mutex<Vec<JournalEntry>>,
    wake: tokio::sync::Notify,
    /// Held while entries are written, so a flush returns only once every
    /// entry queued before it is in the database.
    writing: tokio::sync::Mutex<()>,
}

impl TurnJournal {
    pub(super) fn push(&self, entry: JournalEntry) {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(entry);
        self.wake.notify_one();
    }

    /// Write every queued entry, in order.
    pub async fn flush(&self, pool: &SqlitePool, senders: &WsFeatureSenderRegistry) {
        let _writing = self.writing.lock().await;
        let entries = std::mem::take(
            &mut *self
                .queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        for entry in entries {
            match entry {
                JournalEntry::Clock { session_id, clock } => {
                    write_clock(pool, session_id, clock.as_ref()).await;
                }
                JournalEntry::Completed(turn) => record_turn(pool, senders, &turn).await,
            }
        }
    }

    /// Drain the queue whenever the book adds to it, for the process lifetime.
    pub fn spawn_writer(
        self: std::sync::Arc<Self>,
        pool: SqlitePool,
        senders: WsFeatureSenderRegistry,
    ) {
        tokio::spawn(async move {
            loop {
                self.wake.notified().await;
                self.flush(&pool, &senders).await;
            }
        });
    }
}

async fn write_clock(pool: &SqlitePool, session_id: i64, clock: Option<&TurnClock>) {
    let models = clock
        .filter(|clock| !clock.models.is_empty())
        .map(|clock| serde_json::to_string(&clock.models).expect("model ids serialize"));
    let result = sqlx::query(
        "UPDATE agent_sessions SET turn_started_at_ms = ?, turn_waiting_ms = ?, \
         turn_waiting_since_ms = ?, turn_models = ? WHERE id = ?",
    )
    .bind(clock.and_then(|clock| clock.turn_started_at_ms))
    .bind(clock.map_or(0, |clock| clock.waiting_ms))
    .bind(clock.and_then(|clock| clock.waiting_since_ms))
    .bind(models)
    .bind(session_id)
    .execute(pool)
    .await;
    if let Err(error) = result {
        tracing::error!(session_id, %error, "failed to persist the turn clock");
    }
}

/// Persist the turn's closing line and show it to every device viewing the
/// conversation. A failed write still shows the line live — the turn did run —
/// under an id no persisted row can take.
async fn record_turn(pool: &SqlitePool, senders: &WsFeatureSenderRegistry, turn: &CompletedTurn) {
    let content = turn.summary_content();
    let row: Result<(i64, String), sqlx::Error> = sqlx::query_as(
        "INSERT INTO agent_messages (session_id, role, content, message_type) \
         SELECT ?, 'system', ?, ? WHERE EXISTS (SELECT 1 FROM agent_sessions WHERE id = ?) \
         RETURNING id, created_at",
    )
    .bind(turn.session_id)
    .bind(&content)
    .bind(TURN_SUMMARY_MESSAGE_TYPE)
    .bind(turn.session_id)
    .fetch_one(pool)
    .await;
    let (id, created_at) = match row {
        Ok((id, created_at)) => (format!("msg-{id}"), Some(created_at)),
        // The conversation was deleted while its turn ended: nothing to show.
        Err(sqlx::Error::RowNotFound) => return,
        Err(error) => {
            tracing::error!(session_id = turn.session_id, %error, "failed to persist the turn summary");
            (
                format!("turn-{}-{}", turn.session_id, turn.started_at_ms),
                None,
            )
        }
    };
    let block = AgentBlock::system(id, TURN_SUMMARY_MESSAGE_TYPE, content, created_at);
    send_transcript_block(senders, turn.feature_id, turn.session_id, block).await;
}

/// The live event carrying a system row Cadencr wrote to the transcript.
pub fn transcript_block_message(session_id: i64, block: AgentBlock) -> Message {
    let envelope = WsEnvelope::session_event(&WsSessionEvent::TranscriptBlock(
        SessionTranscriptBlockPayload {
            session_id: session_id.to_string(),
            block,
        },
    ))
    .expect("session event payload should serialize");
    Message::Text(String::from(envelope).into())
}

/// Show a persisted system row to every device viewing `feature_id`.
async fn send_transcript_block(
    senders: &WsFeatureSenderRegistry,
    feature_id: i64,
    session_id: i64,
    block: AgentBlock,
) {
    senders
        .broadcast_all(feature_id, &transcript_block_message(session_id, block))
        .await;
}

/// Close the clocks a stopped service left open, before the book is seeded.
///
/// A turn that was running when the service went away is over: its CLI died
/// with it. It gets its closing line, ended at the conversation's last
/// activity. A turn still waiting on its user keeps its clock — the book
/// resumes it.
pub async fn close_stale_turns(pool: &SqlitePool) -> Result<usize, sqlx::Error> {
    let rows: Vec<(i64, i64, i64, i64, Option<i64>, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT s.id, s.feature_id, s.turn_started_at_ms, s.turn_waiting_ms, \
                    s.turn_waiting_since_ms, s.turn_models, \
                    (SELECT CAST(strftime('%s', m.created_at) AS INTEGER) * 1000 \
                       FROM agent_messages m WHERE m.session_id = s.id \
                      ORDER BY m.id DESC LIMIT 1) \
               FROM agent_sessions s \
              WHERE s.turn_started_at_ms IS NOT NULL \
                AND s.status <> 'running' \
                AND s.pending_questions IS NULL \
                AND s.pending_permission IS NULL",
    )
    .fetch_all(pool)
    .await?;
    let senders = WsFeatureSenderRegistry::new();
    for (session_id, feature_id, started, waiting, waiting_since, models, last_activity) in &rows {
        let models = crate::domain::sessions::repository::parse_turn_models(models.as_deref());
        let clock = TurnClock::restored(Some(*started), *waiting, *waiting_since, models);
        let ended_at = last_activity.unwrap_or(*started);
        if let Some(turn) = clock.finish(*session_id, *feature_id, ended_at) {
            record_turn(pool, &senders, &turn).await;
        }
        write_clock(pool, *session_id, None).await;
    }
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session_status::{AgentStatus, SessionStatusBroadcaster};

    async fn pool_with_session() -> (SqlitePool, i64) {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, \
               feature_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running', \
               pending_questions TEXT, pending_permission TEXT, turn_started_at_ms INTEGER, \
               turn_waiting_ms INTEGER NOT NULL DEFAULT 0, turn_waiting_since_ms INTEGER, \
               turn_models TEXT, reported_model TEXT); \
             CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, \
               session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, \
               message_type TEXT NOT NULL, \
               created_at TEXT NOT NULL DEFAULT (datetime('now')));",
        )
        .execute(&pool)
        .await
        .unwrap();
        let session: i64 =
            sqlx::query_scalar("INSERT INTO agent_sessions (feature_id) VALUES (1) RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        (pool, session)
    }

    async fn clock_row(pool: &SqlitePool, session: i64) -> (Option<i64>, i64, Option<String>) {
        sqlx::query_as(
            "SELECT turn_started_at_ms, turn_waiting_ms, turn_models FROM agent_sessions WHERE id = ?",
        )
        .bind(session)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_turn_mirrors_its_clock_and_ends_with_a_summary_line() {
        let (pool, session) = pool_with_session().await;
        let senders = WsFeatureSenderRegistry::new();
        let broadcaster = SessionStatusBroadcaster::new(tokio::sync::broadcast::channel(8).0);
        let journal = broadcaster.journal();

        broadcaster.broadcast_running(session, 1);
        broadcaster.observe_model(session, "claude-opus-5-5");
        journal.flush(&pool, &senders).await;
        let (started, _, models) = clock_row(&pool, session).await;
        assert!(started.is_some());
        assert_eq!(models.as_deref(), Some(r#"["claude-opus-5-5"]"#));

        broadcaster.broadcast(session, 1, AgentStatus::Idle, None);
        journal.flush(&pool, &senders).await;
        assert_eq!(clock_row(&pool, session).await, (None, 0, None));
        let (message_type, content): (String, String) =
            sqlx::query_as("SELECT message_type, content FROM agent_messages WHERE session_id = ?")
                .bind(session)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(message_type, TURN_SUMMARY_MESSAGE_TYPE);
        let content: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(content["models"], serde_json::json!(["claude-opus-5-5"]));
    }

    #[tokio::test]
    async fn a_turn_a_restart_cut_off_is_closed_at_its_last_activity() {
        let (pool, session) = pool_with_session().await;
        sqlx::query(
            "UPDATE agent_sessions SET status = 'paused', turn_started_at_ms = 1000, \
             turn_waiting_ms = 0, turn_models = '[\"gpt-5.5\"]' WHERE id = ?",
        )
        .bind(session)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_messages (session_id, role, content, message_type, created_at) \
             VALUES (?, 'assistant', 'hi', 'text', '1970-01-01 00:00:09')",
        )
        .bind(session)
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(close_stale_turns(&pool).await.unwrap(), 1);
        let content: String = sqlx::query_scalar(
            "SELECT content FROM agent_messages WHERE session_id = ? AND message_type = 'turn_summary'",
        )
        .bind(session)
        .fetch_one(&pool)
        .await
        .unwrap();
        let content: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(content["totalMs"], 8_000);
        assert_eq!(clock_row(&pool, session).await.0, None);
        assert_eq!(close_stale_turns(&pool).await.unwrap(), 0);
    }
}
