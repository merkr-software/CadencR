//! Provider access-mode wiring: `provider.set` seeds provider defaults and
//! `access_mode.set` applies live policy when supported.

use super::support::*;

struct RecordingAccessModeSession {
    seen: Arc<Mutex<Option<RuntimeAccessMode>>>,
    message_rx: Option<RuntimeMessageRx>,
}
#[async_trait::async_trait]
impl AgentRuntimeSession for RecordingAccessModeSession {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        self.message_rx.take().unwrap()
    }

    async fn session_id(&self) -> Option<String> {
        Some("codex-runtime-session".to_string())
    }

    async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn close(&mut self) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn set_permission_mode(&self, _mode: RuntimePermissionMode) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn set_access_mode(&self, mode: RuntimeAccessMode) -> Result<(), RuntimeError> {
        *self.seen.lock().await = Some(mode);
        Ok(())
    }

    fn pid(&self) -> Option<u32> {
        None
    }
}

#[tokio::test]
async fn test_provider_set_to_codex_persists_configured_access_mode() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;
    // Workspace settings live in the JSON store now (not the SQLite `settings`
    // table), so seed via the repository that production reads through.
    crate::domain::workspace::repository::set_setting(
        &app_state.write_pool,
        "codex_permission_mode",
        "autoReview",
    )
    .await
    .unwrap();

    let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
    let db_id: i64 = session_id.parse().unwrap();

    let envelope = make_envelope(
        "session",
        "provider.set",
        serde_json::json!({
            "session_id": session_id,
            "provider": "codex_cli",
        }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let _provider_ok = rx.recv().await.unwrap();
    let _mode_changed = rx.recv().await.unwrap();

    let row: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT runtime_provider, codex_permission_mode, permission_mode FROM agent_sessions WHERE id = ?",
    )
    .bind(db_id)
    .fetch_one(&app_state.read_pool)
    .await
    .unwrap();
    assert_eq!(row.0.as_deref(), Some("codex_cli"));
    assert_eq!(row.1.as_deref(), Some("autoReview"));
    assert_eq!(row.2.as_deref(), Some("default"));

    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&db_id).unwrap();
    assert_eq!(
        handle.desired_access_mode,
        Some(RuntimeAccessMode::AutoReview)
    );
    assert_eq!(
        handle.config.access_mode,
        Some(RuntimeAccessMode::AutoReview)
    );
    if let QueryState::Pending(options) = &handle.state {
        assert_eq!(options.access_mode, Some(RuntimeAccessMode::AutoReview));
    } else {
        panic!("expected pending state");
    }
}

#[tokio::test]
async fn codex_permission_mode_set_updates_active_session_and_persists() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;

    let session_id = init_pending_codex(&tx, &mut rx, &sdk_sessions, &app_state).await;
    while rx.try_recv().is_ok() {}
    let db_id: i64 = session_id.parse().unwrap();
    let seen_access_mode = Arc::new(Mutex::new(None));

    {
        let mut sessions = sdk_sessions.lock().await;
        let handle = sessions.get_mut(&db_id).unwrap();
        let (permission_tx, _permission_rx) =
            mpsc::channel::<session_prompt::PermissionResponse>(1);
        let (_message_tx, message_rx) = mpsc::channel(1);
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(RecordingAccessModeSession {
                seen: Arc::clone(&seen_access_mode),
                message_rx: Some(message_rx),
            }))),
            permission_tx,
        };
        handle.spawned_access_mode = Some(RuntimeAccessMode::FullAccess);
    }

    let envelope = make_envelope(
        "session",
        "codex_permission_mode.set",
        serde_json::json!({
            "session_id": session_id,
            "mode": "autoReview",
        }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "access_mode.changed");
        assert_eq!(
            env.payload.get("mode").and_then(|v| v.as_str()),
            Some("autoReview")
        );
    } else {
        panic!("expected text message");
    }

    let persisted: Option<String> =
        sqlx::query_scalar("SELECT codex_permission_mode FROM agent_sessions WHERE id = ?")
            .bind(db_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted.as_deref(), Some("autoReview"));

    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&db_id).unwrap();
    assert_eq!(
        handle.desired_access_mode,
        Some(RuntimeAccessMode::AutoReview)
    );
    assert_eq!(
        handle.config.access_mode,
        Some(RuntimeAccessMode::AutoReview)
    );
    assert_eq!(
        handle.spawned_access_mode,
        Some(RuntimeAccessMode::FullAccess)
    );
    assert_eq!(
        *seen_access_mode.lock().await,
        Some(RuntimeAccessMode::AutoReview)
    );
}

