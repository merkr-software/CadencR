//! The model the CLI reports running a conversation's root agent, and the
//! transcript row that marks where it changed.

use sqlx::SqlitePool;

use super::WsSessionPersistence;
use crate::domain::sessions::models::AgentBlock;

/// Transcript row type of a model switch the CLI reported.
pub const MODEL_SWITCH_MESSAGE_TYPE: &str = "model_switch";

impl WsSessionPersistence {
    /// The model the CLI last reported for the session, across runtimes.
    pub async fn reported_model(
        pool: &SqlitePool,
        session_id: i64,
    ) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT reported_model FROM agent_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .map(Option::flatten)
    }

    /// Record `model` as the one the CLI now reports. When it replaces another
    /// one, also write the transcript's switch marker and return it, so every
    /// device and every later read of the history shows where it changed.
    pub async fn record_reported_model(
        pool: &SqlitePool,
        session_id: i64,
        previous: Option<&str>,
        model: &str,
    ) -> Result<Option<AgentBlock>, sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE agent_sessions SET reported_model = ? WHERE id = ?")
            .bind(model)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        let Some(previous) = previous.filter(|previous| *previous != model) else {
            tx.commit().await?;
            return Ok(None);
        };
        let content = serde_json::json!({ "from": previous, "to": model }).to_string();
        let (id, created_at): (i64, String) = sqlx::query_as(
            "INSERT INTO agent_messages (session_id, role, content, message_type) \
             VALUES (?, 'system', ?, ?) RETURNING id, created_at",
        )
        .bind(session_id)
        .bind(&content)
        .bind(MODEL_SWITCH_MESSAGE_TYPE)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(AgentBlock::system(
            format!("msg-{id}"),
            MODEL_SWITCH_MESSAGE_TYPE,
            content,
            Some(created_at),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool_with_session() -> (SqlitePool, i64) {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, reported_model TEXT); \
             CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, \
               session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, \
               message_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))); \
             INSERT INTO agent_sessions (id) VALUES (1);",
        )
        .execute(&pool)
        .await
        .unwrap();
        (pool, 1)
    }

    #[tokio::test]
    async fn the_first_report_marks_nothing_and_a_change_marks_the_switch() {
        let (pool, session) = pool_with_session().await;
        let first = WsSessionPersistence::record_reported_model(&pool, session, None, "opus")
            .await
            .unwrap();
        assert!(first.is_none());
        assert_eq!(
            WsSessionPersistence::reported_model(&pool, session)
                .await
                .unwrap()
                .as_deref(),
            Some("opus")
        );

        let same =
            WsSessionPersistence::record_reported_model(&pool, session, Some("opus"), "opus")
                .await
                .unwrap();
        assert!(same.is_none());

        let switch =
            WsSessionPersistence::record_reported_model(&pool, session, Some("opus"), "sonnet")
                .await
                .unwrap()
                .expect("a different model is a switch");
        assert_eq!(switch.type_, MODEL_SWITCH_MESSAGE_TYPE);
        let content: serde_json::Value = serde_json::from_str(&switch.content).unwrap();
        assert_eq!(
            content,
            serde_json::json!({ "from": "opus", "to": "sonnet" })
        );
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 1);
    }
}
