//! `app.subscribe.session_status` (snapshot + broadcast forwarding), the
//! silent unknown-action path, and `session.delete`.

use super::support::*;

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

#[tokio::test]
async fn test_session_delete_running_session_keeps_in_memory_handle() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;

    let session_id_str = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
    let session_id: i64 = session_id_str.parse().unwrap();
    WsSessionPersistence::mark_running_static(&app_state.write_pool, session_id).await;
    sdk_sessions.lock().await.insert(
        session_id,
        make_active_handle(1, Some("runtime-session".to_string())),
    );

    let envelope = make_envelope(
        "session",
        "delete",
        serde_json::json!({ "session_id": session_id_str }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let _ = rx.recv().await.unwrap();
    assert!(sdk_sessions.lock().await.contains_key(&session_id));
}
