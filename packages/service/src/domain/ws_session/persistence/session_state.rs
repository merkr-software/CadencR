//! Persist lifecycle status and usage counters for a session record.

use super::WsSessionPersistence;
use sqlx::SqlitePool;
use tracing::error;

impl WsSessionPersistence {
    pub async fn reopen_session(
        &self,
        id: i64,
        permission_mode: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let result = sqlx::query(
            "UPDATE agent_sessions
             SET status = CASE WHEN status = 'running' THEN status ELSE 'paused' END,
                 permission_mode = COALESCE(?, permission_mode)
             WHERE id = ?",
        )
        .bind(permission_mode)
        .bind(id)
        .execute(&self.write_pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(sqlx::Error::RowNotFound);
        }
        Ok(())
    }

    pub async fn mark_paused_static(pool: &SqlitePool, session_id: i64) {
        let now = chrono::Utc::now().to_rfc3339();
        if let Err(e) =
            sqlx::query("UPDATE agent_sessions SET status = 'paused', ended_at = ? WHERE id = ?")
                .bind(&now)
                .bind(session_id)
                .execute(pool)
                .await
        {
            error!(error = %e, session_db_id = session_id, "failed to mark session paused");
        }
    }

    pub async fn mark_running_static(pool: &SqlitePool, session_id: i64) {
        if let Err(e) = sqlx::query(
            "UPDATE agent_sessions SET status = 'running', ended_at = NULL WHERE id = ?",
        )
        .bind(session_id)
        .execute(pool)
        .await
        {
            error!(error = %e, session_db_id = session_id, "failed to mark session running");
        }
    }

    pub async fn mark_completed_static(pool: &SqlitePool, session_id: i64) {
        if let Err(e) = Self::try_mark_completed_static(pool, session_id).await {
            error!(error = %e, session_db_id = session_id, "failed to mark session completed");
        }
    }

    pub(crate) async fn try_mark_completed_static(
        pool: &SqlitePool,
        session_id: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE agent_sessions SET status = 'completed', ended_at = ? WHERE id = ?")
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(session_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn mark_error_static(pool: &SqlitePool, session_id: i64) {
        let now = chrono::Utc::now().to_rfc3339();
        if let Err(e) =
            sqlx::query("UPDATE agent_sessions SET status = 'error', ended_at = ? WHERE id = ?")
                .bind(&now)
                .bind(session_id)
                .execute(pool)
                .await
        {
            error!(error = %e, session_db_id = session_id, "failed to mark session error");
        }
    }

    pub async fn update_token_usage(
        pool: &SqlitePool,
        session_id: i64,
        input_tokens: u64,
        output_tokens: u64,
    ) {
        let _ = sqlx::query(
            "UPDATE agent_sessions SET input_tokens = ?, output_tokens = ? WHERE id = ?",
        )
        .bind(input_tokens as i64)
        .bind(output_tokens as i64)
        .bind(session_id)
        .execute(pool)
        .await;
    }

    /// Write `context_window` to the session row. Pass `None` to clear the
    /// value (unknown — until the provider reports one). The DB column is
    /// nullable; callers that try to show a bar must treat NULL as "no data".
    pub async fn update_context_window(
        pool: &SqlitePool,
        session_id: i64,
        context_window: Option<u64>,
    ) {
        let bound = context_window.and_then(|cw| i64::try_from(cw).ok());
        let _ = sqlx::query("UPDATE agent_sessions SET context_window = ? WHERE id = ?")
            .bind(bound)
            .bind(session_id)
            .execute(pool)
            .await;
    }

    #[cfg(test)]
    pub async fn mark_completed(&self) {
        let Some(session_id) = self.session_db_id else {
            return;
        };
        Self::mark_completed_static(&self.write_pool, session_id).await;
    }
}

#[cfg(test)]
pub(super) mod session_state_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    pub(in super::super) async fn setup_test_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();

        sqlx::query(
            r#"CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feature_id INTEGER NOT NULL,
                agent_type TEXT NOT NULL DEFAULT 'session',
                status TEXT NOT NULL DEFAULT 'idle',
                runtime_provider TEXT,
                runtime_session_id TEXT,

                model TEXT,
                profile TEXT,
                permission_mode TEXT,
                codex_permission_mode TEXT DEFAULT 'default',
                has_file_changes INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                context_window INTEGER,
                started_at TEXT,
                ended_at TEXT,
                thinking_effort TEXT,
                fast_mode INTEGER NOT NULL DEFAULT 0
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                role TEXT,
                content TEXT NOT NULL DEFAULT '',
                message_type TEXT NOT NULL DEFAULT 'text',
                tool_name TEXT,
                tool_use_id TEXT,
                parent_tool_use_id TEXT,
                model TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"CREATE TABLE session_runtime_ids (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                runtime_session_id TEXT NOT NULL,
                created_at TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        pool
    }

    #[tokio::test]
    async fn test_mark_paused_static() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::mark_paused_static(&pool, id).await;

        let row: (String,) = sqlx::query_as("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, "paused");
    }

    #[tokio::test]
    async fn test_mark_running_static() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::mark_paused_static(&pool, id).await;
        WsSessionPersistence::mark_running_static(&pool, id).await;

        let row: (String, Option<String>) =
            sqlx::query_as("SELECT status, ended_at FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, "running");
        assert!(row.1.is_none());
    }

    #[tokio::test]
    async fn test_mark_completed_static() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::mark_completed_static(&pool, id).await;

        let row: (String,) = sqlx::query_as("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, "completed");
    }

    #[tokio::test]
    async fn test_update_token_usage() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::update_token_usage(&pool, id, 1500, 300).await;

        let row: (i64, i64) =
            sqlx::query_as("SELECT input_tokens, output_tokens FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, 1500);
        assert_eq!(row.1, 300);
    }

    #[tokio::test]
    async fn test_mark_completed_instance_delegates_to_static() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        p.find_or_create_session(None, None).await;

        p.mark_completed().await;

        let row: (String,) = sqlx::query_as("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(p.session_db_id.unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, "completed");
    }

    #[tokio::test]
    async fn test_update_context_window_stores_known_value() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::update_context_window(&pool, id, Some(1_000_000)).await;

        let row: (Option<i64>,) =
            sqlx::query_as("SELECT context_window FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, Some(1_000_000));
    }

    #[tokio::test]
    async fn test_update_context_window_clears_to_null() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::update_context_window(&pool, id, Some(200_000)).await;
        WsSessionPersistence::update_context_window(&pool, id, None).await;

        let row: (Option<i64>,) =
            sqlx::query_as("SELECT context_window FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, None);
    }

    #[tokio::test]
    async fn try_mark_completed_reports_failed_write_and_preserves_running_status() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, status TEXT, ended_at TEXT); INSERT INTO agent_sessions VALUES (7, 'running', NULL); CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON agent_sessions BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END;")
            .execute(&pool).await.unwrap();
        assert!(WsSessionPersistence::try_mark_completed_static(&pool, 7)
            .await
            .is_err());
        let row: (String, Option<String>) =
            sqlx::query_as("SELECT status, ended_at FROM agent_sessions WHERE id = 7")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row, ("running".into(), None));
    }
}
