//! WebSocket session handler entry point.
//!
//! Production code is split across cohesive submodules:
//!
//! - [`types`] — `SdkHandle`, `QueryState`, `SessionConfig`, channel/lock
//!   type aliases held by `handle_connection`.
//! - [`helpers`] — small utilities (permission-mode parsing, `send_error`,
//!   `persist_and_close_query`) shared across handlers.
//! - [`dispatch`] — domain-level routing of inbound `WsEnvelope`s to the
//!   matching `session_*` / `workflow` / `app` / `commands` handler.
//! - [`connection`] — the axum upgrade hook and the per-connection
//!   inbound/outbound loop, including the disconnect cleanup path.
//!
//! The remaining inline-test block exercises the dispatch layer
//! end-to-end. Per the project's `inline-rust-tests.md` rule, those tests
//! stay in this file alongside the public surface they cover; the
//! production code itself is well under the 400-line cap.

mod app;
mod commands;
mod connection;
mod dispatch;
pub(crate) mod helpers;
pub(crate) mod post_plan_mode;
mod session_compact;
mod session_control;
mod session_data;
mod session_gate;
mod session_init;
pub(crate) mod session_prompt;
mod types;

pub use connection::ws_handler;

// Public type for crate-wide use (referenced via `handler::SdkHandle`).
pub use types::SdkHandle;

// Bring the cross-submodule helpers and types into mod.rs scope so the
// inline `tests` module — which still uses `super::*` — can reach them
// without churning every test. Production code in this file is just the
// `pub use`s above; these names are wired through for tests only.
#[allow(unused_imports)]
use dispatch::dispatch_envelope;
#[allow(unused_imports)]
use helpers::{
    default_permission_mode, default_permission_mode_wire, parse_permission_mode, parse_session_id,
    persist_and_close_query, post_plan_approval_mode_wire, provider_supports_mode, send_error,
    send_runtime_session_id,
};
#[allow(unused_imports)]
use types::{QueryState, SdkSessions, SessionConfig, WsSender};

