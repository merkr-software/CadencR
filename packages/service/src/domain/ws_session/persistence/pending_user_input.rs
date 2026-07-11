// Central persistence + broadcast API for "pending user input" gates.
//
// An agent turn can be paused on two kinds of user-input gates, each backed
// by its own column on `agent_sessions`:
//
// - PendingUserInputKind::Permission   → pending_permission
// - PendingUserInputKind::Question     → pending_questions
//
// This module is the single entry point for writing/clearing those columns.
// Every "askUser" broadcast must be preceded by a DB write, and every
// "agent"/"none" broadcast must be preceded by a DB clear — otherwise a
// broadcast-lag recovery in ws_session/handler/app.rs reads the DB and
// resurrects stale state.
//
// The two paired helpers (mark_awaiting_user_static and
// mark_agent_resumed_static) encode that ordering: DB first, broadcast
// second. Callers never write to a pending_* column directly.
//
// NOTE: this file is `include!`'d into ws_session/persistence.rs, so it may
// not have top-level `use` statements. It relies on imports in the parent.

impl WsSessionPersistence {
    /// Persist a pending user-input gate to its column. Does NOT broadcast.
    /// Prefer `mark_awaiting_user_static` which pairs write + broadcast.
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

    /// NULL out a single pending-input column. Does NOT broadcast. Prefer
    /// `mark_agent_resumed_static` which pairs clear + broadcast.
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
        if let Err(e) = sqlx::query(
            "UPDATE agent_sessions SET \
                pending_permission = NULL, \
                pending_questions = NULL \
             WHERE id = ?",
        )
        .bind(session_id)
        .execute(pool)
        .await
        {
            error!(
                error = %e,
                session_db_id = session_id,
                "failed to clear all pending user input",
            );
        }
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
        assert_eq!(
            PendingUserInputKind::Question.column(),
            "pending_questions",
        );
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

    fn test_broadcaster() -> (
        crate::domain::session_status::SessionStatusBroadcaster,
        tokio::sync::broadcast::Receiver<crate::domain::session_status::SessionStatusEvent>,
    ) {
        let (tx, rx) = tokio::sync::broadcast::channel(16);
        let bc = crate::domain::session_status::SessionStatusBroadcaster::new(
            tx,
            std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        );
        (bc, rx)
    }

    #[tokio::test]
    async fn mark_awaiting_user_writes_db_before_broadcasting() {
        use crate::domain::session_status::{AgentStatus, PendingKind};
        let pool = setup_pool().await;
        let id = insert_session(&pool).await;
        let state = crate::app_state::AppState::with_pool(pool.clone());
        let mut rx = state.session_status_tx.subscribe();
        let payload = sample_permission_payload();

        WsSessionPersistence::mark_awaiting_user_static(
            &state,
            id,
            42,
            &PendingUserInput::Permission(&payload),
        )
        .await;

        // DB must be set by the time the broadcast is observable.
        assert!(column(&pool, id, "pending_permission").await.is_some());
        let event = rx.recv().await.unwrap();
        assert_eq!(event.session_id, id);
        assert_eq!(event.feature_id, 42);
        assert_eq!(event.status, AgentStatus::Question);
        assert_eq!(event.kind, Some(PendingKind::Permission));
        assert!(event.seq > 0);
    }

    #[tokio::test]
    async fn mark_awaiting_user_propagates_kind_for_question() {
        use crate::domain::session_status::PendingKind;
        let pool = setup_pool().await;
        let id = insert_session(&pool).await;
        let state = crate::app_state::AppState::with_pool(pool.clone());
        let mut rx = state.session_status_tx.subscribe();
        let question = serde_json::json!({"tool_name": "AskUserQuestion", "request_id": "q1"});
        WsSessionPersistence::mark_awaiting_user_static(
            &state,
            id,
            1,
            &PendingUserInput::Question(&question),
        )
        .await;
        assert_eq!(rx.recv().await.unwrap().kind, Some(PendingKind::Question));
    }

    #[tokio::test]
    async fn ask_user_question_payload_is_registered_as_question_defensively() {
        let pool = setup_pool().await;
        let id = insert_session(&pool).await;
        let state = crate::app_state::AppState::with_pool(pool);
        let mut payload = sample_permission_payload();
        payload.tool_name = "AskUserQuestion".into();
        payload.tool_input = serde_json::json!({
            "question": "Which provider?",
            "options": ["Claude", "OpenCode"]
        });

        WsSessionPersistence::mark_awaiting_user_static(
            &state,
            id,
            1,
            &PendingUserInput::Permission(&payload),
        )
        .await;

        let gate = state.pending_gates.latest_open(id).await.unwrap();
        assert_eq!(gate.kind, crate::domain::gate_registry::GateKind::Question);
        assert_eq!(gate.payload["tool_input"]["question"], "Which provider?");
    }

    #[tokio::test]
    async fn mark_agent_resumed_clears_db_before_broadcasting() {
        use crate::domain::session_status::AgentStatus;
        let pool = setup_pool().await;
        let id = insert_session(&pool).await;
        let (bc, mut rx) = test_broadcaster();
        let payload = sample_permission_payload();

        WsSessionPersistence::set_pending_user_input_static(
            &pool,
            id,
            &PendingUserInput::Permission(&payload),
        )
        .await;

        WsSessionPersistence::mark_agent_resumed_static(
            &pool,
            &bc,
            id,
            42,
            PendingUserInputKind::Permission,
            AgentStatus::Agent,
        )
        .await;

        assert!(column(&pool, id, "pending_permission").await.is_none());
        let event = rx.recv().await.unwrap();
        assert_eq!(event.feature_id, 42);
        assert_eq!(event.status, AgentStatus::Agent);
    }

    #[tokio::test]
    async fn mark_agent_resumed_supports_deny_path() {
        use crate::domain::session_status::AgentStatus;
        let pool = setup_pool().await;
        let id = insert_session(&pool).await;
        let (bc, mut rx) = test_broadcaster();

        WsSessionPersistence::mark_agent_resumed_static(
            &pool,
            &bc,
            id,
            1,
            PendingUserInputKind::Permission,
            AgentStatus::Idle,
        )
        .await;

        let event = rx.recv().await.unwrap();
        assert_eq!(event.status, AgentStatus::Idle);
    }
}
