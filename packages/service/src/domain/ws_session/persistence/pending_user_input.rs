//! Database storage for pending user-input gates.

use super::{PendingUserInput, PendingUserInputKind, WsSessionPersistence};
use sqlx::SqlitePool;
use tracing::error;

impl WsSessionPersistence {
    /// Persist a pending user-input gate to its column. Does NOT broadcast.
    pub async fn set_pending_user_input_static(
        pool: &SqlitePool,
        session_id: i64,
        input: &PendingUserInput<'_>,
    ) {
        let column = input.kind().column();
        let payload = match input.serialize() {
            Ok(payload) => payload,
            Err(error) => {
                error!(session_id, %error, "failed to serialize pending user input");
                return;
            }
        };
        // Column name is a compile-time &'static str from our own enum — not
        // user input, so string interpolation into SQL is safe here.
        let sql = format!("UPDATE agent_sessions SET {column} = ? WHERE id = ?");
        if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(payload)
            .bind(session_id)
            .execute(pool)
            .await
        {
            error!(
                error = %e,
                session_db_id = session_id,
                column,
                "failed to persist pending user input",
            );
        }
    }

    /// NULL out a single pending-input column. Does NOT broadcast.
    pub async fn clear_pending_user_input_static(
        pool: &SqlitePool,
        session_id: i64,
        kind: PendingUserInputKind,
    ) {
        let column = kind.column();
        let sql = format!("UPDATE agent_sessions SET {column} = NULL WHERE id = ?");
        if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(session_id)
            .execute(pool)
            .await
        {
            error!(
                error = %e,
                session_db_id = session_id,
                column,
                "failed to clear pending user input",
            );
        }
    }

    /// NULL out every pending-input column in a single UPDATE. Used
    /// defensively when the handler doesn't know which kind was stored
    /// (e.g. `session_control::handle_permission_respond` after any
    /// Allow/Deny, and `session_init` reconnect cleanup).
    pub async fn clear_all_pending_user_input_static(pool: &SqlitePool, session_id: i64) {
        if let Err(e) = Self::try_clear_all_pending_user_input_static(pool, session_id).await {
            error!(error = %e, session_db_id = session_id, "failed to clear all pending user input");
        }
    }

    pub(crate) async fn try_clear_all_pending_user_input_static(
        pool: &SqlitePool,
        session_id: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE agent_sessions SET pending_permission = NULL, pending_questions = NULL WHERE id = ?")
            .bind(session_id).execute(pool).await?;
        Ok(())
    }
}

#[cfg(test)]
mod pending_user_input_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feature_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'idle',
                pending_permission TEXT,
                pending_questions TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn insert_session(pool: &SqlitePool) -> i64 {
        sqlx::query("INSERT INTO agent_sessions (feature_id, status) VALUES (1, 'running')")
            .execute(pool)
            .await
            .unwrap()
            .last_insert_rowid()
    }

    async fn column(pool: &SqlitePool, session_id: i64, col: &str) -> Option<String> {
        let sql = format!("SELECT {col} FROM agent_sessions WHERE id = ?");
        let row: (Option<String>,) = sqlx::query_as(sqlx::AssertSqlSafe(sql))
            .bind(session_id)
            .fetch_one(pool)
            .await
            .unwrap();
        row.0
    }

    fn sample_permission_payload() -> crate::domain::ws_session::protocol::PermissionRequestPayload
    {
        crate::domain::ws_session::protocol::PermissionRequestPayload {
            request_id: "r1".into(),
            tool_name: "Bash".into(),
            tool_input: serde_json::json!({"command": "ls"}),
            description: Some("run ls".into()),
            pattern: Some("Bash(ls:*)".into()),
            preview: None,
            options: Vec::new(),
        }
    }

    #[test]
    fn kind_column_mapping_is_stable() {
        assert_eq!(
            PendingUserInputKind::Permission.column(),
            "pending_permission",
        );
        assert_eq!(PendingUserInputKind::Question.column(), "pending_questions",);
    }

    #[tokio::test]
    async fn set_permission_writes_only_permission_column() {
        let pool = setup_pool().await;
        let id = insert_session(&pool).await;
        let payload = sample_permission_payload();

        WsSessionPersistence::set_pending_user_input_static(
            &pool,
            id,
            &PendingUserInput::Permission(&payload),
        )
        .await;

        assert!(column(&pool, id, "pending_permission").await.is_some());
        assert!(column(&pool, id, "pending_questions").await.is_none());
    }

    #[tokio::test]
    async fn set_question_writes_only_question_column() {
        let pool = setup_pool().await;
        let id = insert_session(&pool).await;
        let payload = serde_json::json!({
            "tool_name": "AskUserQuestion",
            "tool_input": {"questions": []},
            "request_id": "q1",
            "pattern": "AskUserQuestion",
        });

        WsSessionPersistence::set_pending_user_input_static(
            &pool,
            id,
            &PendingUserInput::Question(&payload),
        )
        .await;

        assert!(column(&pool, id, "pending_questions").await.is_some());
        assert!(column(&pool, id, "pending_permission").await.is_none());
    }

    #[tokio::test]
    async fn clear_nulls_only_one_column() {
        let pool = setup_pool().await;
        let id = insert_session(&pool).await;
        let payload = sample_permission_payload();
        let question = serde_json::json!({"tool_name": "AskUserQuestion"});

        WsSessionPersistence::set_pending_user_input_static(
            &pool,
            id,
            &PendingUserInput::Permission(&payload),
        )
        .await;
        WsSessionPersistence::set_pending_user_input_static(
            &pool,
            id,
            &PendingUserInput::Question(&question),
        )
        .await;

        WsSessionPersistence::clear_pending_user_input_static(
            &pool,
            id,
            PendingUserInputKind::Permission,
        )
        .await;

        assert!(column(&pool, id, "pending_permission").await.is_none());
        assert!(column(&pool, id, "pending_questions").await.is_some());
    }

    #[tokio::test]
    async fn clear_all_nulls_every_column() {
        let pool = setup_pool().await;
        let id = insert_session(&pool).await;
        let payload = sample_permission_payload();
        let question = serde_json::json!({"tool_name": "AskUserQuestion"});
        WsSessionPersistence::set_pending_user_input_static(
            &pool,
            id,
            &PendingUserInput::Permission(&payload),
        )
        .await;
        WsSessionPersistence::set_pending_user_input_static(
            &pool,
            id,
            &PendingUserInput::Question(&question),
        )
        .await;
        WsSessionPersistence::clear_all_pending_user_input_static(&pool, id).await;

        assert!(column(&pool, id, "pending_permission").await.is_none());
        assert!(column(&pool, id, "pending_questions").await.is_none());
    }

    #[tokio::test]
    async fn try_clear_reports_failed_write_without_claiming_gate_removed() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, pending_permission TEXT, pending_questions TEXT); INSERT INTO agent_sessions VALUES (7, 'permission', 'question'); CREATE TRIGGER reject_clear BEFORE UPDATE ON agent_sessions BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END;")
            .execute(&pool).await.unwrap();
        assert!(
            WsSessionPersistence::try_clear_all_pending_user_input_static(&pool, 7)
                .await
                .is_err()
        );
        let row: (String, String) = sqlx::query_as(
            "SELECT pending_permission, pending_questions FROM agent_sessions WHERE id = 7",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("permission".into(), "question".into()));
    }
}