// Imports that the existing inline test module depends on via `super::*`.
// They mirror the top-of-file imports the pre-refactor mod.rs carried.
#[allow(unused_imports)]
use crate::app_state::AppState;
#[allow(unused_imports)]
use crate::domain::ws_session::persistence::WsSessionPersistence;
#[allow(unused_imports)]
use crate::domain::ws_session::protocol::*;
#[allow(unused_imports)]
use axum::extract::ws::Message;
#[allow(unused_imports)]
use std::collections::HashMap;
#[allow(unused_imports)]
use std::path::PathBuf;
#[allow(unused_imports)]
use std::sync::atomic::AtomicBool;
#[allow(unused_imports)]
use std::sync::Arc;
#[allow(unused_imports)]
use tokio::sync::{mpsc, Mutex, RwLock};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeMessageRx,
        RuntimePermissionMode, RuntimeSessionHandle,
    };
    use crate::domain::agents::claude_code::ClaudeCodeSession;
    use claude_agent_sdk_rs::{Query, SdkError};
    use serde_json::Value;

    struct InPlaceEffortSession {
        message_rx: Option<RuntimeMessageRx>,
    }

    struct BlockingFollowUpSession {
        message_rx: Option<RuntimeMessageRx>,
        release: Arc<tokio::sync::Notify>,
    }

    struct RejectingModeSession {
        message_rx: Option<RuntimeMessageRx>,
    }

    impl InPlaceEffortSession {
        fn new() -> Self {
            let (_tx, rx) = mpsc::channel(1);
            Self {
                message_rx: Some(rx),
            }
        }
    }

    impl BlockingFollowUpSession {
        fn new(release: Arc<tokio::sync::Notify>) -> Self {
            let (_tx, rx) = mpsc::channel(1);
            Self {
                message_rx: Some(rx),
                release,
            }
        }
    }

    impl RejectingModeSession {
        fn new() -> Self {
            let (_tx, rx) = mpsc::channel(1);
            Self {
                message_rx: Some(rx),
            }
        }
    }

    #[async_trait::async_trait]
    impl AgentRuntimeSession for InPlaceEffortSession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            self.message_rx.take().unwrap()
        }

        async fn session_id(&self) -> Option<String> {
            Some("runtime-session".to_string())
        }

        async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) {}

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            _mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }

        fn applies_thinking_effort_in_place(&self) -> bool {
            true
        }

        async fn set_thinking_effort(&self, _effort: Option<String>) -> Result<(), RuntimeError> {
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    #[async_trait::async_trait]
    impl AgentRuntimeSession for BlockingFollowUpSession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            self.message_rx.take().unwrap()
        }

        async fn session_id(&self) -> Option<String> {
            Some("runtime-session".to_string())
        }

        async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
            self.release.notified().await;
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) {}

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            _mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    #[async_trait::async_trait]
    impl AgentRuntimeSession for RejectingModeSession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            self.message_rx.take().unwrap()
        }

        async fn session_id(&self) -> Option<String> {
            Some("runtime-session".to_string())
        }

        async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) {}

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            _mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Err(RuntimeError::ControlRequestRejected {
                subtype: "set_permission_mode".to_string(),
                message: "requested mode is unavailable".to_string(),
            })
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    fn make_envelope(domain: &str, action: &str, payload: serde_json::Value) -> WsEnvelope {
        WsEnvelope::new(domain, action, payload)
    }

    async fn make_test_app_state() -> AppState {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        // Create tables needed by handler tests
        sqlx::query(
            r#"CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feature_id INTEGER NOT NULL,
                agent_type TEXT NOT NULL DEFAULT 'session',
                status TEXT NOT NULL DEFAULT 'idle',
                runtime_provider TEXT,
                runtime_session_id TEXT,
                model TEXT,
                permission_mode TEXT,
                has_file_changes INTEGER NOT NULL DEFAULT 0,
                started_at TEXT,
                ended_at TEXT,
                pending_questions TEXT,
                pending_permission TEXT,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                context_window INTEGER NOT NULL DEFAULT 200000,
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

        sqlx::query(
            r#"CREATE TABLE features (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL DEFAULT 1,
                title TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        // Insert default features for tests that reference feature_id = 1 or 2.
        sqlx::query(
            "INSERT INTO features (id, project_id, title) VALUES (1, 1, 'Test Feature'), (2, 1, 'Second Feature')",
        )
            .execute(&pool)
            .await
            .unwrap();

        AppState::with_pool(pool)
    }

    /// Helper: send a session.init envelope and return the db_session_id from the response.
    async fn init_session(
        tx: &WsSender,
        rx: &mut mpsc::UnboundedReceiver<Message>,
        sdk_sessions: &SdkSessions,
        app_state: &AppState,
        feature_id: i64,
    ) -> String {
        init_session_with_payload(
            tx,
            rx,
            sdk_sessions,
            app_state,
            SessionInitPayload {
                provider: None,
                model: None,
                thinking_effort: None,
                permission_mode: None,
                system_prompt: None,
                cwd: Some("/tmp/test".to_string()),
                feature_id: Some(feature_id),
            },
        )
        .await
    }

    async fn init_session_with_payload(
        tx: &WsSender,
        rx: &mut mpsc::UnboundedReceiver<Message>,
        sdk_sessions: &SdkSessions,
        app_state: &AppState,
        payload: SessionInitPayload,
    ) -> String {
        let envelope = make_envelope("session", "init", serde_json::to_value(payload).unwrap());
        dispatch_envelope(envelope, tx, sdk_sessions, app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "initialized");
            let payload: SessionInitializedPayload = serde_json::from_value(env.payload).unwrap();
            payload.session_id
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_unknown_domain_returns_error() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));

        let envelope = make_envelope("unknown_domain", "init", serde_json::json!({}));
        let app_state = make_test_app_state().await;
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "UNKNOWN_DOMAIN");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_unknown_action_returns_error() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));

        let envelope = make_envelope("session", "nonexistent_action", serde_json::json!({}));
        let app_state = make_test_app_state().await;
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "UNKNOWN_ACTION");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_gate_close_clears_pending_gate_without_active_handle() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;
        let pending_permission = serde_json::json!({
            "request_id": "perm_1",
            "tool_name": "Bash",
            "tool_input": { "command": "pnpm test" }
        });
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, pending_permission) VALUES (88, 1, 'session', 'awaiting_user', ?)",
        )
        .bind(pending_permission.to_string())
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let envelope = make_envelope(
            "session",
            "gate.close",
            serde_json::json!({
                "session_id": "88",
                "request_id": "perm_1",
                "reason": "escape"
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "gate.closed");
            assert_eq!(env.payload["session_id"], "88");
            assert_eq!(env.payload["request_id"], "perm_1");
            assert_eq!(env.payload["reason"], "escape");
        } else {
            panic!("expected text message");
        }

        let row: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT pending_permission, pending_questions FROM agent_sessions WHERE id = 88",
        )
        .fetch_one(&app_state.read_pool)
        .await
        .unwrap();
        assert!(row.0.is_none());
        assert!(row.1.is_none());
    }

    #[tokio::test]
    async fn test_gate_close_acks_existing_session_without_pending_gate() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status) VALUES (90, 1, 'session', 'idle')",
        )
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let envelope = make_envelope(
            "session",
            "gate.close",
            serde_json::json!({
                "session_id": "90",
                "request_id": "stale-renderer-gate",
                "reason": "escape"
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "gate.closed");
            assert_eq!(env.payload["session_id"], "90");
            assert_eq!(env.payload["request_id"], "stale-renderer-gate");
            assert_eq!(env.payload["reason"], "escape");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_suspend_clears_pending_gate_without_active_handle() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, pending_questions) VALUES (89, 1, 'session', 'awaiting_user', ?)",
        )
        .bind(r#"[{"question":"Continue?","options":[{"label":"Yes"}]}]"#)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let envelope = make_envelope(
            "session",
            "suspend",
            serde_json::json!({ "session_id": "89" }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "gate.closed");
            assert_eq!(env.payload["session_id"], "89");
            assert_eq!(env.payload["reason"], "sleep");
        } else {
            panic!("expected text message");
        }

        let row: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT pending_permission, pending_questions FROM agent_sessions WHERE id = 89",
        )
        .fetch_one(&app_state.read_pool)
        .await
        .unwrap();
        assert!(row.0.is_none());
        assert!(row.1.is_none());
    }

    #[tokio::test]
    async fn test_parse_session_id() {
        assert_eq!(parse_session_id("42"), Some(42));
        assert_eq!(parse_session_id("abc"), None);
        assert_eq!(parse_session_id(""), None);
    }

    #[tokio::test]
    async fn test_init_creates_session_with_no_resume_for_new_feature() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;

        // Session should exist in memory
        let sessions = sdk_sessions.lock().await;
        let db_id: i64 = session_id.parse().unwrap();
        let handle = sessions.get(&db_id).unwrap();

        // Brand new feature → no resume_session_id
        assert!(handle.resume_session_id.is_none());
    }

    #[tokio::test]
    async fn test_init_captures_resume_session_id_from_db() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;
        let resume_sid = "11111111-1111-4111-8111-111111111111";

        // Pre-create a session row with a runtime_session_id (simulating previous app run)
        sqlx::query(
            "INSERT INTO agent_sessions (feature_id, agent_type, status, runtime_session_id) VALUES (1, 'session', 'paused', ?)"
        )
        .bind(resume_sid)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;

        let sessions = sdk_sessions.lock().await;
        let db_id: i64 = session_id.parse().unwrap();
        let handle = sessions.get(&db_id).unwrap();

        // Should have captured the existing runtime_session_id for resume
        assert_eq!(handle.resume_session_id, Some(resume_sid.to_string()));
    }

    #[tokio::test]
    async fn test_init_no_resume_when_runtime_session_id_is_null() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        // Pre-create a session row WITHOUT runtime_session_id (e.g., after clear)
        sqlx::query(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (1, 'session', 'paused')"
        )
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;

        let sessions = sdk_sessions.lock().await;
        let db_id: i64 = session_id.parse().unwrap();
        let handle = sessions.get(&db_id).unwrap();

        assert!(handle.resume_session_id.is_none());
    }

    #[tokio::test]
    async fn test_prompt_send_without_init_returns_session_not_found() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let envelope = make_envelope(
            "session",
            "prompt.send",
            serde_json::json!({
                "session_id": "999",
                "text": "hello",
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "SESSION_NOT_FOUND");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_first_prompt_broadcasts_agent_before_runtime_spawn() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;
        let missing_cwd = "/tmp/cadencr-test-missing-runtime-cwd";
        let _ = tokio::fs::remove_dir_all(missing_cwd).await;
        let session_id = init_session_with_payload(
            &tx,
            &mut rx,
            &sdk_sessions,
            &app_state,
            SessionInitPayload {
                provider: Some(crate::domain::agents::runtime::DEFAULT_PROVIDER.to_string()),
                model: None,
                thinking_effort: None,
                permission_mode: None,
                system_prompt: None,
                cwd: Some(missing_cwd.to_string()),
                feature_id: Some(1),
            },
        )
        .await;
        let db_id: i64 = session_id.parse().unwrap();
        let mut status_rx = app_state.session_status_tx.subscribe();

        let envelope = make_envelope(
            "session",
            "prompt.send",
            serde_json::json!({
                "session_id": session_id,
                "text": "start working",
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let status_event =
            tokio::time::timeout(std::time::Duration::from_secs(2), status_rx.recv())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(status_event.session_id, db_id);
        assert_eq!(
            status_event.status,
            crate::domain::session_status::AgentStatus::Agent
        );
    }

    #[tokio::test]
    async fn test_init_missing_feature_id_returns_error() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let envelope = make_envelope("session", "init", serde_json::json!({ "cwd": "/tmp/test" }));
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "MISSING_FEATURE_ID");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_init_missing_cwd_returns_error() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let envelope = make_envelope("session", "init", serde_json::json!({ "feature_id": 1 }));
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "MISSING_CWD");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_init_missing_feature_returns_error() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let envelope = make_envelope(
            "session",
            "init",
            serde_json::json!({ "feature_id": 999, "cwd": "/tmp/test" }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "FEATURE_NOT_FOUND");
        } else {
            panic!("expected text message");
        }

        let session_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions")
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
        assert_eq!(session_count, 0);
    }

    #[tokio::test]
    async fn test_init_reuses_existing_session_row() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        // First init creates the row
        let session_id_1 = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        // Second init for same feature reuses the row
        let session_id_2 = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;

        assert_eq!(session_id_1, session_id_2);
    }

    #[tokio::test]
    async fn test_different_features_get_different_sessions() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id_1 = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        let session_id_2 = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 2).await;

        assert_ne!(session_id_1, session_id_2);
    }

    #[tokio::test]
    async fn test_permission_respond_persists_ask_user_question_answer() {
        let app_state = make_test_app_state().await;

        let feature_id = 1i64;
        let db_session_id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (?, 'session', 'running') RETURNING id"
        )
        .bind(feature_id)
        .fetch_one(&app_state.write_pool)
        .await
        .unwrap();

        // Test the persistence logic that handle_permission_respond uses
        // for AskUserQuestion answers (updated_input with answers field).
        let p = WsSessionPersistence::with_session_id(
            app_state.write_pool.clone(),
            feature_id,
            Some(db_session_id),
        );

        // Simulate what handle_permission_respond does for AskUserQuestion
        let updated_input = serde_json::json!({
            "question": "What is the project name?",
            "answers": [["Cadencr"]]
        });
        let answer_text =
            crate::domain::ws_session::question_answers::format_answers_plain_text(&updated_input)
                .unwrap();
        p.persist_user_message(&answer_text).await;

        // Verify it was persisted
        let (role, content, msg_type): (String, String, String) = sqlx::query_as(
            "SELECT role, content, message_type FROM agent_messages WHERE session_id = ?",
        )
        .bind(db_session_id)
        .fetch_one(&app_state.read_pool)
        .await
        .unwrap();

        assert_eq!(role, "user");
        assert_eq!(content, "What is the project name?\nAnswer: Cadencr");
        assert_eq!(msg_type, "user_message");
    }

    #[tokio::test]
    async fn test_permission_respond_no_persist_without_answers() {
        let app_state = make_test_app_state().await;
        let feature_id = 1i64;
        let db_session_id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (?, 'session', 'running') RETURNING id"
        )
        .bind(feature_id)
        .fetch_one(&app_state.write_pool)
        .await
        .unwrap();

        // Permission respond without answers (regular permission, not AskUserQuestion)
        let updated_input = serde_json::json!({
            "tool_name": "Write",
            "file_path": "/tmp/test.txt"
        });

        // The handler checks for structured answers — this should NOT persist anything
        if let Some(answer_text) =
            crate::domain::ws_session::question_answers::format_answers_plain_text(&updated_input)
        {
            let p = WsSessionPersistence::with_session_id(
                app_state.write_pool.clone(),
                feature_id,
                Some(db_session_id),
            );
            p.persist_user_message(&answer_text).await;
        }

        // Verify nothing was persisted
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = ?")
                .bind(db_session_id)
                .fetch_one(&app_state.read_pool)
                .await
                .unwrap();

        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_permission_respond_does_not_persist_question_answer_when_runtime_rejects() {
        let app_state = make_test_app_state().await;
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let feature_id = 1i64;

        let pending_question = serde_json::json!({
            "tool_name": "AskUserQuestion",
            "tool_input": { "question": "Pick a color" },
            "request_id": "q-missing",
            "pattern": null
        });
        let db_session_id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO agent_sessions \
                (feature_id, agent_type, status, runtime_provider, pending_questions) \
             VALUES (?, 'session', 'running', 'opencode', ?) RETURNING id",
        )
        .bind(feature_id)
        .bind(pending_question.to_string())
        .fetch_one(&app_state.write_pool)
        .await
        .unwrap();

        sdk_sessions
            .lock()
            .await
            .insert(db_session_id, make_in_place_effort_handle(feature_id));

        let envelope = make_envelope(
            "session",
            "permission.respond",
            serde_json::json!({
                "session_id": db_session_id.to_string(),
                "request_id": "q-missing",
                "decision": "allow_once",
                "updated_input": {
                    "question": "Pick a color",
                    "answers": { "Pick a color": "Blue" }
                }
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "RUNTIME_PERMISSION_ERROR");
        } else {
            panic!("expected text message");
        }

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = ?")
                .bind(db_session_id)
                .fetch_one(&app_state.read_pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_init_resume_sends_runtime_session_id_message() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;
        let resume_sid = "22222222-2222-4222-8222-222222222222";

        // Pre-create a session row with a runtime_session_id (simulating previous run)
        sqlx::query(
            "INSERT INTO agent_sessions (feature_id, agent_type, status, runtime_session_id) VALUES (1, 'session', 'paused', ?)"
        )
        .bind(resume_sid)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let envelope = make_envelope(
            "session",
            "init",
            serde_json::json!({
                "cwd": "/tmp/test",
                "feature_id": 1,
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        // First message should be "initialized"
        let msg1 = rx.recv().await.unwrap();
        if let Message::Text(text) = msg1 {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "initialized");
        } else {
            panic!("expected text message for initialized");
        }

        // Second message should be "runtime_session_id"
        let msg2 = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv())
            .await
            .expect("timed out waiting for runtime_session_id message")
            .unwrap();
        if let Message::Text(text) = msg2 {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.domain, "session");
            assert_eq!(env.action, "runtime_session_id");
            let sid = env
                .payload
                .get("runtime_session_id")
                .unwrap()
                .as_str()
                .unwrap();
            assert_eq!(sid, resume_sid);
        } else {
            panic!("expected text message for runtime_session_id");
        }
    }

    #[tokio::test]
    async fn test_init_no_resume_does_not_send_runtime_session_id_message() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        // No pre-existing session — brand new feature
        let envelope = make_envelope(
            "session",
            "init",
            serde_json::json!({
                "cwd": "/tmp/test",
                "feature_id": 1,
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        // First message should be "initialized"
        let msg1 = rx.recv().await.unwrap();
        if let Message::Text(text) = msg1 {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "initialized");
        } else {
            panic!("expected text message for initialized");
        }

        // No further messages should be in the channel
        assert!(
            rx.try_recv().is_err(),
            "expected no runtime_session_id message for new session"
        );
    }

    #[tokio::test]
    async fn test_init_rejects_unsupported_provider() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        sqlx::query(
            "INSERT INTO agent_sessions (feature_id, agent_type, status, runtime_provider) VALUES (1, 'session', 'paused', 'not_a_provider')"
        )
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let envelope = make_envelope(
            "session",
            "init",
            serde_json::json!({
                "cwd": "/tmp/test",
                "feature_id": 1,
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "UNSUPPORTED_PROVIDER");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_init_accepts_opencode_provider() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        sqlx::query(
            "INSERT INTO agent_sessions (feature_id, agent_type, status, runtime_provider) VALUES (1, 'session', 'paused', 'opencode')"
        )
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let envelope = make_envelope(
            "session",
            "init",
            serde_json::json!({
                "cwd": "/tmp/test",
                "feature_id": 1,
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "initialized");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_provider_set_updates_pending_session_and_persists_runtime_provider() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;

        let envelope = make_envelope(
            "session",
            "provider.set",
            serde_json::json!({
                "session_id": session_id,
                "provider": "claude_code",
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "provider.set.ok");
            assert_eq!(
                env.payload.get("provider").and_then(|v| v.as_str()),
                Some("claude_code")
            );
        } else {
            panic!("expected text message");
        }

        let db_id: i64 = session_id.parse().unwrap();
        let persisted: Option<String> =
            sqlx::query_scalar("SELECT runtime_provider FROM agent_sessions WHERE id = ?")
                .bind(db_id)
                .fetch_one(&app_state.read_pool)
                .await
                .unwrap();
        assert_eq!(persisted.as_deref(), Some("claude_code"));
    }

    #[tokio::test]
    async fn test_provider_set_rejects_unsupported_provider() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;

        let envelope = make_envelope(
            "session",
            "provider.set",
            serde_json::json!({
                "session_id": session_id,
                "provider": "not_a_provider",
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "UNSUPPORTED_PROVIDER");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_provider_set_accepts_opencode() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;

        let envelope = make_envelope(
            "session",
            "provider.set",
            serde_json::json!({
                "session_id": session_id,
                "provider": "opencode",
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "provider.set.ok");
            assert_eq!(
                env.payload.get("provider").and_then(|v| v.as_str()),
                Some("opencode")
            );
        } else {
            panic!("expected text message");
        }

        let db_id: i64 = session_id.parse().unwrap();
        let sessions = sdk_sessions.lock().await;
        let handle = sessions.get(&db_id).unwrap();
        assert_eq!(handle.runtime_provider, "opencode");
    }

    #[tokio::test]
    async fn test_init_preserves_base_system_prompt_for_opencode() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session_with_payload(
            &tx,
            &mut rx,
            &sdk_sessions,
            &app_state,
            SessionInitPayload {
                provider: Some("opencode".to_string()),
                model: None,
                thinking_effort: None,
                permission_mode: None,
                system_prompt: Some("Base prompt".to_string()),
                cwd: Some("/tmp/test".to_string()),
                feature_id: Some(1),
            },
        )
        .await;

        let db_id: i64 = session_id.parse().unwrap();
        let sessions = sdk_sessions.lock().await;
        let handle = sessions.get(&db_id).unwrap();
        let prompt = handle.config.system_prompt.as_deref().unwrap_or_default();
        assert_eq!(prompt, "Base prompt");
    }

    #[tokio::test]
    async fn test_provider_set_is_locked_once_session_is_active() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        let db_id: i64 = session_id.parse().unwrap();

        {
            let mut sessions = sdk_sessions.lock().await;
            let handle = sessions.get_mut(&db_id).unwrap();
            let (permission_tx, _permission_rx) =
                mpsc::channel::<session_prompt::PermissionResponse>(1);
            handle.state = QueryState::Active {
                query: Arc::new(RwLock::new(Box::new(ClaudeCodeSession::from_query(
                    Query::new_test_stub(Some("active-runtime-session".to_string())),
                )))),
                permission_tx,
            };
        }

        let envelope = make_envelope(
            "session",
            "provider.set",
            serde_json::json!({
                "session_id": session_id,
                "provider": "claude_code",
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "PROVIDER_LOCKED");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_provider_set_is_locked_once_session_has_history() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        let db_id: i64 = session_id.parse().unwrap();

        sqlx::query(
            "INSERT INTO agent_messages (session_id, role, content, message_type) VALUES (?, 'user', 'hello', 'user_message')",
        )
        .bind(db_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let envelope = make_envelope(
            "session",
            "provider.set",
            serde_json::json!({
                "session_id": session_id,
                "provider": "opencode",
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "PROVIDER_LOCKED");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_model_set_updates_pending_session_provider_from_model() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        let db_id: i64 = session_id.parse().unwrap();

        let provider_envelope = make_envelope(
            "session",
            "provider.set",
            serde_json::json!({
                "session_id": session_id,
                "provider": "opencode",
            }),
        );
        dispatch_envelope(provider_envelope, &tx, &sdk_sessions, &app_state).await;
        // provider.set.ok + mode.changed (the per-provider chip reset).
        let _ = rx.recv().await.unwrap();
        let _ = rx.recv().await.unwrap();

        let model_envelope = make_envelope(
            "session",
            "model.set",
            serde_json::json!({
                "session_id": session_id,
                "model": "opus",
            }),
        );
        dispatch_envelope(model_envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "model.set.ok");
        } else {
            panic!("expected text message");
        }

        let persisted: Option<String> =
            sqlx::query_scalar("SELECT runtime_provider FROM agent_sessions WHERE id = ?")
                .bind(db_id)
                .fetch_one(&app_state.read_pool)
                .await
                .unwrap();
        assert_eq!(persisted.as_deref(), Some("claude_code"));
    }

    #[tokio::test]
    async fn test_model_set_rejects_cross_provider_change_once_session_has_history() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        let db_id: i64 = session_id.parse().unwrap();

        let provider_envelope = make_envelope(
            "session",
            "provider.set",
            serde_json::json!({
                "session_id": session_id,
                "provider": "opencode",
            }),
        );
        dispatch_envelope(provider_envelope, &tx, &sdk_sessions, &app_state).await;
        // provider.set.ok + mode.changed (the per-provider chip reset).
        let _ = rx.recv().await.unwrap();
        let _ = rx.recv().await.unwrap();

        sqlx::query(
            "INSERT INTO agent_messages (session_id, role, content, message_type) VALUES (?, 'user', 'hello', 'user_message')",
        )
        .bind(db_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let model_envelope = make_envelope(
            "session",
            "model.set",
            serde_json::json!({
                "session_id": session_id,
                "model": "opus",
            }),
        );
        dispatch_envelope(model_envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "PROVIDER_LOCKED");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_effort_set_updates_spawned_effort_for_in_place_runtime() {
        let app_state = make_test_app_state().await;
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let feature_id = 1i64;

        let db_id = sqlx::query("INSERT INTO agent_sessions (feature_id, agent_type, status, model, runtime_provider) VALUES (?, 'session', 'idle', 'openai/gpt-5.4', 'opencode')")
            .bind(feature_id)
            .execute(&app_state.write_pool)
            .await
            .unwrap()
            .last_insert_rowid();

        {
            let mut sessions = sdk_sessions.lock().await;
            sessions.insert(db_id, make_in_place_effort_handle(feature_id));
        }

        let envelope = make_envelope(
            "session",
            "effort.set",
            serde_json::json!({
                "session_id": db_id.to_string(),
                "thinking_effort": "high",
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "effort.set.ok");
        } else {
            panic!("expected text message");
        }

        let sessions = sdk_sessions.lock().await;
        let handle = sessions.get(&db_id).unwrap();
        assert_eq!(handle.desired_thinking_effort.as_deref(), Some("high"));
        assert_eq!(handle.spawned_thinking_effort.as_deref(), Some("high"));
    }

    /// Helper: insert an SdkHandle with QueryState::Active using a test stub Query.
    fn make_active_handle(feature_id: i64, session_id: Option<String>) -> SdkHandle {
        let query = Query::new_test_stub(session_id);
        let (permission_tx, _permission_rx) =
            mpsc::channel::<session_prompt::PermissionResponse>(1);
        SdkHandle {
            state: QueryState::Active {
                query: Arc::new(RwLock::new(Box::new(ClaudeCodeSession::from_query(query)))),
                permission_tx,
            },
            feature_id,
            runtime_provider: crate::domain::agents::runtime::DEFAULT_PROVIDER.to_string(),
            desired_model: Some("sonnet".to_string()),
            spawned_model: Some("sonnet".to_string()),
            desired_permission_mode: None,
            spawned_permission_mode: None,
            desired_thinking_effort: None,
            spawned_thinking_effort: None,
            runtime_control_endpoint: None,
            resume_session_id: None,
            config: SessionConfig {
                cwd: PathBuf::from("/tmp/test"),
                canonical_cwd: PathBuf::from("/tmp/test"),
                permission_mode: None,
                thinking_effort: None,
                system_prompt: None,
                env: None,
            },
            manual_compact_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    fn make_in_place_effort_handle(feature_id: i64) -> SdkHandle {
        let (permission_tx, _permission_rx) =
            mpsc::channel::<session_prompt::PermissionResponse>(1);
        SdkHandle {
            state: QueryState::Active {
                query: Arc::new(RwLock::new(Box::new(InPlaceEffortSession::new()))),
                permission_tx,
            },
            feature_id,
            runtime_provider: "opencode".to_string(),
            desired_model: Some("openai/gpt-5.4".to_string()),
            spawned_model: Some("openai/gpt-5.4".to_string()),
            desired_permission_mode: None,
            spawned_permission_mode: None,
            desired_thinking_effort: None,
            spawned_thinking_effort: None,
            runtime_control_endpoint: None,
            resume_session_id: None,
            config: SessionConfig {
                cwd: PathBuf::from("/tmp/test"),
                canonical_cwd: PathBuf::from("/tmp/test"),
                permission_mode: None,
                thinking_effort: None,
                system_prompt: None,
                env: None,
            },
            manual_compact_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn test_follow_up_prompt_does_not_block_ws_dispatch() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;
        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        let db_id: i64 = session_id.parse().unwrap();
        let release = Arc::new(tokio::sync::Notify::new());
        let mut status_rx = app_state.session_status_tx.subscribe();

        {
            let mut sessions = sdk_sessions.lock().await;
            let handle = sessions.get_mut(&db_id).unwrap();
            let (permission_tx, _permission_rx) =
                mpsc::channel::<session_prompt::PermissionResponse>(1);
            handle.state = QueryState::Active {
                query: Arc::new(RwLock::new(Box::new(BlockingFollowUpSession::new(
                    release.clone(),
                )))),
                permission_tx,
            };
        }

        let envelope = make_envelope(
            "session",
            "prompt.send",
            serde_json::json!({
                "session_id": session_id,
                "text": "please run another command",
            }),
        );
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state),
        )
        .await;

        release.notify_waiters();
        assert!(
            result.is_ok(),
            "follow-up prompt handling must return without waiting for the provider turn"
        );

        let status_event = status_rx.recv().await.unwrap();
        assert_eq!(status_event.session_id, db_id);
        assert_eq!(
            status_event.status,
            crate::domain::session_status::AgentStatus::Agent
        );
    }

    #[tokio::test]
    async fn test_stream_reader_transitions_active_to_pending_on_stream_close() {
        let app_state = make_test_app_state().await;
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

        let db_session_id = 42i64;
        let feature_id = 1i64;
        let cli_session_id = "cli-sess-for-resume".to_string();

        // Insert an Active handle
        {
            let mut sessions = sdk_sessions.lock().await;
            sessions.insert(
                db_session_id,
                make_active_handle(feature_id, Some(cli_session_id.clone())),
            );
        }

        // Create a message channel and immediately close the sender to simulate stream end
        let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
        drop(msg_tx);

        session_prompt::spawn_stream_reader(
            db_session_id,
            feature_id,
            msg_rx,
            ws_tx,
            app_state.write_pool.clone(),
            app_state.session_status_tx.clone(),
            sdk_sessions.clone(),
            crate::domain::agents::runtime::DEFAULT_PROVIDER.to_string(),
            None,
            None,
        );

        // Wait for the "session.ended" message from the stream reader
        let msg = ws_rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "ended");
            let payload: SessionEndedPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.reason, "stream_closed");
        } else {
            panic!("expected text message");
        }

        // Give the spawned task a moment to complete the state transition
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Verify state transitioned to Pending with resume session ID
        let sessions = sdk_sessions.lock().await;
        let handle = sessions.get(&db_session_id).unwrap();
        match &handle.state {
            QueryState::Pending(options) => {
                assert_eq!(options.resume_session_id, Some(cli_session_id));
                assert_eq!(options.cwd, PathBuf::from("/tmp/test"));
                assert_eq!(options.model, Some("sonnet".to_string()));
            }
            QueryState::Active { .. } => {
                panic!("expected Pending state after stream close, but found Active");
            }
        }
    }

    #[tokio::test]
    async fn test_stream_reader_transitions_active_to_pending_on_error() {
        let app_state = make_test_app_state().await;
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

        let db_session_id = 43i64;
        let feature_id = 2i64;

        // Insert an Active handle (no session ID this time)
        {
            let mut sessions = sdk_sessions.lock().await;
            sessions.insert(db_session_id, make_active_handle(feature_id, None));
        }

        // Create session row for mark_paused_static
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status) VALUES (?, ?, 'session', 'running')"
        )
        .bind(db_session_id)
        .bind(feature_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        // Send an error through the channel
        let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
        msg_tx
            .send(Err(RuntimeError::from(SdkError::ProcessExit {
                code: Some(1),
                stderr: "something went wrong".to_string(),
            })))
            .await
            .unwrap();
        drop(msg_tx);

        session_prompt::spawn_stream_reader(
            db_session_id,
            feature_id,
            msg_rx,
            ws_tx,
            app_state.write_pool.clone(),
            app_state.session_status_tx.clone(),
            sdk_sessions.clone(),
            crate::domain::agents::runtime::DEFAULT_PROVIDER.to_string(),
            None,
            None,
        );

        // Wait for the error message
        let msg = ws_rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
        } else {
            panic!("expected text message");
        }

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Verify state transitioned to Pending with no resume (no session ID)
        let sessions = sdk_sessions.lock().await;
        let handle = sessions.get(&db_session_id).unwrap();
        match &handle.state {
            QueryState::Pending(options) => {
                assert_eq!(options.resume_session_id, None);
            }
            QueryState::Active { .. } => {
                panic!("expected Pending state after stream error, but found Active");
            }
        }
    }

    #[tokio::test]
    async fn test_stream_reader_no_transition_when_session_removed() {
        // If the session was already removed from the map (e.g., destroy),
        // the stream reader should not panic.
        let app_state = make_test_app_state().await;
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

        // Don't insert any handle — simulate it being removed

        let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
        drop(msg_tx);

        session_prompt::spawn_stream_reader(
            99,
            1,
            msg_rx,
            ws_tx,
            app_state.write_pool.clone(),
            app_state.session_status_tx.clone(),
            sdk_sessions.clone(),
            crate::domain::agents::runtime::DEFAULT_PROVIDER.to_string(),
            None,
            None,
        );

        // Should still get the ended message
        let msg = ws_rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "ended");
        }

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // No panic, no handle in map — just a no-op
        assert!(sdk_sessions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn test_stream_reader_routes_acp_permission_request() {
        let app_state = make_test_app_state().await;
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

        let db_session_id = 77i64;
        let feature_id = 1i64;

        {
            let mut sessions = sdk_sessions.lock().await;
            sessions.insert(db_session_id, make_active_handle(feature_id, None));
        }

        let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(4);
        let event = RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("sess-opencode".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({
                    "type": "acp_permission_request",
                    "request_id": "perm-1",
                    "tool_name": "Write",
                    "tool_input": { "file_path": "/tmp/a.txt" },
                    "description": "needs permission",
                }),
            },
            crate::domain::agents::adapter::RuntimeEventKind::Other,
        );
        msg_tx.send(Ok(event)).await.unwrap();
        drop(msg_tx);

        session_prompt::spawn_stream_reader(
            db_session_id,
            feature_id,
            msg_rx,
            ws_tx,
            app_state.write_pool.clone(),
            app_state.session_status_tx.clone(),
            sdk_sessions,
            "opencode".to_string(),
            None,
            None,
        );

        let msg = ws_rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "permission.request");
            assert_eq!(
                env.payload.get("request_id").and_then(|v| v.as_str()),
                Some("perm-1")
            );
            assert_eq!(
                env.payload.get("tool_name").and_then(|v| v.as_str()),
                Some("Write")
            );
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_stream_reader_result_keeps_pending_user_input_status() {
        let app_state = make_test_app_state().await;
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
        let mut status_rx = app_state.session_status_tx.subscribe();
        let db_session_id = 78i64;
        let feature_id = 1i64;

        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, pending_permission) VALUES (?, ?, 'session', 'running', '{}')",
        )
        .bind(db_session_id)
        .bind(feature_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
        msg_tx
            .send(Ok(RuntimeEvent::new(
                crate::domain::agents::adapter::RuntimeEventMetadata::default(),
                RuntimeEventKind::Result,
            )))
            .await
            .unwrap();
        drop(msg_tx);

        session_prompt::spawn_stream_reader(
            db_session_id,
            feature_id,
            msg_rx,
            ws_tx,
            app_state.write_pool.clone(),
            app_state.session_status_tx.clone(),
            sdk_sessions,
            "codex".to_string(),
            None,
            None,
        );

        while let Some(Message::Text(text)) = ws_rx.recv().await {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            if env.action == "ended" {
                break;
            }
        }

        assert!(
            matches!(
                status_rx.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            ),
            "turn result must not broadcast idle while permission/question input is pending"
        );
    }

    #[tokio::test]
    async fn test_prompt_send_with_invalid_session_id_returns_error() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let envelope = make_envelope(
            "session",
            "prompt.send",
            serde_json::json!({
                "session_id": "not-a-number",
                "text": "hello",
            }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "INVALID_SESSION_ID");
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_app_subscribe_session_status_sends_snapshot() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let envelope = make_envelope("app", "subscribe.session_status", serde_json::json!({}));
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.domain, "app");
            assert_eq!(env.action, "session_status.snapshot");
            // Payload should have a "states" object (empty since no running sessions)
            let states = env.payload.get("states").unwrap();
            assert!(states.is_object());
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_app_subscribe_forwards_broadcast_updates() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let envelope = make_envelope("app", "subscribe.session_status", serde_json::json!({}));
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        // Drain the snapshot message
        let _ = rx.recv().await.unwrap();

        // Broadcast a status change for session 7 / feature 42.
        WsSessionPersistence::broadcast_session_status(
            &app_state.session_status_tx,
            7,
            42,
            crate::domain::session_status::AgentStatus::Question,
            Some(crate::domain::session_status::PendingKind::Permission),
        );

        // Give the forwarding task a moment to process
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.domain, "app");
            assert_eq!(env.action, "session_status.update");
            assert_eq!(env.payload.get("session_id").unwrap().as_i64().unwrap(), 7,);
            assert_eq!(env.payload.get("feature_id").unwrap().as_i64().unwrap(), 42);
            assert_eq!(
                env.payload.get("status").unwrap().as_str().unwrap(),
                "question",
            );
            assert_eq!(
                env.payload.get("kind").unwrap().as_str().unwrap(),
                "permission",
            );
            // Every update carries a monotonic seq so the frontend can reject
            // out-of-order state transitions.
            assert!(env.payload.get("seq").unwrap().as_u64().unwrap() > 0);
        } else {
            panic!("expected text message");
        }
    }

    #[tokio::test]
    async fn test_app_unknown_action_does_not_error() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let envelope = make_envelope("app", "unknown_action", serde_json::json!({}));
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        // No message sent (unknown actions are silently ignored)
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn test_session_delete_paused_session() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        // Create and pause a session
        let session_id_str = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        let db_session_id: i64 = session_id_str.parse().unwrap();
        WsSessionPersistence::mark_paused_static(&app_state.write_pool, db_session_id).await;

        let envelope = make_envelope(
            "session",
            "delete",
            serde_json::json!({ "session_id": session_id_str }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "deleted");
        } else {
            panic!("expected text message");
        }

        // Verify DB row is gone
        let row: Option<(i64,)> = sqlx::query_as("SELECT id FROM agent_sessions WHERE id = ?")
            .bind(db_session_id)
            .fetch_optional(&app_state.read_pool)
            .await
            .unwrap();
        assert!(row.is_none());
    }

    #[tokio::test]
    async fn test_session_delete_running_session_fails() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        // Create a session and mark it running (simulating active SDK query)
        let session_id_str = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        let session_id: i64 = session_id_str.parse().unwrap();
        WsSessionPersistence::mark_running_static(&app_state.write_pool, session_id).await;

        let envelope = make_envelope(
            "session",
            "delete",
            serde_json::json!({ "session_id": session_id_str }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "DELETE_FAILED");
        } else {
            panic!("expected text message");
        }
    }

    // ----- parse_permission_mode + provider_supports_mode -----

    #[test]
    fn parse_permission_mode_recognizes_auto() {
        assert_eq!(parse_permission_mode("auto"), RuntimePermissionMode::Auto);
    }

    #[test]
    fn parse_permission_mode_falls_back_to_default_for_unknown() {
        assert_eq!(
            parse_permission_mode("not-a-mode"),
            RuntimePermissionMode::Default
        );
    }

    #[test]
    fn claude_code_supports_every_mode() {
        for mode in [
            RuntimePermissionMode::Default,
            RuntimePermissionMode::AcceptEdits,
            RuntimePermissionMode::Plan,
            RuntimePermissionMode::Auto,
            RuntimePermissionMode::BypassPermissions,
            RuntimePermissionMode::DontAsk,
        ] {
            assert!(
                provider_supports_mode("claude_code", &mode),
                "claude_code should support {mode:?}"
            );
        }
    }

    #[test]
    fn opencode_supports_only_build_and_plan_levels() {
        assert!(provider_supports_mode(
            "opencode",
            &RuntimePermissionMode::Default
        ));
        assert!(provider_supports_mode(
            "opencode",
            &RuntimePermissionMode::AcceptEdits
        ));
        assert!(provider_supports_mode(
            "opencode",
            &RuntimePermissionMode::Plan
        ));
        assert!(!provider_supports_mode(
            "opencode",
            &RuntimePermissionMode::Auto
        ));
        assert!(!provider_supports_mode(
            "opencode",
            &RuntimePermissionMode::BypassPermissions
        ));
    }

    #[test]
    fn codex_supports_default_plan_and_full_access() {
        assert!(provider_supports_mode(
            "codex_cli",
            &RuntimePermissionMode::Default
        ));
        assert!(provider_supports_mode(
            "codex_cli",
            &RuntimePermissionMode::Plan
        ));
        assert!(provider_supports_mode(
            "codex_cli",
            &RuntimePermissionMode::BypassPermissions
        ));
        assert!(!provider_supports_mode(
            "codex_cli",
            &RuntimePermissionMode::Auto
        ));
        assert!(!provider_supports_mode(
            "codex_cli",
            &RuntimePermissionMode::DontAsk
        ));
    }

    #[test]
    fn default_permission_mode_wire_matches_frontend_catalog() {
        // These wire strings must match `defaultEditModeFor` in
        // packages/desktop/src/lib/provider-modes.ts. Drift between BE/FE here
        // would silently put the chip in a state the backend never wrote.
        assert_eq!(default_permission_mode_wire("claude_code"), "acceptEdits");
        assert_eq!(default_permission_mode_wire("opencode"), "acceptEdits");
        assert_eq!(default_permission_mode_wire("codex_cli"), "default");
        assert_eq!(default_permission_mode_wire("__unknown__"), "acceptEdits");
    }

    #[test]
    fn post_plan_approval_mode_wire_matches_frontend_catalog() {
        // OpenCode + Codex inherit their `default_permission_mode_wire` since
        // they don't have a classifier-backed mode. The Claude branch is
        // exercised by adapter-level tests with a seeded model catalog —
        // here we just confirm the dispatch + non-Claude fallbacks.
        assert_eq!(
            post_plan_approval_mode_wire("opencode", None),
            "acceptEdits"
        );
        assert_eq!(
            post_plan_approval_mode_wire("opencode", Some("opencode-default")),
            "acceptEdits"
        );
        assert_eq!(post_plan_approval_mode_wire("codex_cli", None), "default");
        assert_eq!(
            post_plan_approval_mode_wire("codex_cli", Some("gpt-5")),
            "default"
        );
        assert_eq!(
            post_plan_approval_mode_wire("__unknown__", None),
            "acceptEdits"
        );
    }

    // ----- handle_mode_set integration: provider/mode validation -----

    #[tokio::test]
    async fn mode_set_rejects_modes_not_supported_by_active_provider() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        // Init an OpenCode session.
        let session_id = init_session_with_payload(
            &tx,
            &mut rx,
            &sdk_sessions,
            &app_state,
            SessionInitPayload {
                provider: Some("opencode".to_string()),
                model: None,
                thinking_effort: None,
                permission_mode: None,
                system_prompt: None,
                cwd: Some("/tmp/test".to_string()),
                feature_id: Some(1),
            },
        )
        .await;

        // Ask for `auto` — Claude-only. The handler must reject it via
        // MODE_NOT_SUPPORTED instead of silently writing the mode through to
        // the OpenCode adapter (which would launch the wrong agent).
        let envelope = make_envelope(
            "session",
            "mode.set",
            serde_json::json!({ "session_id": session_id, "mode": "auto" }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "MODE_NOT_SUPPORTED");
        } else {
            panic!("expected text message");
        }

        // Sanity: the in-memory handle's desired mode wasn't poisoned by the
        // failed request. session.init seeds the active provider's default
        // when the client doesn't supply one; a rejected mode.set must leave
        // that untouched.
        let sessions = sdk_sessions.lock().await;
        let db_id: i64 = session_id.parse().unwrap();
        let handle = sessions.get(&db_id).unwrap();
        assert_eq!(
            handle.desired_permission_mode,
            Some(default_permission_mode("opencode"))
        );
    }

    #[tokio::test]
    async fn mode_set_rejection_keeps_accepted_mode_as_desired_mode() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, permission_mode) VALUES (77, 1, 'session', 'idle', 'plan')",
        )
        .execute(&app_state.write_pool)
        .await
        .unwrap();

        let (permission_tx, _permission_rx) = mpsc::channel(1);
        let query: RuntimeSessionHandle =
            Arc::new(RwLock::new(Box::new(RejectingModeSession::new())));
        sdk_sessions.lock().await.insert(
            77,
            SdkHandle {
                state: QueryState::Active {
                    query,
                    permission_tx,
                },
                feature_id: 1,
                runtime_provider: "claude_code".to_string(),
                desired_model: None,
                spawned_model: None,
                desired_permission_mode: Some(RuntimePermissionMode::Plan),
                spawned_permission_mode: Some(RuntimePermissionMode::Plan),
                desired_thinking_effort: None,
                spawned_thinking_effort: None,
                runtime_control_endpoint: None,
                resume_session_id: None,
                config: SessionConfig {
                    cwd: PathBuf::from("/tmp/test"),
                    canonical_cwd: PathBuf::from("/tmp/test"),
                    permission_mode: Some(RuntimePermissionMode::Plan),
                    thinking_effort: None,
                    system_prompt: None,
                    env: None,
                },
                manual_compact_cancel: Arc::new(AtomicBool::new(false)),
            },
        );

        let envelope = make_envelope(
            "session",
            "mode.set",
            serde_json::json!({ "session_id": "77", "mode": "bypassPermissions" }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "error");
            let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
            assert_eq!(payload.code, "MODE_REJECTED_BY_CLI");
            assert_eq!(payload.mode.as_deref(), Some("bypassPermissions"));
        } else {
            panic!("expected text message");
        }

        let (desired_mode, spawned_mode, config_mode) = {
            let sessions = sdk_sessions.lock().await;
            let handle = sessions.get(&77).unwrap();
            (
                handle.desired_permission_mode.clone(),
                handle.spawned_permission_mode.clone(),
                handle.config.permission_mode.clone(),
            )
        };
        assert_eq!(desired_mode, Some(RuntimePermissionMode::Plan));
        assert_eq!(spawned_mode, Some(RuntimePermissionMode::Plan));
        assert_eq!(config_mode, Some(RuntimePermissionMode::Plan));

        let persisted_mode: Option<String> =
            sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE id = 77")
                .fetch_one(&app_state.read_pool)
                .await
                .unwrap();
        assert_eq!(persisted_mode.as_deref(), Some("plan"));
    }

    // ----- handle_provider_set: mode reset + mode.changed broadcast -----

    #[tokio::test]
    async fn provider_set_resets_permission_mode_and_broadcasts_mode_changed() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        // Start in Claude with `plan` selected.
        let session_id = init_session_with_payload(
            &tx,
            &mut rx,
            &sdk_sessions,
            &app_state,
            SessionInitPayload {
                provider: Some("claude_code".to_string()),
                model: None,
                thinking_effort: None,
                permission_mode: Some("plan".to_string()),
                system_prompt: None,
                cwd: Some("/tmp/test".to_string()),
                feature_id: Some(1),
            },
        )
        .await;

        // Drain any extra messages from init (e.g. runtime_session_id).
        while rx.try_recv().is_ok() {}

        // Switch to Codex pre-conversation.
        let envelope = make_envelope(
            "session",
            "provider.set",
            serde_json::json!({ "session_id": session_id, "provider": "codex_cli" }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        // Two envelopes back: provider.set.ok, then mode.changed.
        let mut saw_provider_ok = false;
        let mut saw_mode_changed = false;
        for _ in 0..2 {
            let msg = rx.recv().await.unwrap();
            if let Message::Text(text) = msg {
                let env: WsEnvelope = serde_json::from_str(&text).unwrap();
                if env.action == "provider.set.ok" {
                    saw_provider_ok = true;
                } else if env.action == "mode.changed" {
                    saw_mode_changed = true;
                    let mode = env.payload.get("mode").and_then(|v| v.as_str()).unwrap();
                    assert_eq!(mode, "default", "Codex's default chip mode is `default`");
                }
            }
        }
        assert!(saw_provider_ok, "expected provider.set.ok envelope");
        assert!(
            saw_mode_changed,
            "expected mode.changed envelope after provider switch"
        );

        // Internal state was scrubbed — next spawn will pick the Codex
        // adapter's default rather than carry the stale Claude `Plan`.
        let sessions = sdk_sessions.lock().await;
        let db_id: i64 = session_id.parse().unwrap();
        let handle = sessions.get(&db_id).unwrap();
        assert!(handle.desired_permission_mode.is_none());
        assert!(handle.config.permission_mode.is_none());
        if let QueryState::Pending(options) = &handle.state {
            assert!(options.permission_mode.is_none());
        } else {
            panic!("expected pending state");
        }
    }

    #[tokio::test]
    async fn provider_set_to_same_provider_is_a_noop_for_mode_state() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;

        let session_id = init_session_with_payload(
            &tx,
            &mut rx,
            &sdk_sessions,
            &app_state,
            SessionInitPayload {
                provider: Some("claude_code".to_string()),
                model: None,
                thinking_effort: None,
                permission_mode: Some("plan".to_string()),
                system_prompt: None,
                cwd: Some("/tmp/test".to_string()),
                feature_id: Some(1),
            },
        )
        .await;
        while rx.try_recv().is_ok() {}

        let envelope = make_envelope(
            "session",
            "provider.set",
            serde_json::json!({ "session_id": session_id, "provider": "claude_code" }),
        );
        dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

        // Only provider.set.ok; no mode.changed since nothing changed.
        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(env.action, "provider.set.ok");
        }
        assert!(
            rx.try_recv().is_err(),
            "no mode.changed should fire when provider didn't actually change"
        );

        let sessions = sdk_sessions.lock().await;
        let db_id: i64 = session_id.parse().unwrap();
        let handle = sessions.get(&db_id).unwrap();
        assert_eq!(
            handle.desired_permission_mode,
            Some(RuntimePermissionMode::Plan),
            "permission mode preserved on same-provider re-set"
        );
    }
}
