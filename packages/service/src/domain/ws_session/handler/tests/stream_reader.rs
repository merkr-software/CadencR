use super::support::*;

#[tokio::test]
async fn stream_reader_suppresses_operational_events_without_consuming_message_seq() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let db_session_id = 142i64;
    let feature_id = 1i64;
    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(3);

    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("runtime-init".to_string()),
                context_window: Some(8_192),
                raw: serde_json::json!({ "type": "session.init" }),
                ..Default::default()
            },
            RuntimeEventKind::Init(crate::domain::agents::adapter::RuntimeInitEvent {
                model: Some("model".to_string()),
                mcp_servers: vec![RuntimeMcpServerStatus {
                    name: "test-mcp".to_string(),
                    status: "connected".to_string(),
                }],
                context_window: Some(8_192),
            }),
        )))
        .await
        .unwrap();
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("runtime-init".to_string()),
                raw: serde_json::json!({ "sessionId": "runtime-init" }),
                ..Default::default()
            },
            RuntimeEventKind::Other,
        )))
        .await
        .unwrap();
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("runtime-init".to_string()),
                raw: serde_json::json!({ "type": "stream_event", "event": {
                    "type": "message_start", "message": { "model": "model" }
                }}),
                ..Default::default()
            },
            RuntimeEventKind::StreamEvent {
                event: crate::domain::agents::adapter::RuntimeStreamEvent::MessageStart {
                    model: Some("model".to_string()),
                    input_tokens: None,
                },
                parent_tool_use_id: None,
            },
        )))
        .await
        .unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions,
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let mut actions = Vec::new();
    let mut message_seq = None;
    while let Ok(Some(Message::Text(text))) =
        tokio::time::timeout(std::time::Duration::from_secs(2), ws_rx.recv()).await
    {
        let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
        actions.push(envelope.action.clone());
        if envelope.action == "message" {
            message_seq = envelope.payload.get("seq").and_then(Value::as_u64);
        }
        if envelope.action == "ended" {
            break;
        }
    }

    assert!(actions.contains(&"runtime_session_id".to_string()));
    assert!(actions.contains(&"mcp_servers".to_string()));
    assert_eq!(
        actions.iter().filter(|action| *action == "message").count(),
        1
    );
    assert_eq!(message_seq, Some(1));
}

#[tokio::test]
async fn test_stream_reader_transitions_active_to_pending_on_stream_close() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 42i64;
    let feature_id = 1i64;
    let cli_session_id = "019fc2bc-6c05-7db2-8933-46942a31af27".to_string();

    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(
            db_session_id,
            make_active_handle(feature_id, Some(cli_session_id.clone())),
        );
    }

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let msg = ws_rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "ended");
        let payload: SessionEndedPayload = serde_json::from_value(env.payload).unwrap();
        assert_eq!(payload.reason, "stream_closed");
    } else {
        panic!("expected text message");
    }

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&db_session_id).unwrap();
    match &handle.state {
        QueryState::Pending(options) => {
            assert_eq!(options.resume_session_id, Some(cli_session_id));
            assert_eq!(options.cwd, PathBuf::from("/tmp/test"));
            assert_eq!(options.model, Some("sonnet".to_string()));
        }
        QueryState::Active { .. } => {
            panic!("expected Pending state after stream close, but found Active");
        }
    }
}

#[tokio::test]
async fn test_stream_reader_mirrors_to_other_feature_viewers() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, _ws_rx) = mpsc::unbounded_channel();
    let (viewer_tx, mut viewer_rx) = mpsc::unbounded_channel();

    let db_session_id = 77i64;
    let feature_id = 3i64;
    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(db_session_id, make_active_handle(feature_id, None));
    }
    app_state
        .ws_feature_senders
        .register(feature_id, viewer_tx)
        .await;

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    // the turn — that's the remote-access conversation mirror.
    let msg = tokio::time::timeout(std::time::Duration::from_secs(2), viewer_rx.recv())
        .await
        .expect("viewer should receive the mirrored envelope")
        .expect("viewer channel stays open");
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "ended", "mirror forwards the session.ended");
    } else {
        panic!("expected a text message");
    }
}

