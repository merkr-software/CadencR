//! Session-scoped provider profile behavior.

use super::support::*;

#[tokio::test]
async fn init_reuses_existing_session_profile_instead_of_global_profile() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;

    sqlx::query(
        "INSERT INTO agent_sessions \
         (feature_id, agent_type, status, runtime_provider, profile) \
         VALUES (1, 'session', 'paused', 'claude_code', 'bedrock')",
    )
    .execute(&app_state.write_pool)
    .await
    .unwrap();
    crate::domain::workspace::repository::set_setting(
        &app_state.write_pool,
        crate::domain::agents::claude_code::profiles::ACTIVE_PROFILE_KEY,
        "default",
    )
    .await
    .unwrap();

    let envelope = make_envelope(
        "session",
        "init",
        serde_json::json!({
            "provider": "claude_code",
            "cwd": "/tmp/test",
            "feature_id": 1,
        }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let Message::Text(text) = rx.recv().await.unwrap() else {
        panic!("expected initialized text message");
    };
    let env: WsEnvelope = serde_json::from_str(&text).unwrap();
    assert_eq!(env.action, "initialized");
    let payload: SessionInitializedPayload = serde_json::from_value(env.payload).unwrap();
    assert_eq!(payload.provider.as_deref(), Some("claude_code"));
    assert_eq!(payload.profile.as_deref(), Some("bedrock"));

    let sessions = sdk_sessions.lock().await;
    let handle = sessions
        .get(&payload.session_id.parse::<i64>().unwrap())
        .unwrap();
    assert_eq!(handle.desired_claude_profile.as_deref(), Some("bedrock"));
}

#[tokio::test]
async fn profile_set_updates_only_the_session_profile_column() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;
    // Profiles now live in the JSON settings, not SQLite — seed one there.
    crate::domain::agents::claude_code::profiles::upsert_profile(
        "bedrock",
        &std::collections::HashMap::new(),
    )
    .await
    .unwrap();
    let session_id = init_session_with_payload(
        &tx,
        &mut rx,
        &sdk_sessions,
        &app_state,
        SessionInitPayload {
            provider: Some("claude_code".to_string()),
            model: Some("claude-sonnet-4-5".to_string()),
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some("/tmp/test".to_string()),
            feature_id: Some(1),
        },
    )
    .await;

    let envelope = make_envelope(
        "session",
        "profile.set",
        serde_json::json!({
            "session_id": session_id,
            "profile": "bedrock",
        }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let Message::Text(text) = rx.recv().await.unwrap() else {
        panic!("expected profile.changed text message");
    };
    let env: WsEnvelope = serde_json::from_str(&text).unwrap();
    assert_eq!(env.action, "profile.changed");
    assert_eq!(env.payload["provider"], "claude_code");
    assert_eq!(env.payload["profile"], "bedrock");
    assert_eq!(env.payload["model"], "claude-sonnet-4-5");

    let persisted: Option<String> =
        sqlx::query_scalar("SELECT profile FROM agent_sessions WHERE id = ?")
            .bind(session_id.parse::<i64>().unwrap())
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted.as_deref(), Some("bedrock"));
}

#[tokio::test]
async fn prompt_profile_is_provider_neutral_for_non_claude_sessions() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;
    let db_session_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_sessions \
         (feature_id, agent_type, status, runtime_provider, model) \
         VALUES (1, 'session', 'running', 'opencode', 'openai/gpt-5.4') \
         RETURNING id",
    )
    .fetch_one(&app_state.write_pool)
    .await
    .unwrap();
    sdk_sessions
        .lock()
        .await
        .insert(db_session_id, make_in_place_effort_handle(1));

    let envelope = make_envelope(
        "session",
        "prompt.send",
        serde_json::json!({
            "session_id": db_session_id.to_string(),
            "text": "provider-neutral profile",
            "profile": "opencode-profile",
            "replay": true,
        }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let persisted: Option<String> =
        sqlx::query_scalar("SELECT profile FROM agent_sessions WHERE id = ?")
            .bind(db_session_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted.as_deref(), Some("opencode-profile"));
}
