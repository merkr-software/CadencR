//! Bind a feature to one durable session identity before acquiring its runtime.

use super::WsSessionPersistence;
use tracing::{debug, error};

impl WsSessionPersistence {
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
}

#[cfg(test)]
pub(super) mod session_bootstrap_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    pub(in super::super) async fn setup_test_db() -> SqlitePool {
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
}
