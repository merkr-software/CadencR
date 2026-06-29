impl WsSessionPersistence {
    pub fn new(write_pool: SqlitePool, feature_id: i64) -> Self {
        Self::with_session_id(write_pool, feature_id, None)
    }

    /// Create a persistence instance with an already-known session DB id.
    pub fn with_session_id(
        write_pool: SqlitePool,
        feature_id: i64,
        session_db_id: Option<i64>,
    ) -> Self {
        Self {
            write_pool,
            session_db_id,
            feature_id,
            current_models: HashMap::new(),
            pending_tool_inputs: HashMap::new(),
            pending_tool_row_ids: HashMap::new(),
            pending_mergeable_blocks: HashMap::new(),
            streamed_assistant_content: HashSet::new(),
            file_change_marked: false,
        }
    }

    /// Ensure an agent_sessions row exists for this feature.
    #[cfg(test)]
    pub async fn find_or_create_session(
        &mut self,
        model: Option<&str>,
        permission_mode: Option<&str>,
    ) -> Option<i64> {
        self.find_or_create_session_with_codex_permission_mode(model, permission_mode, None)
            .await
    }

    pub async fn find_or_create_session_with_codex_permission_mode(
        &mut self,
        model: Option<&str>,
        permission_mode: Option<&str>,
        codex_permission_mode: Option<&str>,
    ) -> Option<i64> {
        let existing: Option<(i64,)> = sqlx::query_as(
            "SELECT id FROM agent_sessions WHERE feature_id = ? AND agent_type = 'session' ORDER BY id DESC LIMIT 1",
        )
        .bind(self.feature_id)
        .fetch_optional(&self.write_pool)
        .await
        .ok()?;

        if let Some((id,)) = existing {
            if let Err(e) = sqlx::query(
                "UPDATE agent_sessions SET status = 'paused', permission_mode = COALESCE(?, permission_mode) WHERE id = ?",
            )
            .bind(permission_mode)
            .bind(id)
            .execute(&self.write_pool)
            .await
            {
                error!(error = %e, session_db_id = id, "failed to update existing agent_sessions row");
            }

            self.session_db_id = Some(id);
            debug!(session_db_id = id, feature_id = self.feature_id, "reusing existing agent_sessions row");
            return Some(id);
        }

        let now = chrono::Utc::now().to_rfc3339();
        let result = sqlx::query(
            "INSERT INTO agent_sessions (feature_id, agent_type, status, model, permission_mode, codex_permission_mode, started_at) VALUES (?, 'session', 'paused', ?, ?, COALESCE(?, 'default'), ?)",
        )
        .bind(self.feature_id)
        .bind(model)
        .bind(permission_mode)
        .bind(codex_permission_mode)
        .bind(&now)
        .execute(&self.write_pool)
        .await;

        match result {
            Ok(r) => {
                let id = r.last_insert_rowid();
                self.session_db_id = Some(id);
                debug!(session_db_id = id, feature_id = self.feature_id, "created agent_sessions row");
                Some(id)
            }
            Err(e) => {
                error!(error = %e, feature_id = self.feature_id, "failed to create agent_sessions row");
                None
            }
        }
    }

    /// Persist a user prompt row and return its `agent_messages.id` (the seam
    /// the checkpoints subsystem links a pre-turn snapshot to). Returns `None`
    /// when there is no session id yet or the insert fails.
    pub async fn persist_user_message(&self, text: &str) -> Option<i64> {
        let session_id = self.session_db_id?;
        match Self::insert_message(
            &self.write_pool,
            session_id,
            "user",
            text,
            "user_message",
            None,
            None,
            None,
            None,
        )
        .await
        {
            Ok(result) => Some(result.last_insert_rowid()),
            Err(e) => {
                error!(error = %e, "failed to persist user message");
                None
            }
        }
    }
}

#[cfg(test)]
mod session_bootstrap_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_test_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();

        sqlx::query(
            r#"CREATE TABLE features (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT ''
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO features (id, title) VALUES (1, 'One'), (2, 'Two')")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(
            r#"CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feature_id INTEGER NOT NULL REFERENCES features(id),
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
    async fn test_find_or_create_session_creates_new() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(Some("opus"), Some("plan")).await;
        assert!(id.is_some());
        assert_eq!(p.session_db_id, id);

        let row: (String, String, String) =
            sqlx::query_as("SELECT status, model, permission_mode FROM agent_sessions WHERE id = ?")
                .bind(id.unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, "paused");
        assert_eq!(row.1, "opus");
        assert_eq!(row.2, "plan");
    }

    #[tokio::test]
    async fn test_find_or_create_session_reuses_existing() {
        let pool = setup_test_db().await;
        let mut p1 = WsSessionPersistence::new(pool.clone(), 1);
        let id1 = p1.find_or_create_session(Some("sonnet"), None).await.unwrap();

        let mut p2 = WsSessionPersistence::new(pool.clone(), 1);
        let id2 = p2
            .find_or_create_session(Some("opus"), Some("plan"))
            .await
            .unwrap();

        assert_eq!(id1, id2);

        let row: (String, String) =
            sqlx::query_as("SELECT model, permission_mode FROM agent_sessions WHERE id = ?")
                .bind(id2)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, "sonnet");
        assert_eq!(row.1, "plan");
    }

    #[tokio::test]
    async fn test_find_or_create_session_different_features_get_separate_rows() {
        let pool = setup_test_db().await;
        let mut p1 = WsSessionPersistence::new(pool.clone(), 1);
        let id1 = p1.find_or_create_session(None, None).await.unwrap();

        let mut p2 = WsSessionPersistence::new(pool.clone(), 2);
        let id2 = p2.find_or_create_session(None, None).await.unwrap();

        assert_ne!(id1, id2);
    }

    #[tokio::test]
    async fn test_find_or_create_session_leaves_runtime_provider_unset() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        let row: (Option<String>,) =
            sqlx::query_as("SELECT runtime_provider FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(row.0, None);
    }

    #[tokio::test]
    async fn test_persist_user_message_uses_user_message_type() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        p.find_or_create_session(None, None).await;

        p.persist_user_message("Hello world").await;

        let row: (String, String, String) = sqlx::query_as(
            "SELECT role, content, message_type FROM agent_messages WHERE session_id = ?",
        )
        .bind(p.session_db_id.unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "user");
        assert_eq!(row.1, "Hello world");
        assert_eq!(row.2, "user_message");
    }

    #[tokio::test]
    async fn test_with_session_id_persists_user_message_without_find_or_create() {
        let pool = setup_test_db().await;
        let id: (i64,) = sqlx::query_as(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (1, 'session', 'running') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(id.0));
        p.persist_user_message("hello from with_session_id").await;

        let row: (String,) =
            sqlx::query_as("SELECT content FROM agent_messages WHERE session_id = ?")
                .bind(id.0)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, "hello from with_session_id");
    }
}
