impl WsSessionPersistence {
    pub async fn try_get_session_row(
        pool: &SqlitePool,
        session_id: i64,
    ) -> Result<Option<SessionRow>, sqlx::Error> {
        let row: Option<(
            i64,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<String>,
        )> = sqlx::query_as(
            "SELECT id, feature_id, runtime_provider, runtime_session_id, model, profile, permission_mode, codex_permission_mode, status, pending_permission, pending_questions, input_tokens, output_tokens, context_window, thinking_effort FROM agent_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(
            |(
                id,
                feature_id,
                runtime_provider,
                runtime_session_id,
                model,
                profile,
                permission_mode,
                codex_permission_mode,
                status,
                pending_permission,
                pending_questions,
                input_tokens,
                output_tokens,
                context_window,
                thinking_effort,
            )| SessionRow {
                id,
                feature_id,
                runtime_provider,
                runtime_session_id,
                model,
                profile,
                permission_mode,
                codex_permission_mode,
                status,
                pending_permission,
                pending_questions,
                input_tokens,
                output_tokens,
                context_window,
                thinking_effort,
            },
        ))
    }

    pub async fn get_session_row(pool: &SqlitePool, session_id: i64) -> Option<SessionRow> {
        Self::try_get_session_row(pool, session_id).await.ok()?
    }

    #[cfg(test)]
    pub async fn get_latest_runtime_session_id(
        pool: &SqlitePool,
        feature_id: i64,
    ) -> Option<String> {
        let row: Option<(String,)> = sqlx::query_as(
            r#"SELECT runtime_session_id FROM (
                SELECT runtime_session_id, id AS sort_key FROM agent_sessions
                    WHERE feature_id = ? AND runtime_session_id IS NOT NULL
                UNION ALL
                SELECT sci.runtime_session_id, sci.id AS sort_key FROM session_runtime_ids sci
                    JOIN agent_sessions s ON sci.session_id = s.id
                    WHERE s.feature_id = ?
            ) ORDER BY sort_key DESC LIMIT 1"#,
        )
        .bind(feature_id)
        .bind(feature_id)
        .fetch_optional(pool)
        .await
        .ok()?;

        row.map(|(sid,)| sid)
    }
}

#[cfg(test)]
mod session_queries_tests {
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
                ended_at TEXT,
                pending_permission TEXT,
                pending_questions TEXT,
                thinking_effort TEXT
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
    async fn test_get_session_row() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 42);
        let id = p
            .find_or_create_session(Some("opus"), Some("plan"))
            .await
            .unwrap();

        let row = WsSessionPersistence::get_session_row(&pool, id)
            .await
            .unwrap();
        assert_eq!(row.id, id);
        assert_eq!(row.feature_id, 42);
        assert_eq!(row.model.as_deref(), Some("opus"));
        assert_eq!(row.permission_mode.as_deref(), Some("plan"));
        assert_eq!(row.status, "paused");
    }

    #[tokio::test]
    async fn test_get_session_row_missing() {
        let pool = setup_test_db().await;
        assert!(WsSessionPersistence::get_session_row(&pool, 999).await.is_none());
    }

    #[tokio::test]
    async fn test_enter_plan_mode_persists_permission_mode() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 10);
        let id = p
            .find_or_create_session(Some("opus"), Some("acceptEdits"))
            .await
            .unwrap();

        sqlx::query("UPDATE agent_sessions SET permission_mode = 'plan' WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();

        let row = WsSessionPersistence::get_session_row(&pool, id)
            .await
            .unwrap();
        assert_eq!(row.permission_mode.as_deref(), Some("plan"));
    }

    #[tokio::test]
    async fn test_exit_plan_mode_approval_switches_to_accept_edits() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 10);
        let id = p
            .find_or_create_session(Some("opus"), Some("plan"))
            .await
            .unwrap();

        sqlx::query(
            "UPDATE agent_sessions SET permission_mode = 'acceptEdits' WHERE id = ?",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();

        let row = WsSessionPersistence::get_session_row(&pool, id)
            .await
            .unwrap();
        assert_eq!(row.permission_mode.as_deref(), Some("acceptEdits"));
    }

    #[tokio::test]
    async fn test_persist_and_get_runtime_session_id() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        p.find_or_create_session(None, None).await;

        p.persist_runtime_session_id("cli-sess-abc").await;

        let found = WsSessionPersistence::get_latest_runtime_session_id(&pool, 1).await;
        assert_eq!(found, Some("cli-sess-abc".to_string()));
    }

    #[tokio::test]
    async fn test_get_latest_runtime_session_id_returns_none_when_missing() {
        let pool = setup_test_db().await;
        let found = WsSessionPersistence::get_latest_runtime_session_id(&pool, 999).await;
        assert_eq!(found, None);
    }

    #[tokio::test]
    async fn test_get_latest_runtime_session_id_falls_back_to_archive() {
        let pool = setup_test_db().await;
        let session_id: (i64,) = sqlx::query_as(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (1, 'session', 'completed') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO session_runtime_ids (session_id, runtime_session_id) VALUES (?, ?)")
            .bind(session_id.0)
            .bind("archived-cli-sess")
            .execute(&pool)
            .await
            .unwrap();

        let found = WsSessionPersistence::get_latest_runtime_session_id(&pool, 1).await;
        assert_eq!(found, Some("archived-cli-sess".to_string()));
    }
}
