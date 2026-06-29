impl WsSessionPersistence {
    /// Archive the current session id and clear the active runtime ids.
    pub async fn archive_and_clear(
        pool: &SqlitePool,
        session_id: i64,
        known_cli_sid: Option<&str>,
    ) {
        let cli_sid = match known_cli_sid {
            Some(sid) => Some(sid.to_string()),
            None => sqlx::query_as::<_, (Option<String>,)>(
                "SELECT runtime_session_id FROM agent_sessions WHERE id = ?",
            )
            .bind(session_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .and_then(|(sid,)| sid),
        };

        if let Some(ref cli_sid) = cli_sid {
            let now = chrono::Utc::now().to_rfc3339();
            let _ = sqlx::query(
                "INSERT INTO session_runtime_ids (session_id, runtime_session_id, created_at) VALUES (?, ?, ?)",
            )
            .bind(session_id)
            .bind(cli_sid)
            .bind(&now)
            .execute(pool)
            .await;
        }

        let _ = Self::insert_message(
            pool,
            session_id,
            "system",
            "clear_divider",
            "clear_divider",
            None,
            None,
            None,
            None,
        )
        .await;

        let _ = sqlx::query(
            "UPDATE agent_sessions SET runtime_session_id = NULL WHERE id = ?",
        )
        .bind(session_id)
        .execute(pool)
        .await;
    }

    pub async fn persist_runtime_session_id_static(
        pool: &SqlitePool,
        session_id: i64,
        runtime_provider: &str,
        runtime_session_id: &str,
    ) {
        if let Err(e) = sqlx::query(
            "UPDATE agent_sessions SET runtime_provider = ?, runtime_session_id = ? WHERE id = ?",
        )
        .bind(runtime_provider)
        .bind(runtime_session_id)
        .bind(session_id)
        .execute(pool)
        .await
        {
            error!(error = %e, "failed to persist runtime session_id");
        }
    }

    /// Persist only the runtime_session_id without changing the provider column.
    #[allow(dead_code)]
    pub async fn persist_runtime_session_id_only(
        pool: &SqlitePool,
        session_id: i64,
        runtime_session_id: &str,
    ) {
        if let Err(e) = sqlx::query(
            "UPDATE agent_sessions SET runtime_session_id = ? WHERE id = ?",
        )
        .bind(runtime_session_id)
        .bind(session_id)
        .execute(pool)
        .await
        {
            error!(error = %e, "failed to persist runtime session_id");
        }
    }

    #[cfg(test)]
    pub async fn persist_runtime_session_id(&self, runtime_session_id: &str) {
        let Some(session_id) = self.session_db_id else {
            return;
        };
        Self::persist_runtime_session_id_only(&self.write_pool, session_id, runtime_session_id)
            .await;
    }
}

#[cfg(test)]
mod session_archiving_tests {
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
    async fn test_archive_and_clear() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::persist_runtime_session_id_only(&pool, id, "cli-sess-123").await;
        WsSessionPersistence::archive_and_clear(&pool, id, None).await;

        let row: (Option<String>,) =
            sqlx::query_as("SELECT runtime_session_id FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(row.0.is_none());

        let archived: (String,) =
            sqlx::query_as("SELECT runtime_session_id FROM session_runtime_ids WHERE session_id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(archived.0, "cli-sess-123");

        let msg: (String, String) = sqlx::query_as(
            "SELECT role, message_type FROM agent_messages WHERE session_id = ? AND message_type = 'clear_divider'",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(msg.0, "system");
        assert_eq!(msg.1, "clear_divider");
    }

    #[tokio::test]
    async fn test_archive_and_clear_with_known_cli_sid_skips_db_read() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::archive_and_clear(&pool, id, Some("directly-passed-sid")).await;

        let archived: (String,) =
            sqlx::query_as("SELECT runtime_session_id FROM session_runtime_ids WHERE session_id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(archived.0, "directly-passed-sid");

        let row: (Option<String>,) =
            sqlx::query_as("SELECT runtime_session_id FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(row.0.is_none());
    }

    #[tokio::test]
    async fn test_persist_runtime_session_id_only() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::persist_runtime_session_id_only(&pool, id, "static-sid-123").await;

        let row: (Option<String>,) =
            sqlx::query_as("SELECT runtime_session_id FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0.as_deref(), Some("static-sid-123"));
    }

    #[tokio::test]
    async fn test_resume_flow_persist_restart_resume() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p
            .find_or_create_session(Some("sonnet"), None)
            .await
            .unwrap();
        WsSessionPersistence::persist_runtime_session_id_only(&pool, id, "cli-sess-resume-test")
            .await;

        WsSessionPersistence::cleanup_stale_sessions(&pool).await;

        let row: (String,) = sqlx::query_as("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, "paused");

        let mut p2 = WsSessionPersistence::new(pool.clone(), 1);
        let id2 = p2.find_or_create_session(Some("opus"), None).await.unwrap();
        assert_eq!(id, id2);

        let found = WsSessionPersistence::get_latest_runtime_session_id(&pool, 1).await;
        assert_eq!(found, Some("cli-sess-resume-test".to_string()));
    }

    #[tokio::test]
    async fn test_resume_after_clear_uses_archived_id() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();
        WsSessionPersistence::persist_runtime_session_id_only(&pool, id, "pre-clear-sid").await;

        WsSessionPersistence::archive_and_clear(&pool, id, None).await;

        let row: (Option<String>,) =
            sqlx::query_as("SELECT runtime_session_id FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(row.0.is_none());

        let found = WsSessionPersistence::get_latest_runtime_session_id(&pool, 1).await;
        assert_eq!(found, Some("pre-clear-sid".to_string()));
    }
}
