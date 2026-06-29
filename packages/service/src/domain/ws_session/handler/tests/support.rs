//! Shared test scaffolding for the handler dispatch-layer tests: the
//! glob re-exports the per-test files rely on, the in-memory mock runtime
//! sessions, and the small `make_*` / `init_session*` helpers.

#![allow(unused_imports)]

// Re-export the handler-internal helpers and types the tests reach for.
// `super::super` is the `handler` module; these mirror the imports the
// pre-split inline `tests` module pulled in via `super::*`.
pub(super) use super::super::dispatch::dispatch_envelope;
pub(super) use super::super::helpers::{
    default_permission_mode, default_permission_mode_wire, parse_permission_mode, parse_session_id,
    persist_and_close_query, post_plan_approval_mode_wire, provider_supports_mode, send_error,
    send_runtime_session_id,
};
pub(super) use super::super::session_prompt;
pub(super) use super::super::types::{QueryState, SdkHandle, SdkSessions, SessionConfig, WsSender};

pub(super) use crate::app_state::AppState;
pub(super) use crate::domain::ws_session::persistence::WsSessionPersistence;
pub(super) use crate::domain::ws_session::protocol::*;
pub(super) use axum::extract::ws::Message;
pub(super) use std::collections::HashMap;
pub(super) use std::path::PathBuf;
pub(super) use std::sync::atomic::AtomicBool;
pub(super) use std::sync::Arc;
pub(super) use tokio::sync::{mpsc, Mutex, RwLock};

pub(super) use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeAccessMode, RuntimeError, RuntimeEvent, RuntimeEventKind,
    RuntimeMcpServerStatus, RuntimeMessageRx, RuntimePermissionMode, RuntimeSessionHandle,
};
pub(super) use crate::domain::agents::claude_code::ClaudeCodeSession;
pub(super) use claude_agent_sdk_rs::{Query, SdkError};
pub(super) use serde_json::Value;

// Re-exported so the `use super::support::*` glob keeps reaching it; the body
// lives in its own module to keep this file under the size limit.
pub(super) use super::reader_spawn::spawn_test_stream_reader;

pub(crate) struct InPlaceEffortSession {
    message_rx: Option<RuntimeMessageRx>,
}

pub(crate) struct BlockingFollowUpSession {
    message_rx: Option<RuntimeMessageRx>,
    release: Arc<tokio::sync::Notify>,
}

pub(crate) struct RejectingModeSession {
    message_rx: Option<RuntimeMessageRx>,
}

impl InPlaceEffortSession {
    pub(crate) fn new() -> Self {
        let (_tx, rx) = mpsc::channel(1);
        Self {
            message_rx: Some(rx),
        }
    }
}

impl BlockingFollowUpSession {
    pub(crate) fn new(release: Arc<tokio::sync::Notify>) -> Self {
        let (_tx, rx) = mpsc::channel(1);
        Self {
            message_rx: Some(rx),
            release,
        }
    }
}

impl RejectingModeSession {
    pub(crate) fn new() -> Self {
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

    async fn set_permission_mode(&self, _mode: RuntimePermissionMode) -> Result<(), RuntimeError> {
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

    async fn set_permission_mode(&self, _mode: RuntimePermissionMode) -> Result<(), RuntimeError> {
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

    async fn set_permission_mode(&self, _mode: RuntimePermissionMode) -> Result<(), RuntimeError> {
        Err(RuntimeError::ControlRequestRejected {
            subtype: "set_permission_mode".to_string(),
            message: "requested mode is unavailable".to_string(),
        })
    }

    fn pid(&self) -> Option<u32> {
        None
    }
}

pub(crate) fn make_envelope(domain: &str, action: &str, payload: serde_json::Value) -> WsEnvelope {
    WsEnvelope::new(domain, action, payload)
}

pub(crate) async fn make_test_app_state() -> AppState {
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
                profile TEXT,
                permission_mode TEXT,
                codex_permission_mode TEXT DEFAULT 'default',
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
pub(crate) async fn init_session(
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

pub(crate) async fn init_session_with_payload(
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

/// Helper: insert an SdkHandle with QueryState::Active using a test stub Query.
pub(crate) fn make_active_handle(feature_id: i64, session_id: Option<String>) -> SdkHandle {
    let query = Query::new_test_stub(session_id);
    let (permission_tx, _permission_rx) = mpsc::channel::<session_prompt::PermissionResponse>(1);
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
        desired_access_mode: None,
        spawned_access_mode: None,
        desired_thinking_effort: None,
        spawned_thinking_effort: None,
        desired_claude_profile: None,
        spawned_claude_profile: None,
        runtime_control_endpoint: None,
        resume_session_id: None,
        config: SessionConfig {
            cwd: PathBuf::from("/tmp/test"),
            canonical_cwd: PathBuf::from("/tmp/test"),
            permission_mode: None,
            access_mode: None,
            thinking_effort: None,
            system_prompt: None,
            allow_bypass_permissions: false,
            claude_profile: None,
            env: None,
        },
        manual_compact_cancel: Arc::new(AtomicBool::new(false)),
        manual_compact_spawn_pending: Arc::new(AtomicBool::new(false)),
    }
}

pub(crate) fn make_in_place_effort_handle(feature_id: i64) -> SdkHandle {
    let (permission_tx, _permission_rx) = mpsc::channel::<session_prompt::PermissionResponse>(1);
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
        desired_access_mode: None,
        spawned_access_mode: None,
        desired_thinking_effort: None,
        spawned_thinking_effort: None,
        desired_claude_profile: None,
        spawned_claude_profile: None,
        runtime_control_endpoint: None,
        resume_session_id: None,
        config: SessionConfig {
            cwd: PathBuf::from("/tmp/test"),
            canonical_cwd: PathBuf::from("/tmp/test"),
            permission_mode: None,
            access_mode: None,
            thinking_effort: None,
            system_prompt: None,
            allow_bypass_permissions: false,
            claude_profile: None,
            env: None,
        },
        manual_compact_cancel: Arc::new(AtomicBool::new(false)),
        manual_compact_spawn_pending: Arc::new(AtomicBool::new(false)),
    }
}
