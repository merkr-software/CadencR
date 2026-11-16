use super::message_store::insert_message;
use super::WsSessionPersistence;
use sqlx::SqlitePool;
use tracing::error;

impl WsSessionPersistence {
    pub async fn persist_error_message_static(
        pool: &SqlitePool,
        session_id: i64,
        message: &str,
        parent_tool_use_id: Option<&str>,
    ) {
        if let Err(e) =
            Self::try_persist_error_message_static(pool, session_id, message, parent_tool_use_id)
                .await
        {
            error!(error = %e, session_db_id = session_id, "failed to persist error message");
        }
    }

    pub(crate) async fn try_persist_error_message_static(
        pool: &SqlitePool,
        session_id: i64,
        message: &str,
        parent_tool_use_id: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        insert_message()
            .pool(pool)
            .session_id(session_id)
            .role("assistant")
            .content(message)
            .message_type("error")
            .maybe_parent_tool_use_id(parent_tool_use_id)
            .call()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod session_error_messages_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Row, SqlitePool};

    async fn setup_test_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect test db");

        sqlx::query(
            "CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                message_type TEXT NOT NULL DEFAULT 'text',
                tool_name TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                tool_use_id TEXT,
                parent_tool_use_id TEXT,
                model TEXT DEFAULT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create messages");

        pool
    }

    #[tokio::test]
    async fn persists_assistant_error_message() {
        let pool = setup_test_db().await;

        WsSessionPersistence::persist_error_message_static(
            &pool,
            1,
            "OpenCode stream failed",
            Some("task-1"),
        )
        .await;

        let row = sqlx::query(
            "SELECT role, content, message_type, parent_tool_use_id FROM agent_messages WHERE session_id = 1",
        )
        .fetch_one(&pool)
        .await
        .expect("fetch error row");

        assert_eq!(row.get::<String, _>("role"), "assistant");
        assert_eq!(row.get::<String, _>("content"), "OpenCode stream failed");
        assert_eq!(row.get::<String, _>("message_type"), "error");
        assert_eq!(row.get::<String, _>("parent_tool_use_id"), "task-1");
    }
}
