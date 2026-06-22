//! Codex-specific provider wiring: `provider.set` seeding the configured
//! access mode and `codex_permission_mode.set` on an active session.

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

    async fn close(&mut self) {}

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

    let session_id = init_session_with_payload(
        &tx,
        &mut rx,
        &sdk_sessions,
        &app_state,
        SessionInitPayload {
            provider: Some("codex_cli".to_string()),
            model: None,
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some("/tmp/test".to_string()),
            feature_id: Some(1),
        },
    )
    .await;
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
        assert_eq!(env.action, "codex_permission_mode.changed");
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

    let session_id = init_session_with_payload(
        &tx,
        &mut rx,
        &sdk_sessions,
        &app_state,
        SessionInitPayload {
            provider: Some("codex_cli".to_string()),
            model: None,
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some("/tmp/test".to_string()),
            feature_id: Some(1),
        },
    )
    .await;
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
        assert_eq!(payload.message, "Invalid Codex access mode");
    } else {
        panic!("expected text message");
    }
}
