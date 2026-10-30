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
            transcript: Default::default(),
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
        self.find_or_create_session_with_access_mode(model, permission_mode, None)
            .await
    }

    pub async fn find_or_create_session_with_access_mode(
        &mut self,
        model: Option<&str>,
        permission_mode: Option<&str>,
        access_mode: Option<&str>,
    ) -> Option<i64> {
        self.ensure_session(model, permission_mode, access_mode, true)
            .await
    }

    /// Select the DB identity before acquiring its runtime cell. Existing rows
    /// are reopened only after the caller knows no live runtime owns them.
    pub async fn find_or_create_session_for_binding(
        &mut self,
        model: Option<&str>,
        permission_mode: Option<&str>,
        access_mode: Option<&str>,
    ) -> Option<i64> {
        self.ensure_session(model, permission_mode, access_mode, false)
            .await
    }

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

    async fn ensure_session(
        &mut self,
        model: Option<&str>,
        permission_mode: Option<&str>,
        access_mode: Option<&str>,
        reopen_existing: bool,
    ) -> Option<i64> {
        if let Some(id) = self.latest_session_id().await.ok()? {
            return self
                .reuse_session(id, permission_mode, reopen_existing)
                .await;
        }

        let now = chrono::Utc::now().to_rfc3339();
        // The existence check and insert share one SQLite write statement.
        // Concurrent initializers which both observed no row select the winner
        // below, rather than manufacturing a second runtime identity.
        let result: Result<Option<(i64,)>, sqlx::Error> = sqlx::query_as(
            "INSERT INTO agent_sessions
             (feature_id, agent_type, status, model, permission_mode, codex_permission_mode, started_at)
             SELECT ?, 'session', 'paused', ?, ?, COALESCE(?, 'default'), ?
             WHERE NOT EXISTS (
                 SELECT 1 FROM agent_sessions WHERE feature_id = ? AND agent_type = 'session'
             ) RETURNING id",
        )
        .bind(self.feature_id)
        .bind(model)
        .bind(permission_mode)
        // `codex_permission_mode` is the legacy SQLite storage name.
        .bind(access_mode)
        .bind(&now)
        .bind(self.feature_id)
        .fetch_optional(&self.write_pool)
        .await;

        match result {
            Ok(Some((id,))) => {
                self.session_db_id = Some(id);
                debug!(
                    session_db_id = id,
                    feature_id = self.feature_id,
                    "created agent_sessions row"
                );
                Some(id)
            }
            Ok(None) => {
                let id = self.latest_session_id().await.ok()??;
                self.reuse_session(id, permission_mode, reopen_existing)
                    .await
            }
            Err(e) => {
                error!(error = %e, feature_id = self.feature_id, "failed to create agent_sessions row");
                None
            }
        }
    }

    async fn latest_session_id(&self) -> Result<Option<i64>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT id FROM agent_sessions WHERE feature_id = ? AND agent_type = 'session' ORDER BY id DESC LIMIT 1",
        )
        .bind(self.feature_id)
        .fetch_optional(&self.write_pool)
        .await
    }

    async fn reuse_session(
        &mut self,
        id: i64,
        permission_mode: Option<&str>,
        reopen: bool,
    ) -> Option<i64> {
        if reopen {
            if let Err(e) = self.reopen_session(id, permission_mode).await {
                error!(error = %e, session_db_id = id, "failed to update existing agent_sessions row");
            }
        }
        self.session_db_id = Some(id);
        debug!(
            session_db_id = id,
            feature_id = self.feature_id,
            "reusing existing agent_sessions row"
        );
        Some(id)
    }

    /// Persist a canonical user prompt. A repeated UUID returns the existing
    /// row with `inserted = false`; callers must not dispatch that retry to the
    /// provider again.
    #[cfg(test)]
    pub async fn persist_user_message(
        &self,
        text: &str,
        message_uuid: uuid::Uuid,
    ) -> Result<
        crate::domain::sessions::user_messages::PersistedUserMessage,
        crate::domain::sessions::user_messages::PersistUserMessageError,
    > {
        self.persist_user_message_with_delivery(text, message_uuid, None)
            .await
    }

    pub async fn persist_user_message_with_delivery(
        &self,
        text: &str,
        message_uuid: uuid::Uuid,
        delivery_state: Option<&str>,
    ) -> Result<
        crate::domain::sessions::user_messages::PersistedUserMessage,
        crate::domain::sessions::user_messages::PersistUserMessageError,
    > {
        let session_id = self.session_db_id.ok_or(
            crate::domain::sessions::user_messages::PersistUserMessageError::MissingSessionId,
        )?;
        let mut connection = self.write_pool.acquire().await?;
        crate::domain::sessions::user_messages::persist_user_message(
            &mut connection,
            crate::domain::sessions::user_messages::NewUserMessage {
                session_id,
                content: text,
                message_uuid,
                delivery_state,
            },
        )
        .await
    }

    pub async fn persist_prompt_user_message(
        &self,
        text: &str,
        message_uuid: uuid::Uuid,
        delivery_state: Option<&str>,
    ) -> Result<
        crate::domain::sessions::user_messages::PersistedUserMessage,
        crate::domain::sessions::user_messages::PersistUserMessageError,
    > {
        let session_id = self.session_db_id.ok_or(
            crate::domain::sessions::user_messages::PersistUserMessageError::MissingSessionId,
        )?;
        let mut tx = self.write_pool.begin().await?;
        let message = crate::domain::sessions::user_messages::persist_user_message(
            &mut tx,
            crate::domain::sessions::user_messages::NewUserMessage {
                session_id,
                content: text,
                message_uuid,
                delivery_state,
            },
        )
        .await?;
        sqlx::query(
            "INSERT INTO agent_message_dispatches (message_id, status)
             VALUES (?, 'pending') ON CONFLICT(message_id) DO NOTHING",
        )
        .bind(message.id)
        .execute(&mut *tx)
        .await?;
        // Only the first delivery of a prompt counts: a retry reuses its UUID.
        if message.inserted {
            crate::domain::usage_stats::repository::count_user_message(&mut *tx, session_id)
                .await?;
        }
        tx.commit().await?;
        Ok(message)
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
                context_window INTEGER,
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
                model TEXT,
                message_uuid TEXT,
                delivery_state TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE UNIQUE INDEX idx_agent_messages_session_message_uuid
             ON agent_messages(session_id, message_uuid) WHERE message_uuid IS NOT NULL",
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
    async fn concurrent_fresh_feature_binding_has_one_database_identity() {
        let pool = setup_test_db().await;
        let starters = std::sync::Arc::new(tokio::sync::Barrier::new(16));
        let mut callers = Vec::new();
        for _ in 0..16 {
            let pool = pool.clone();
            let starters = starters.clone();
            callers.push(tokio::spawn(async move {
                let mut persistence = WsSessionPersistence::new(pool, 1);
                starters.wait().await;
                let id = persistence
                    .find_or_create_session_for_binding(Some("opus"), Some("plan"), None)
                    .await
                    .unwrap();
                assert_eq!(persistence.session_db_id, Some(id));
                id
            }));
        }
        let mut ids = Vec::new();
        for caller in callers {
            ids.push(caller.await.unwrap());
        }
        assert!(ids.iter().all(|id| *id == ids[0]));
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_sessions WHERE feature_id = 1 AND agent_type = 'session'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn binding_selects_latest_existing_without_mutation_then_reopen_preserves_model() {
        let pool = setup_test_db().await;
        sqlx::query("INSERT INTO agent_sessions (feature_id, agent_type, status, model, permission_mode) VALUES (1, 'session', 'completed', 'older', 'plan'), (1, 'session', 'completed', 'latest', 'default'), (1, 'other', 'running', 'unrelated', 'default')")
            .execute(&pool).await.unwrap();
        let expected: i64 =
            sqlx::query_scalar("SELECT id FROM agent_sessions WHERE model = 'latest'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let mut persistence = WsSessionPersistence::new(pool.clone(), 1);
        assert_eq!(
            persistence
                .find_or_create_session_for_binding(
                    Some("replacement"),
                    Some("bypassPermissions"),
                    None
                )
                .await,
            Some(expected)
        );
        let untouched: (String, String, String) = sqlx::query_as(
            "SELECT status, model, permission_mode FROM agent_sessions WHERE id = ?",
        )
        .bind(expected)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            untouched,
            ("completed".into(), "latest".into(), "default".into())
        );
        assert_eq!(
            persistence
                .find_or_create_session_with_access_mode(Some("replacement"), Some("plan"), None)
                .await,
            Some(expected)
        );
        let reopened: (String, String, String) = sqlx::query_as(
            "SELECT status, model, permission_mode FROM agent_sessions WHERE id = ?",
        )
        .bind(expected)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(reopened, ("paused".into(), "latest".into(), "plan".into()));
    }

    #[tokio::test]
    async fn test_find_or_create_session_creates_new() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(Some("opus"), Some("plan")).await;
        assert!(id.is_some());
        assert_eq!(p.session_db_id, id);

        let row: (String, String, String) = sqlx::query_as(
            "SELECT status, model, permission_mode FROM agent_sessions WHERE id = ?",
        )
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
        let id1 = p1
            .find_or_create_session(Some("sonnet"), None)
            .await
            .unwrap();
        WsSessionPersistence::mark_completed_static(&pool, id1).await;
        let mut p2 = WsSessionPersistence::new(pool.clone(), 1);
        let id2 = p2
            .find_or_create_session(Some("opus"), Some("plan"))
            .await
            .unwrap();
        assert_eq!(id1, id2);
        let row: (String, String, String) = sqlx::query_as(
            "SELECT model, permission_mode, status FROM agent_sessions WHERE id = ?",
        )
        .bind(id2)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "sonnet");
        assert_eq!(row.1, "plan");
        assert_eq!(row.2, "paused");
    }

    #[tokio::test]
    async fn test_reusing_session_preserves_running_status() {
        let pool = setup_test_db().await;
        let mut first = WsSessionPersistence::new(pool.clone(), 1);
        let session_id = first.find_or_create_session(None, None).await.unwrap();
        WsSessionPersistence::mark_running_static(&pool, session_id).await;
        let mut second = WsSessionPersistence::new(pool.clone(), 1);
        second
            .find_or_create_session(None, Some("plan"))
            .await
            .unwrap();
        let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "running");
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

        p.persist_user_message("Hello world", uuid::Uuid::new_v4())
            .await
            .unwrap();

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
        p.persist_user_message("hello from with_session_id", uuid::Uuid::new_v4())
            .await
            .unwrap();

        let row: (String,) =
            sqlx::query_as("SELECT content FROM agent_messages WHERE session_id = ?")
                .bind(id.0)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, "hello from with_session_id");
    }
}