#[tokio::test]
async fn test_stream_reader_mirrors_prompt_received_to_other_viewers() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let (viewer_tx, mut viewer_rx) = mpsc::unbounded_channel();

    let db_session_id = 88i64;
    let feature_id = 1i64;
    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(db_session_id, make_active_handle(feature_id, None));
    }
    app_state
        .ws_feature_senders
        .register(feature_id, viewer_tx)
        .await;
    seed_pending_prompt(&app_state, db_session_id, feature_id, "client-xyz").await;

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(2);
    msg_tx
        .send(Ok(RuntimeEvent::prompt_received_event(
            "client-xyz".to_string(),
        )))
        .await
        .unwrap();
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata::default(),
            RuntimeEventKind::Result,
        )))
        .await
        .unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let mut terminal_receipts = None;
    while let Ok(Some(message)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), ws_rx.recv()).await
    {
        let Message::Text(text) = message else {
            continue;
        };
        let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
        if envelope.action == "ended" {
            let payload: SessionEndedPayload = serde_json::from_value(envelope.payload).unwrap();
            terminal_receipts = Some(payload.received_prompt_message_uuids);
            break;
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let saw_prompt_received = |rx: &mut mpsc::UnboundedReceiver<Message>| {
        std::iter::from_fn(|| rx.try_recv().ok()).any(|msg| {
            matches!(msg, Message::Text(text)
            if serde_json::from_str::<WsEnvelope>(&text).is_ok_and(|env| {
                env.action == "prompt_received"
                    && env.payload.get("message_uuid").and_then(|v| v.as_str())
                        == Some("client-xyz")
            }))
        })
    };

    assert!(
        saw_prompt_received(&mut viewer_rx),
        "a passive viewer must also receive the mirrored prompt_received"
    );
    assert_eq!(terminal_receipts, Some(vec!["client-xyz".to_string()]));
}

#[tokio::test]
async fn test_stream_reader_transitions_active_to_pending_on_error() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 43i64;
    let feature_id = 2i64;

    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(db_session_id, make_active_handle(feature_id, None));
    }

    seed_pending_prompt(&app_state, db_session_id, feature_id, "error-receipt").await;

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(2);
    msg_tx
        .send(Ok(RuntimeEvent::prompt_received_event(
            "error-receipt".to_string(),
        )))
        .await
        .unwrap();
    msg_tx
        .send(Err(RuntimeError::from(SdkError::ProcessExit {
            code: Some(1),
            stderr: "something went wrong".to_string(),
        })))
        .await
        .unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let error_payload = loop {
        let Message::Text(text) = ws_rx.recv().await.unwrap() else {
            continue;
        };
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        if env.action == "error" {
            break serde_json::from_value::<SessionErrorPayload>(env.payload).unwrap();
        }
    };
    assert_eq!(
        error_payload.received_prompt_message_uuids,
        vec!["error-receipt"]
    );

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&db_session_id).unwrap();
    match &handle.state {
        QueryState::Pending(options) => {
            assert_eq!(options.resume_session_id, None);
        }
        QueryState::Active { .. } => {
            panic!("expected Pending state after stream error, but found Active");
        }
    }
}

async fn seed_pending_prompt(
    app_state: &AppState,
    session_id: i64,
    feature_id: i64,
    message_uuid: &str,
) {
    sqlx::query(
        "INSERT INTO agent_sessions (id, feature_id, agent_type, status)
         VALUES (?, ?, 'session', 'running')",
    )
    .bind(session_id)
    .bind(feature_id)
    .execute(&app_state.write_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_messages
         (session_id, role, content, message_type, message_uuid, delivery_state)
         VALUES (?, 'user', 'tracked prompt', 'user_message', ?, 'pending_agent')",
    )
    .bind(session_id)
    .bind(message_uuid)
    .execute(&app_state.write_pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn test_stream_reader_no_transition_when_session_removed() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        99,
        1,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let msg = ws_rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "ended");
    }

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    assert!(sdk_sessions.lock().await.is_empty());
}

