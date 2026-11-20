//! `session.gate.close` and `session.suspend`: clearing pending gates and
//! acking sessions without an active handle.

use super::support::*;

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

    // No gate is open: the close is stale. It used to be acknowledged as
    // closed and to stop whatever ran; the renderer now drops its own stale
    // gate on this answer.
    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "error");
        assert_eq!(env.payload["code"], "STALE_GATE");
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
