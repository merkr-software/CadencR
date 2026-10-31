//! `session.prompt.send`: session-not-found / invalid-id guards, the
//! first-prompt spawn path, and the non-blocking follow-up dispatch.

use super::support::*;

struct RecordingPromptSession {
    tx: mpsc::Sender<Value>,
    message_rx: Option<RuntimeMessageRx>,
}

#[async_trait::async_trait]
impl AgentRuntimeSession for RecordingPromptSession {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        self.message_rx.take().unwrap()
    }

    async fn session_id(&self) -> Option<String> {
        Some("runtime-session".to_string())
    }

    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError> {
        self.tx.send(content).await.unwrap();
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

    fn pid(&self) -> Option<u32> {
        None
    }
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
async fn public_replay_flag_is_ignored_and_legacy_prompt_gets_canonical_identity() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;
    let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
    let db_id: i64 = session_id.parse().unwrap();
    let (prompt_tx, mut prompt_rx) = mpsc::channel(1);

    {
        let mut sessions = sdk_sessions.lock().await;
        let handle = sessions.get_mut(&db_id).unwrap();
        let (permission_tx, _permission_rx) =
            mpsc::channel::<session_prompt::PermissionResponse>(1);
        let (_message_tx, message_rx) = mpsc::channel(1);
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(RecordingPromptSession {
                tx: prompt_tx,
                message_rx: Some(message_rx),
            }))),
            permission_tx,
        };
        handle.spawned_model = handle.desired_model.clone();
        handle.spawned_permission_mode = handle.desired_permission_mode.clone();
        handle.spawned_access_mode = handle.desired_access_mode.clone();
        handle.spawned_thinking_effort = handle.desired_thinking_effort.clone();
        handle.spawned_claude_profile = handle.desired_claude_profile.clone();
    }

    let envelope = make_envelope(
        "session",
        "prompt.send",
        serde_json::json!({
            "session_id": session_id,
            "text": "legacy steering prompt",
            "replay": true,
        }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let streamed =
        match tokio::time::timeout(std::time::Duration::from_secs(2), prompt_rx.recv()).await {
            Ok(Some(streamed)) => streamed,
            result => {
                let events: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
                panic!("prompt was not dispatched ({result:?}); websocket events: {events:?}");
            }
        };
    assert_eq!(streamed, serde_json::json!("legacy steering prompt"));

    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT content, message_uuid FROM agent_messages WHERE session_id = ?")
            .bind(db_id)
            .fetch_all(&app_state.write_pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "legacy steering prompt");
    assert!(uuid::Uuid::parse_str(&rows[0].1).is_ok());
}

#[test]
fn first_prompt_spawn_path_releases_sdk_session_lock_before_awaits() {
    let source = include_str!("../session_prompt/prompt_send_pending.rs");
    let drop_index = source
        .find("drop(sessions);")
        .expect("pending spawn path should explicitly release sdk_sessions");
    let persist_index = source
        .find("// Persist user message")
        .expect("pending spawn path should persist user message");

    assert!(
        drop_index < persist_index,
        "sdk_sessions must be released before awaited first-prompt work"
    );
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

    let status_event = tokio::time::timeout(std::time::Duration::from_secs(2), status_rx.recv())
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
async fn test_prompt_send_steers_turn_owned_by_another_connection_without_spawning() {
    // The exact cross-device bug shape: a turn is live on connection A (e.g. a
    // phone, possibly already disconnected), connection B (the host) has only a
    // Pending handle for the same session. B's prompt.send must STEER A's live
    // runtime (Phase 2 via the active-turn registry), never spawn a second
    // agent on the existing conversation.
    let app_state = make_test_app_state().await;
    let feature_id = 1i64;

    // Connection A: owns the live Active turn, recording what gets streamed.
    let (tx_a, mut rx_a) = mpsc::unbounded_channel();
    let owner_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let session_id = init_session(&tx_a, &mut rx_a, &owner_sessions, &app_state, feature_id).await;
    let db_id: i64 = session_id.parse().unwrap();
    let (prompt_tx, mut prompt_rx) = mpsc::channel(1);
    {
        let mut sessions = owner_sessions.lock().await;
        let handle = sessions.get_mut(&db_id).unwrap();
        let (permission_tx, _permission_rx) =
            mpsc::channel::<session_prompt::PermissionResponse>(1);
        let (_message_tx, message_rx) = mpsc::channel(1);
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(RecordingPromptSession {
                tx: prompt_tx,
                message_rx: Some(message_rx),
            }))),
            permission_tx,
        };
        handle.spawned_model = handle.desired_model.clone();
        handle.spawned_permission_mode = handle.desired_permission_mode.clone();
        handle.spawned_access_mode = handle.desired_access_mode.clone();
        handle.spawned_thinking_effort = handle.desired_thinking_effort.clone();
        handle.spawned_claude_profile = handle.desired_claude_profile.clone();
    }
    // Register A as the turn's owner in the global registry (as mark_agent_running does).
    app_state
        .active_turns
        .begin_turn(db_id, &owner_sessions)
        .await;

    // Connection B (the host): a Pending handle for the SAME db session id.
    let (tx_b, mut rx_b) = mpsc::unbounded_channel();
    let host_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut handle = make_active_handle(feature_id, None);
        handle.state = QueryState::Pending(Default::default());
        host_sessions.lock().await.insert(db_id, handle);
    }

    let envelope = make_envelope(
        "session",
        "prompt.send",
        serde_json::json!({
            "session_id": session_id,
            "text": "continue from the host",
            "message_uuid": "eea8648c-6786-4f20-ae17-56c6878a08ff",
            "track_prompt_receipt": true,
        }),
    );
    dispatch_envelope(envelope, &tx_b, &host_sessions, &app_state).await;

    // The prompt reached A's live runtime — proving it was steered, not spawned
    // (a fresh spawn would never touch this RecordingPromptSession).
    let streamed = tokio::time::timeout(std::time::Duration::from_secs(2), prompt_rx.recv())
        .await
        .expect("host prompt should stream into the existing runtime")
        .unwrap();
    assert_eq!(streamed, serde_json::json!("continue from the host"));

    // Transport acceptance is not an agent receipt. The canonical message
    // must stay pending until the runtime emits its provider receipt (user
    // replay / next response), even though stream_input already returned Ok.
    tokio::task::yield_now().await;
    while let Ok(message) = rx_b.try_recv() {
        let Message::Text(raw) = message else {
            continue;
        };
        let event: WsEnvelope = serde_json::from_str(&raw).unwrap();
        assert_ne!(
            event.action, "prompt_received",
            "stream_input success must not acknowledge the prompt before a runtime receipt"
        );
    }
    let delivery_state: Option<String> = sqlx::query_scalar(
        "SELECT delivery_state FROM agent_messages WHERE session_id = ? AND message_uuid = ?",
    )
    .bind(db_id)
    .bind("eea8648c-6786-4f20-ae17-56c6878a08ff")
    .fetch_one(&app_state.write_pool)
    .await
    .unwrap();
    assert_eq!(delivery_state.as_deref(), Some("pending_agent"));

    // The host's own handle was never converted to Active — no second agent.
    let sessions = host_sessions.lock().await;
    assert!(
        matches!(sessions.get(&db_id).unwrap().state, QueryState::Pending(_)),
        "host handle must stay Pending — the live turn was steered, not respawned"
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