#[tokio::test]
async fn test_stream_reader_routes_acp_permission_request() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 77i64;
    let feature_id = 1i64;

    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(db_session_id, make_active_handle(feature_id, None));
    }

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(4);
    let event = RuntimeEvent::new(
        crate::domain::agents::adapter::RuntimeEventMetadata {
            session_id: Some("sess-opencode".to_string()),
            usage: None,
            context_window: None,
            raw: serde_json::json!({
                "type": "acp_permission_request",
                "request_id": "perm-1",
                "tool_name": "Write",
                "tool_input": { "file_path": "/tmp/a.txt" },
                "description": "needs permission",
            }),
        },
        crate::domain::agents::adapter::RuntimeEventKind::Other,
    );
    msg_tx.send(Ok(event)).await.unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions,
        "opencode",
    );

    let msg = ws_rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "permission.request");
        assert_eq!(
            env.payload.get("request_id").and_then(|v| v.as_str()),
            Some("perm-1")
        );
        assert_eq!(
            env.payload.get("tool_name").and_then(|v| v.as_str()),
            Some("Write")
        );
    } else {
        panic!("expected text message");
    }
}

#[tokio::test]
async fn test_stream_reader_result_keeps_pending_user_input_status() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let mut status_rx = app_state.session_status_tx.subscribe();
    let db_session_id = 78i64;
    let feature_id = 1i64;

    sqlx::query(
        "INSERT INTO agent_sessions (id, feature_id, agent_type, status, pending_permission) VALUES (?, ?, 'session', 'running', '{}')",
    )
    .bind(db_session_id)
    .bind(feature_id)
    .execute(&app_state.write_pool)
    .await
    .unwrap();

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata::default(),
            RuntimeEventKind::Result,
        )))
        .await
        .unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions,
        "codex",
    );

    while let Some(Message::Text(text)) = ws_rx.recv().await {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        if env.action == "ended" {
            break;
        }
    }

    assert!(
        matches!(
            status_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "turn result must not broadcast idle while permission/question input is pending"
    );
}