#[tokio::test]
async fn codex_permission_mode_set_rejects_invalid_mode_with_error() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;

    let session_id = init_pending_codex(&tx, &mut rx, &sdk_sessions, &app_state).await;
    while rx.try_recv().is_ok() {}

    let envelope = make_envelope(
        "session",
        "codex_permission_mode.set",
        serde_json::json!({
            "session_id": session_id,
            "mode": "turbo",
        }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "error");
        let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
        assert_eq!(payload.code, "INVALID_PAYLOAD");
        assert_eq!(payload.message, "Invalid access mode");
    } else {
        panic!("expected text message");
    }
}

#[tokio::test]
async fn provider_switch_to_codex_discards_foreign_profile_and_environment() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sessions = Arc::new(Mutex::new(HashMap::new()));
    let state = make_test_app_state().await;
    let id = init_session(&tx, &mut rx, &sessions, &state, 1).await;
    let db_id = id.parse().unwrap();
    {
        let mut sessions = sessions.lock().await;
        let handle = sessions.get_mut(&db_id).unwrap();
        handle.desired_claude_profile = Some("foreign-claude-profile".into());
        handle.config.claude_profile = Some("foreign-claude-profile".into());
        handle.config.env = Some(HashMap::from([("FOREIGN_TOKEN".into(), "secret".into())]));
        handle.config.env_unset = vec!["FOREIGN_UNSET".into()];
        handle.config.profile_revision = Some("foreign-revision".into());
        handle.config.profile_state_identity = Some("foreign-home".into());
        handle.config.overrides.model = Some("foreign-model".into());
        handle.config.overrides.fast_mode = Some(true);
    }
    dispatch_envelope(
        make_envelope(
            "session",
            "provider.set",
            serde_json::json!({
                "session_id": id, "provider": "codex_cli",
            }),
        ),
        &tx,
        &sessions,
        &state,
    )
    .await;
    let Message::Text(reply) = rx.recv().await.unwrap() else {
        panic!("text expected")
    };
    let reply: WsEnvelope = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply.action, "provider.set.ok", "{:?}", reply.payload);
    let expected_profile =
        crate::domain::agents::codex::profiles::active_id().unwrap_or_else(|| "default".into());
    assert_eq!(reply.payload["profile"], expected_profile);
    assert!(reply.payload["runtime_overrides"]["model"].is_null());
    let sessions = sessions.lock().await;
    let handle = sessions.get(&db_id).unwrap();
    let QueryState::Pending(config) = &handle.state else {
        panic!("pending expected")
    };
    assert_eq!(config.profile.as_deref(), Some(expected_profile.as_str()));
    assert!(!config
        .env
        .as_ref()
        .is_some_and(|env| env.contains_key("FOREIGN_TOKEN")));
    assert!(!config.env_unset.contains(&"FOREIGN_UNSET".to_string()));
    assert_ne!(config.profile_revision.as_deref(), Some("foreign-revision"));
    assert_ne!(
        config.profile_state_identity.as_deref(),
        Some("foreign-home")
    );
    assert_eq!(config.overrides, Default::default());
    let stored: (Option<String>, String) =
        sqlx::query_as("SELECT profile, runtime_overrides FROM agent_sessions WHERE id = ?")
            .bind(db_id)
            .fetch_one(&state.read_pool)
            .await
            .unwrap();
    assert_eq!(stored.0, config.profile);
    assert_eq!(
        serde_json::from_str::<crate::domain::agents::adapter::RuntimeConfigOverrides>(&stored.1)
            .unwrap(),
        config.overrides
    );
}

/// Access-mode unit tests need a pending Codex handle, not a live Codex CLI.
async fn init_pending_codex(
    tx: &WsSender,
    rx: &mut mpsc::UnboundedReceiver<Message>,
    sessions: &SdkSessions,
    state: &AppState,
) -> String {
    let session_id = init_session(tx, rx, sessions, state, 1).await;
    dispatch_envelope(
        make_envelope(
            "session",
            "provider.set",
            serde_json::json!({
                "session_id": session_id, "provider": "codex_cli",
            }),
        ),
        tx,
        sessions,
        state,
    )
    .await;
    let Message::Text(reply) = rx.recv().await.unwrap() else {
        panic!("text expected")
    };
    let reply: WsEnvelope = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply.action, "provider.set.ok", "{:?}", reply.payload);
    session_id
}
