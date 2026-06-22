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

/// The DB-backed user-input gate kinds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PendingUserInputKind {
    Permission,
    Question,
}

impl PendingUserInputKind {
    fn column(self) -> &'static str {
        match self {
            Self::Permission => "pending_permission",
            Self::Question => "pending_questions",
        }
    }

    /// Project this DB-side kind onto the canonical, frontend-visible
    /// [`PendingKind`] enum used on the wire.
    pub fn as_session_kind(self) -> crate::domain::session_status::PendingKind {
        match self {
            Self::Permission => crate::domain::session_status::PendingKind::Permission,
            Self::Question => crate::domain::session_status::PendingKind::Question,
        }
    }
}

/// A typed, about-to-be-persisted user-input gate. Variants borrow their
/// payload to avoid forcing callers to clone before the write.
#[derive(Debug)]
pub enum PendingUserInput<'a> {
    /// Regular per-tool permission (Read/Write/Bash/...). Serialized as the
    /// full `PermissionRequestPayload` so a reconnect can re-emit the WS
    /// envelope verbatim.
    Permission(&'a crate::domain::ws_session::protocol::PermissionRequestPayload),
    /// `AskUserQuestion` gate. The payload shape is
    /// `{ tool_name, tool_input, request_id, pattern }` — intentionally the
    /// same format used by `workflow/engine` restore so workflow and
    /// ws-session agree on a single wire format.
    Question(&'a serde_json::Value),
}

impl<'a> PendingUserInput<'a> {
    pub fn kind(&self) -> PendingUserInputKind {
        match self {
            Self::Permission(_) => PendingUserInputKind::Permission,
            Self::Question(_) => PendingUserInputKind::Question,
        }
    }

    fn serialize(&self) -> String {
        match self {
            Self::Permission(p) => serde_json::to_string(p).unwrap_or_default(),
            Self::Question(v) => serde_json::to_string(v).unwrap_or_default(),
        }
    }
}

impl WsSessionPersistence {
    /// Persist a pending user-input gate to its column. Does NOT broadcast.
    /// Prefer `mark_awaiting_user_static` which pairs write + broadcast.
    pub async fn set_pending_user_input_static(
        pool: &SqlitePool,
        session_id: i64,
        input: &PendingUserInput<'_>,
    ) {
        let column = input.kind().column();
        let payload = input.serialize();
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

    /// Paired write + broadcast: persist the gate, THEN broadcast Question.
    /// Ordering is load-bearing: a broadcast-lag recovery re-reads the DB,
    /// so the column must be set before any subscriber can see the event.
    pub async fn mark_awaiting_user_static(
        pool: &SqlitePool,
        broadcaster: &crate::domain::session_status::SessionStatusBroadcaster,
        session_id: i64,
        feature_id: i64,
        input: &PendingUserInput<'_>,
    ) {
        let kind = input.kind().as_session_kind();
        Self::set_pending_user_input_static(pool, session_id, input).await;
        // Propagate `kind` so live askUser listeners can identify the gate
        // type (permission/question) without a DB snapshot round
        // trip.
        Self::broadcast_session_status(
            broadcaster,
            session_id,
            feature_id,
            crate::domain::session_status::AgentStatus::Question,
            Some(kind),
        );
    }

    /// Paired clear + broadcast: NULL the gate, THEN broadcast the next
    /// status (`Agent` for Allow, `Idle` for Deny). Same ordering
    /// guarantee as `mark_awaiting_user_static`.
    pub async fn mark_agent_resumed_static(
        pool: &SqlitePool,
        broadcaster: &crate::domain::session_status::SessionStatusBroadcaster,
        session_id: i64,
        feature_id: i64,
        kind: PendingUserInputKind,
        next_status: crate::domain::session_status::AgentStatus,
    ) {
        debug_assert!(
            matches!(
                next_status,
                crate::domain::session_status::AgentStatus::Agent
                    | crate::domain::session_status::AgentStatus::Idle
            ),
            "mark_agent_resumed_static expects Agent or Idle, got {next_status:?}",
        );
        Self::clear_pending_user_input_static(pool, session_id, kind).await;
        Self::broadcast_session_status(broadcaster, session_id, feature_id, next_status, None);
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
        let (bc, mut rx) = test_broadcaster();
        let payload = sample_permission_payload();

        WsSessionPersistence::mark_awaiting_user_static(
            &pool,
            &bc,
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
        let (bc, mut rx) = test_broadcaster();
        let question = serde_json::json!({"tool_name": "AskUserQuestion"});
        WsSessionPersistence::mark_awaiting_user_static(
            &pool,
            &bc,
            id,
            1,
            &PendingUserInput::Question(&question),
        )
        .await;
        assert_eq!(rx.recv().await.unwrap().kind, Some(PendingKind::Question));
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
