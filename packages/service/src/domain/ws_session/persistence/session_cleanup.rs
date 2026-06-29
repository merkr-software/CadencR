impl WsSessionPersistence {
    pub async fn delete_session_static(
        pool: &SqlitePool,
        session_id: i64,
    ) -> Result<(i64, Option<String>), String> {
        let session_row: Option<(i64, String, Option<String>)> = sqlx::query_as(
            "SELECT feature_id, status, agent_type FROM agent_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("failed to load session {session_id}: {error}"))?;

        let Some((feature_id, status, agent_type)) = session_row else {
            return Err(format!("session {session_id} not found"));
        };

        if status == "running" {
            return Err(format!("session {session_id} is still running"));
        }

        let mut tx = pool
            .begin()
            .await
            .map_err(|error| format!("failed to begin delete transaction: {error}"))?;

        sqlx::query("DELETE FROM session_runtime_ids WHERE session_id = ?")
            .bind(session_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("failed to delete archived session ids: {error}"))?;

        sqlx::query("DELETE FROM agent_messages WHERE session_id = ?")
            .bind(session_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("failed to delete agent messages: {error}"))?;

        sqlx::query("DELETE FROM agent_sessions WHERE id = ?")
            .bind(session_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("failed to delete session row: {error}"))?;

        tx.commit()
            .await
            .map_err(|error| format!("failed to commit delete transaction: {error}"))?;

        Ok((feature_id, agent_type))
    }

    pub async fn cleanup_stale_sessions(pool: &SqlitePool) {
        let now = chrono::Utc::now().to_rfc3339();
        if let Err(error) = sqlx::query(
            "UPDATE agent_sessions SET status = 'paused', ended_at = ? WHERE status = 'running'",
        )
        .bind(&now)
        .execute(pool)
        .await
        {
            error!(%error, "failed to clean up stale sessions");
        }
    }
}

#[cfg(test)]
mod session_cleanup_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_test_db() -> SqlitePool {
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
                context_window INTEGER NOT NULL DEFAULT 200000,
                started_at TEXT,
                ended_at TEXT
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
    async fn test_cleanup_stale_sessions() {
        let pool = setup_test_db().await;

        let mut p1 = WsSessionPersistence::new(pool.clone(), 1);
        let id1 = p1.find_or_create_session(None, None).await.unwrap();
        WsSessionPersistence::mark_running_static(&pool, id1).await;

        let mut p2 = WsSessionPersistence::new(pool.clone(), 2);
        p2.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::cleanup_stale_sessions(&pool).await;

        let rows: Vec<(String,)> = sqlx::query_as("SELECT status FROM agent_sessions ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(rows[0].0, "paused");
        assert_eq!(rows[1].0, "paused");
    }

    #[tokio::test]
    async fn test_delete_session_removes_all_rows() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();
        p.persist_user_message("hello").await;
        WsSessionPersistence::mark_paused_static(&pool, id).await;
        sqlx::query("INSERT INTO session_runtime_ids (session_id, runtime_session_id) VALUES (?, ?)")
            .bind(id)
            .bind("archived-session")
            .execute(&pool)
            .await
            .unwrap();
        let result = WsSessionPersistence::delete_session_static(&pool, id).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().0, 1);

        let session: Option<(i64,)> = sqlx::query_as("SELECT id FROM agent_sessions WHERE id = ?")
            .bind(id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(session.is_none());

        let messages: Vec<(i64,)> =
            sqlx::query_as("SELECT id FROM agent_messages WHERE session_id = ?")
                .bind(id)
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(messages.is_empty());

        let archived_ids: Vec<(i64,)> =
            sqlx::query_as("SELECT id FROM session_runtime_ids WHERE session_id = ?")
                .bind(id)
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(archived_ids.is_empty());

    }

    #[tokio::test]
    async fn test_delete_session_rejects_running() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();
        WsSessionPersistence::mark_running_static(&pool, id).await;

        let result = WsSessionPersistence::delete_session_static(&pool, id).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("running"));
    }

    #[tokio::test]
    async fn test_delete_session_not_found() {
        let pool = setup_test_db().await;
        let result = WsSessionPersistence::delete_session_static(&pool, 999).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[tokio::test]
    async fn test_delete_session_returns_agent_type() {
        let pool = setup_test_db().await;
        sqlx::query(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (1, 'session', 'paused')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let id: (i64,) = sqlx::query_as(
            "SELECT id FROM agent_sessions WHERE feature_id = 1 AND agent_type = 'session'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let result = WsSessionPersistence::delete_session_static(&pool, id.0).await;
        assert!(result.is_ok());
        let (feature_id, agent_type) = result.unwrap();
        assert_eq!(feature_id, 1);
        assert_eq!(agent_type.as_deref(), Some("session"));
    }
}
