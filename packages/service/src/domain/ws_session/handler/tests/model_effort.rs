//! `model.set` provider inference / cross-provider locking and the
//! in-place `effort.set` path.

use super::support::*;

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

#[tokio::test]
async fn test_opencode_model_set_clears_effort_when_new_model_does_not_support_it() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let feature_id = 1i64;

    let db_id = sqlx::query("INSERT INTO agent_sessions (feature_id, agent_type, status, model, runtime_provider, thinking_effort) VALUES (?, 'session', 'idle', 'openai/gpt-5.5', 'opencode', 'high')")
        .bind(feature_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap()
        .last_insert_rowid();

    let mut handle = make_in_place_effort_handle(feature_id);
    handle.desired_model = Some("openai/gpt-5.5".to_string());
    handle.spawned_model = Some("openai/gpt-5.5".to_string());
    handle.desired_thinking_effort = Some("high".to_string());
    handle.spawned_thinking_effort = Some("high".to_string());
    handle.config.thinking_effort = Some("high".to_string());
    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(db_id, handle);
    }

    let envelope = make_envelope(
        "session",
        "model.set",
        serde_json::json!({
            "session_id": db_id.to_string(),
            "model": "openrouter/z-ai/glm-5.2",
        }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "model.set.ok");
    } else {
        panic!("expected text message");
    }

    let msg = tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv())
        .await
        .expect("backend should emit effort.set.ok after model.set")
        .unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "effort.set.ok");
        assert!(env.payload["thinking_effort"].is_null());
    } else {
        panic!("expected text message");
    }

    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&db_id).unwrap();
    assert_eq!(
        handle.desired_model.as_deref(),
        Some("openrouter/z-ai/glm-5.2")
    );
    assert_eq!(handle.desired_thinking_effort, None);
    assert_eq!(handle.spawned_thinking_effort, None);
    assert_eq!(handle.config.thinking_effort, None);
    drop(sessions);

    let persisted: Option<String> =
        sqlx::query_scalar("SELECT thinking_effort FROM agent_sessions WHERE id = ?")
            .bind(db_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted, None);
}

#[tokio::test]
async fn test_opencode_init_clears_stored_effort_when_model_does_not_support_it() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let feature_id = 1i64;

    let db_id = sqlx::query(
        "INSERT INTO agent_sessions \
         (feature_id, agent_type, status, model, runtime_provider, thinking_effort) \
         VALUES (?, 'session', 'idle', 'openrouter/z-ai/glm-5.2', 'opencode', 'medium')",
    )
    .bind(feature_id)
    .execute(&app_state.write_pool)
    .await
    .unwrap()
    .last_insert_rowid();

    let envelope = make_envelope(
        "session",
        "init",
        serde_json::json!({
            "cwd": "/tmp/test",
            "feature_id": feature_id,
        }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let msg = rx.recv().await.unwrap();
    let Message::Text(text) = msg else {
        panic!("expected text message");
    };
    let env: WsEnvelope = serde_json::from_str(&text).unwrap();
    assert_eq!(env.action, "initialized");
    let payload: SessionInitializedPayload = serde_json::from_value(env.payload).unwrap();
    assert_eq!(payload.session_id, db_id.to_string());
    assert_eq!(payload.thinking_effort, None);

    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&db_id).unwrap();
    assert_eq!(handle.desired_thinking_effort, None);
    assert_eq!(handle.config.thinking_effort, None);
    let QueryState::Pending(options) = &handle.state else {
        panic!("expected pending session before first prompt");
    };
    assert_eq!(options.thinking_effort, None);
    drop(sessions);

    let persisted: Option<String> =
        sqlx::query_scalar("SELECT thinking_effort FROM agent_sessions WHERE id = ?")
            .bind(db_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted, None);
}
