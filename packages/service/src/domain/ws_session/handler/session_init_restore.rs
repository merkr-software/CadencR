//! Pending user-input restoration for `session.init`.

use axum::extract::ws::Message;
use serde_json::Value;

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::{PermissionRequestPayload, WsEnvelope};
use super::super::WsSender;
use crate::app_state::AppState;
use crate::domain::session_status::{AgentStatus, PendingKind};

pub(super) async fn restore_pending_or_idle(
    app_state: &AppState,
    sender: &WsSender,
    db_session_id: i64,
    feature_id: i64,
) {
    let row = WsSessionPersistence::get_session_row(&app_state.read_pool, db_session_id).await;
    if let Some(ref row) = row {
        if let Some(payload) = row
            .pending_permission
            .as_deref()
            .and_then(|value| serde_json::from_str::<PermissionRequestPayload>(value).ok())
        {
            send_pending(
                app_state,
                sender,
                db_session_id,
                feature_id,
                payload,
                PendingKind::Permission,
            );
            return;
        }
        if let Some(payload) = row
            .pending_questions
            .as_deref()
            .and_then(pending_question_payload)
        {
            send_pending(
                app_state,
                sender,
                db_session_id,
                feature_id,
                payload,
                PendingKind::Question,
            );
            return;
        }
    }

    // No pending user input. Do NOT broadcast Idle if the turn is still
    // running on another connection — a second device opening the conversation
    // would otherwise reset the host's running status and elapsed timer. The
    // joining client already receives the live status via the session_status
    // snapshot it subscribed to at connect. We only clear + idle when the
    // session is genuinely not running.
    let turn_running = row.as_ref().is_some_and(|r| r.status == "running")
        || app_state
            .active_turns
            .started_at(db_session_id)
            .await
            .is_some();
    if turn_running {
        return;
    }
    clear_stale_pending(app_state, db_session_id, feature_id).await;
}

fn send_pending(
    app_state: &AppState,
    sender: &WsSender,
    db_session_id: i64,
    feature_id: i64,
    payload: PermissionRequestPayload,
    kind: PendingKind,
) {
    let envelope = WsEnvelope::new(
        "session",
        "permission.request",
        serde_json::to_value(payload).unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(envelope).into()));
    WsSessionPersistence::broadcast_session_status(
        &app_state.session_status_tx,
        db_session_id,
        feature_id,
        AgentStatus::Question,
        Some(kind),
    );
}

async fn clear_stale_pending(app_state: &AppState, db_session_id: i64, feature_id: i64) {
    WsSessionPersistence::clear_all_pending_user_input_static(&app_state.write_pool, db_session_id)
        .await;
    WsSessionPersistence::broadcast_session_status(
        &app_state.session_status_tx,
        db_session_id,
        feature_id,
        AgentStatus::Idle,
        None,
    );
}