#[tokio::test]
async fn test_unrecognized_message_is_surfaced_to_the_conversation() {
    // A message type the SDK has never seen reaches the reader as
    // `RuntimeEventKind::Unknown`. It must appear in the conversation as a
    // visible `session.error` (and persist for history reload), not vanish.
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 91i64;
    let feature_id = 1i64;

    sqlx::query("INSERT INTO agent_sessions (id, feature_id, status) VALUES (?, ?, 'running')")
        .bind(db_session_id)
        .bind(feature_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(db_session_id, make_active_handle(feature_id, None));
    }

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata::default(),
            RuntimeEventKind::Unknown {
                raw: serde_json::json!({
                    "type": "some_future_message",
                    "detail": "content the user must still see",
                }),
            },
        )))
        .await
        .unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let mut saw_unknown = false;
    while let Ok(Some(msg)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), ws_rx.recv()).await
    {
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            if env.action == "error" {
                let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
                assert_eq!(payload.code, "UNKNOWN_MESSAGE");
                assert!(payload.message.contains("some_future_message"));
                assert!(payload.message.contains("content the user must still see"));
                saw_unknown = true;
                break;
            }
        }
    }
    assert!(
        saw_unknown,
        "an unrecognized message must surface as a visible session.error"
    );

    // It is persisted as an error message so it survives a history reload.
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages WHERE session_id = ? AND message_type = 'error'",
    )
    .bind(db_session_id)
    .fetch_one(&app_state.write_pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

const STREAM_CLOSE_FEATURE_ID: i64 = 1;

/// Deliver an optional message start, then EOF. Drain the output channel so
/// the test checks the order and uniqueness of the resulting envelopes.
async fn read_closed_stream(
    app_state: &AppState,
    db_session_id: i64,
    first_event: Option<RuntimeEvent>,
) -> WsEnvelope {
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::from([(
        db_session_id,
        make_active_handle(STREAM_CLOSE_FEATURE_ID, Some("cli".into())),
    )])));
    let (msg_tx, msg_rx) = mpsc::channel(1);
    let expected_first_action = first_event.as_ref().map(|_| "message");
    if let Some(event) = first_event {
        msg_tx.send(Ok(event)).await.unwrap();
    }
    drop(msg_tx);

    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    spawn_test_stream_reader(
        app_state,
        db_session_id,
        STREAM_CLOSE_FEATURE_ID,
        msg_rx,
        ws_tx,
        sdk_sessions,
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let mut output = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut output = Vec::new();
        while let Some(message) = ws_rx.recv().await {
            if let Message::Text(text) = message {
                let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
                if matches!(envelope.action.as_str(), "message" | "error" | "ended") {
                    output.push(envelope);
                }
            }
        }
        output
    })
    .await
    .expect("the reader must release its WebSocket sender after EOF");
    let terminal = output.pop().expect("EOF must produce a terminal envelope");
    assert_eq!(
        output
            .iter()
            .map(|env| env.action.as_str())
            .collect::<Vec<_>>(),
        expected_first_action.as_slice(),
        "only the optional message start should precede the terminal envelope"
    );
    terminal
}

async fn persisted_stream_outcome(app_state: &AppState, db_session_id: i64) -> (String, i64) {
    sqlx::query_as(
        "SELECT status, (SELECT COUNT(*) FROM agent_messages
                         WHERE session_id = agent_sessions.id AND message_type = 'error')
         FROM agent_sessions WHERE id = ?",
    )
    .bind(db_session_id)
    .fetch_one(&app_state.write_pool)
    .await
    .unwrap()
}

async fn assert_unexpected_stream_close(db_session_id: i64, first_event: Option<RuntimeEvent>) {
    let app_state = make_test_app_state().await;
    insert_running_session(&app_state, db_session_id, STREAM_CLOSE_FEATURE_ID).await;

    let terminal = read_closed_stream(&app_state, db_session_id, first_event).await;
    assert_eq!(terminal.action, "error");
    let payload: SessionErrorPayload = serde_json::from_value(terminal.payload).unwrap();
    assert_eq!(payload.code, "AGENT_STOPPED");
    let (status, errors) = persisted_stream_outcome(&app_state, db_session_id).await;
    assert_eq!((status.as_str(), errors), ("paused", 1));
}

#[tokio::test]
async fn test_stream_close_mid_turn_surfaces_an_error() {
    assert_unexpected_stream_close(77, Some(message_start("claude-opus-4-8"))).await;
}

#[tokio::test]
async fn test_stream_close_before_the_first_event_surfaces_an_error() {
    assert_unexpected_stream_close(83, None).await;
}

#[tokio::test]
async fn test_intentional_teardown_mid_turn_closes_benignly() {
    let app_state = make_test_app_state().await;
    let db_session_id = 79;
    insert_running_session(&app_state, db_session_id, STREAM_CLOSE_FEATURE_ID).await;

    // Clear and destroy update the persisted status before closing the CLI.
    WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id)
        .await
        .unwrap();

    let terminal = read_closed_stream(
        &app_state,
        db_session_id,
        Some(message_start("claude-opus-4-8")),
    )
    .await;
    assert_eq!(terminal.action, "ended");
    let payload: SessionEndedPayload = serde_json::from_value(terminal.payload).unwrap();
    assert_eq!(payload.reason, "stream_closed");
    let (status, errors) = persisted_stream_outcome(&app_state, db_session_id).await;
    assert_eq!((status.as_str(), errors), ("completed", 0));
}

