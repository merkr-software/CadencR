//! Session-scoped provider profile behavior.

use super::support::*;

#[tokio::test]
async fn claude_custom_gpt_model_keeps_provider_and_profile_env() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;
    sqlx::query(
        "CREATE TABLE claude_code_custom_models (\
            id INTEGER PRIMARY KEY, model_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, \
            description TEXT, supports_effort BOOLEAN, supported_effort_levels_json TEXT, \
            default_effort_level TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\
        )",
    )
    .execute(&app_state.write_pool)
    .await
    .unwrap();
    crate::domain::agents::claude_code::custom_models::upsert_custom_model(
        &app_state.write_pool,
        "gpt-5.6-sol",
        "GPT-5.6 (CLIProxyAPI)",
        None,
        crate::domain::agents::claude_code::custom_models::CustomModelEffort::default(),
    )
    .await
    .unwrap();
    let profile_env = HashMap::from([
        (
            "ANTHROPIC_BASE_URL".to_string(),
            "http://localhost:8317".to_string(),
        ),
        (
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "proxy-token".to_string(),
        ),
    ]);
    crate::domain::agents::claude_code::profiles::upsert_profile("routing-proxy", &profile_env)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO agent_sessions \
         (feature_id, agent_type, status, model, profile) \
         VALUES (1, 'session', 'paused', 'gpt-5.6-sol', 'routing-proxy')",
    )
    .execute(&app_state.write_pool)
    .await
    .unwrap();

    let session_id = init_session_with_payload(
        &tx,
        &mut rx,
        &sdk_sessions,
        &app_state,
        SessionInitPayload {
            provider: None,
            model: None,
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some("/tmp/test".to_string()),
            feature_id: Some(1),
        },
    )
    .await;

    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&session_id.parse::<i64>().unwrap()).unwrap();
    assert_eq!(handle.runtime_provider, "claude_code");
    assert_eq!(
        handle.desired_claude_profile.as_deref(),
        Some("routing-proxy")
    );
    assert_eq!(handle.config.env.as_ref(), Some(&profile_env));
    drop(sessions);
    crate::domain::agents::claude_code::profiles::delete_profile("routing-proxy")
        .await
        .unwrap();
}

#[tokio::test]
async fn explicitly_selected_provider_preserves_custom_model() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;
    sqlx::query(
        "CREATE TABLE claude_code_custom_models (\
            id INTEGER PRIMARY KEY, model_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, \
            description TEXT, supports_effort BOOLEAN, supported_effort_levels_json TEXT, \
            default_effort_level TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\
        )",
    )
    .execute(&app_state.write_pool)
    .await
    .unwrap();
    crate::domain::agents::claude_code::custom_models::upsert_custom_model(
        &app_state.write_pool,
        "gpt-5.6-sol",
        "GPT-5.6 (CLIProxyAPI)",
        None,
        crate::domain::agents::claude_code::custom_models::CustomModelEffort::default(),
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
            model: Some("gpt-5.6-sol".to_string()),
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some("/tmp/test".to_string()),
            feature_id: Some(1),
        },
    )
    .await;

    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&session_id.parse::<i64>().unwrap()).unwrap();
    assert_eq!(handle.runtime_provider, "claude_code");
    assert_eq!(handle.desired_model.as_deref(), Some("gpt-5.6-sol"));
}

#[tokio::test]
async fn init_reuses_existing_session_profile_instead_of_global_profile() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;
    let profile_name = "test-init-pinned-profile";
    crate::domain::agents::claude_code::profiles::upsert_profile(profile_name, &HashMap::new())
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO agent_sessions \
         (feature_id, agent_type, status, runtime_provider, profile) \
         VALUES (1, 'session', 'paused', 'claude_code', ?)",
    )
    .bind(profile_name)
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
    assert_eq!(payload.profile.as_deref(), Some(profile_name));

    let sessions = sdk_sessions.lock().await;
    let handle = sessions
        .get(&payload.session_id.parse::<i64>().unwrap())
        .unwrap();
    assert_eq!(handle.desired_claude_profile.as_deref(), Some(profile_name));
    drop(sessions);
    crate::domain::agents::claude_code::profiles::delete_profile(profile_name)
        .await
        .unwrap();
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
    assert!(env.payload.get("effective").is_none());

    let persisted: Option<String> =
        sqlx::query_scalar("SELECT profile FROM agent_sessions WHERE id = ?")
            .bind(session_id.parse::<i64>().unwrap())
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted.as_deref(), Some("bedrock"));
}

#[tokio::test]
/// The composer can attach a profile while it shows another provider than the
/// session runs: the prompt still goes out, and the profile is not applied.
async fn prompt_profile_is_ignored_on_provider_without_profile_support() {
    let (tx, mut rx) = mpsc::unbounded_channel();
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

    let mut actions = Vec::new();
    while let Ok(message) = rx.try_recv() {
        let Message::Text(text) = message else {
            continue;
        };
        let response: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_ne!(
            response.action, "error",
            "an inapplicable profile must not fail the prompt: {text}"
        );
        actions.push(response.action);
    }
    let delivered: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages WHERE session_id = ? AND content LIKE '%provider-neutral profile%'",
    )
    .bind(db_session_id)
    .fetch_one(&app_state.read_pool)
    .await
    .unwrap();
    assert_eq!(
        delivered, 1,
        "the prompt reaches the session; replies: {actions:?}"
    );

    let persisted: Option<String> =
        sqlx::query_scalar("SELECT profile FROM agent_sessions WHERE id = ?")
            .bind(db_session_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted, None);
}