pub(super) fn pending_question_payload(value: &str) -> Option<PermissionRequestPayload> {
    if let Ok(payload) = serde_json::from_str::<PermissionRequestPayload>(value) {
        return Some(payload);
    }
    let raw = serde_json::from_str::<Value>(value).ok()?;
    Some(PermissionRequestPayload {
        request_id: raw.get("request_id").and_then(Value::as_str)?.to_string(),
        tool_name: raw
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("AskUserQuestion")
            .to_string(),
        tool_input: raw.get("tool_input").cloned().unwrap_or(Value::Null),
        description: raw
            .get("description")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        pattern: raw
            .get("pattern")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        preview: raw
            .get("preview")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        options: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::{pending_question_payload, restore_pending_or_idle};
    use crate::app_state::AppState;
    use crate::domain::session_status::{AgentStatus, PendingKind};
    use axum::extract::ws::Message;
    use serde_json::json;
    use sqlx::SqlitePool;
    use tokio::sync::mpsc;

    async fn test_state() -> AppState {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY,
                feature_id INTEGER NOT NULL,
                agent_type TEXT NOT NULL DEFAULT 'session',
                status TEXT NOT NULL DEFAULT 'idle',
                runtime_provider TEXT,
                runtime_session_id TEXT,
                model TEXT,
                profile TEXT,
                permission_mode TEXT,
                codex_permission_mode TEXT DEFAULT 'default',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                context_window INTEGER NOT NULL DEFAULT 200000,
                pending_permission TEXT,
                pending_questions TEXT,
                thinking_effort TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        AppState::with_pool(pool)
    }

    #[test]
    fn pending_question_payload_accepts_reduced_shape() {
        let stored = json!({
            "tool_name": "AskUserQuestion",
            "tool_input": { "question": "Proceed?" },
            "request_id": "req_1",
            "pattern": null
        })
        .to_string();

        let payload = pending_question_payload(&stored).expect("payload");
        assert_eq!(payload.request_id, "req_1");
        assert_eq!(payload.tool_name, "AskUserQuestion");
        assert_eq!(payload.tool_input["question"], "Proceed?");
    }

    #[test]
    fn pending_question_payload_accepts_legacy_full_shape() {
        let stored = json!({
            "request_id": "req_2",
            "tool_name": "AskUserQuestion",
            "tool_input": { "question": "Continue?" },
            "description": "Codex question",
            "pattern": null,
            "preview": null,
            "options": []
        })
        .to_string();

        let payload = pending_question_payload(&stored).expect("payload");
        assert_eq!(payload.request_id, "req_2");
        assert_eq!(payload.description.as_deref(), Some("Codex question"));
    }

    #[tokio::test]
    async fn restore_pending_permission_emits_request_and_status() {
        let state = test_state().await;
        let payload = json!({
            "request_id": "perm_1",
            "tool_name": "Bash",
            "tool_input": { "command": "ls" },
            "description": "Run command",
            "pattern": null,
            "preview": null,
            "options": []
        })
        .to_string();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, pending_permission) VALUES (1, 10, ?)",
        )
        .bind(payload)
        .execute(&state.write_pool)
        .await
        .unwrap();
        let mut status_rx = state.session_status_tx.subscribe();
        let (sender, mut rx) = mpsc::unbounded_channel();

        restore_pending_or_idle(&state, &sender, 1, 10).await;

        let Message::Text(text) = rx.recv().await.unwrap() else {
            panic!("expected text envelope");
        };
        assert!(text.contains("permission.request"));
        assert!(text.contains("perm_1"));
        let status = status_rx.recv().await.unwrap();
        assert_eq!(status.status, AgentStatus::Question);
        assert_eq!(status.kind, Some(PendingKind::Permission));
    }

    #[tokio::test]
    async fn restore_without_pending_input_clears_stale_columns_and_broadcasts_idle() {
        let state = test_state().await;
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, pending_permission) VALUES (2, 20, NULL)",
        )
        .execute(&state.write_pool)
        .await
        .unwrap();
        let mut status_rx = state.session_status_tx.subscribe();
        let (sender, mut rx) = mpsc::unbounded_channel();

        restore_pending_or_idle(&state, &sender, 2, 20).await;

        assert!(rx.try_recv().is_err());
        let status = status_rx.recv().await.unwrap();
        assert_eq!(status.status, AgentStatus::Idle);
        assert_eq!(status.kind, None);
    }

    /// A second device opening a *running* conversation (no pending input)
    /// must not broadcast Idle — that would reset the host's running status
    /// and elapsed timer. Regression guard for the multi-device status bug.
    #[tokio::test]
    async fn restore_on_running_session_does_not_broadcast_idle() {
        let state = test_state().await;
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, status, pending_permission) \
             VALUES (3, 30, 'running', NULL)",
        )
        .execute(&state.write_pool)
        .await
        .unwrap();
        let mut status_rx = state.session_status_tx.subscribe();
        let (sender, mut rx) = mpsc::unbounded_channel();

        restore_pending_or_idle(&state, &sender, 3, 30).await;

        // No permission/question envelope, and crucially no status broadcast.
        assert!(rx.try_recv().is_err());
        assert!(status_rx.try_recv().is_err());
    }
}