#[tokio::test]
async fn test_error_result_is_surfaced_and_still_completes_the_turn() {
    // Issue #78: a turn that ends with an error result (Claude Code on Bedrock:
    // `is_error: true`) must surface a visible `session.error` AND still end the
    // turn normally (`turn_complete`), instead of looking like a clean stop with
    // no output.
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 81i64;
    let feature_id = 1i64;

    sqlx::query("INSERT INTO agent_sessions (id, feature_id, status) VALUES (?, ?, 'running')")
        .bind(db_session_id)
        .bind(feature_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(db_session_id, make_active_handle(feature_id, None));
    }

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("cli".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({ "type": "result", "subtype": "error_during_execution" }),
            },
            RuntimeEventKind::Result,
        )
        .with_result_error(Some(
            crate::domain::agents::adapter::RuntimeResultError {
                code: "ERROR_DURING_EXECUTION".to_string(),
                message: "Claude Code ended the turn with an error (error_during_execution): boom"
                    .to_string(),
            },
        ))))
        .await
        .unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let mut saw_error = false;
    let mut saw_turn_complete = false;
    while let Ok(Some(msg)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), ws_rx.recv()).await
    {
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            if env.action == "error" {
                let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
                assert_eq!(payload.code, "ERROR_DURING_EXECUTION");
                assert!(payload.message.contains("boom"));
                saw_error = true;
            } else if env.action == "ended" {
                let payload: SessionEndedPayload = serde_json::from_value(env.payload).unwrap();
                if payload.reason == "turn_complete" {
                    saw_turn_complete = true;
                }
            }
        }
    }
    assert!(saw_error, "an error result must surface a session.error");
    assert!(
        saw_turn_complete,
        "the turn must still complete after surfacing the error"
    );

    // Persisted once for history reload, and the session ended (not stuck).
    let (status, errors) = persisted_stream_outcome(&app_state, db_session_id).await;
    assert_eq!((status.as_str(), errors), ("completed", 1));
}

#[tokio::test]
async fn test_error_result_after_provider_error_does_not_double_surface() {
    // The CLI can report an API failure as a provider error AND then end the
    // turn with `is_error: true`. Only one error must reach the conversation —
    // the result-error path is suppressed once an error was already surfaced
    // this turn (issue #78), so the user doesn't see a duplicate bubble.
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 82i64;
    let feature_id = 1i64;

    sqlx::query("INSERT INTO agent_sessions (id, feature_id, status) VALUES (?, ?, 'running')")
        .bind(db_session_id)
        .bind(feature_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(db_session_id, make_active_handle(feature_id, None));
    }

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(4);
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata::default(),
            RuntimeEventKind::ProviderError {
                message: "API overloaded".to_string(),
                code: Some("API_ERROR_529".to_string()),
                parent_tool_use_id: None,
            },
        )))
        .await
        .unwrap();
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("cli".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({ "type": "result", "subtype": "error_during_execution" }),
            },
            RuntimeEventKind::Result,
        )
        .with_result_error(Some(
            crate::domain::agents::adapter::RuntimeResultError {
                code: "ERROR_DURING_EXECUTION".to_string(),
                message: "Claude Code ended the turn with an error (error_during_execution)."
                    .to_string(),
            },
        ))))
        .await
        .unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let mut error_codes = Vec::new();
    while let Ok(Some(msg)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), ws_rx.recv()).await
    {
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            if env.action == "error" {
                let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
                error_codes.push(payload.code);
            }
        }
    }
    assert_eq!(
        error_codes,
        vec!["API_ERROR_529".to_string()],
        "exactly one error must surface — the provider error, not also the result error"
    );

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages WHERE session_id = ? AND message_type = 'error'",
    )
    .bind(db_session_id)
    .fetch_one(&app_state.write_pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "only one error message persisted");
}

#[tokio::test]
async fn test_session_message_envelopes_carry_monotonic_seq() {
    // Clients detect a dropped stream envelope (silently truncated message)
    // via the per-stream `seq` stamp — it must be present and strictly
    // increasing on every `session.message` this reader emits.
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 95i64;
    let feature_id = 1i64;

    sqlx::query("INSERT INTO agent_sessions (id, feature_id, status) VALUES (?, ?, 'running')")
        .bind(db_session_id)
        .bind(feature_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();
    {
        let mut sessions = sdk_sessions.lock().await;
        sessions.insert(
            db_session_id,
            make_active_handle(feature_id, Some("cli".into())),
        );
    }

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(4);
    for text in ["hello ", "world"] {
        msg_tx
            .send(Ok(RuntimeEvent::new(
                crate::domain::agents::adapter::RuntimeEventMetadata {
                    session_id: Some("cli".to_string()),
                    usage: None,
                    context_window: None,
                    raw: serde_json::json!({
                        "type": "stream_event",
                        "event": {
                            "type": "content_block_delta",
                            "index": 0,
                            "delta": { "type": "text_delta", "text": text }
                        }
                    }),
                },
                RuntimeEventKind::StreamEvent {
                    event: crate::domain::agents::adapter::RuntimeStreamEvent::ContentBlockDelta {
                        index: 0,
                        delta: crate::domain::agents::adapter::RuntimeContentDelta::Text {
                            text: text.to_string(),
                        },
                    },
                    parent_tool_use_id: None,
                },
            )))
            .await
            .unwrap();
    }
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let mut seqs: Vec<u64> = Vec::new();
    while let Ok(Some(msg)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), ws_rx.recv()).await
    {
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            if env.action == "message" {
                let payload: SessionMessagePayload = serde_json::from_value(env.payload).unwrap();
                seqs.push(
                    payload
                        .seq
                        .expect("streamed session.message must carry seq"),
                );
            }
        }
    }
    assert_eq!(
        seqs,
        (1..=seqs.len() as u64).collect::<Vec<_>>(),
        "seq must start at 1 and increase without gaps"
    );
    assert!(seqs.len() >= 2, "both deltas must be forwarded");
}

/// A prompt the runtime dropped at a Stop (a Codex steer the stopped turn
/// never took in) reads as not delivered, for every viewer.
#[tokio::test]
async fn test_stream_reader_marks_a_dropped_prompt_not_delivered() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, _ws_rx) = mpsc::unbounded_channel();
    let (viewer_tx, mut viewer_rx) = mpsc::unbounded_channel();
    let db_session_id = 89i64;
    let feature_id = 1i64;
    sdk_sessions
        .lock()
        .await
        .insert(db_session_id, make_active_handle(feature_id, None));
    app_state
        .ws_feature_senders
        .register(feature_id, viewer_tx)
        .await;
    seed_pending_prompt(&app_state, db_session_id, feature_id, "client-dropped").await;

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(2);
    msg_tx
        .send(Ok(RuntimeEvent::prompt_dropped_event(
            "client-dropped".to_string(),
        )))
        .await
        .unwrap();
    drop(msg_tx);
    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let failed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let Some(Message::Text(text)) = viewer_rx.recv().await else {
                continue;
            };
            let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
            if envelope.action == "prompt_received" {
                return envelope.payload;
            }
        }
    })
    .await
    .expect("viewers learn the prompt was not delivered");
    assert_eq!(failed["delivery_state"], "delivery_failed");
    let state: Option<String> = sqlx::query_scalar(
        "SELECT delivery_state FROM agent_messages WHERE session_id = ? AND message_uuid = ?",
    )
    .bind(db_session_id)
    .bind("client-dropped")
    .fetch_one(&app_state.write_pool)
    .await
    .unwrap();
    assert_eq!(state.as_deref(), Some("delivery_failed"));
}
