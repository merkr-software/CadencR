use super::support::*;

#[tokio::test]
async fn test_stream_reader_transitions_active_to_pending_on_stream_close() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 42i64;
    let feature_id = 1i64;
    let cli_session_id = "cli-sess-for-resume".to_string();

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

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    msg_tx
        .send(Ok(RuntimeEvent::prompt_received_event(
            "client-xyz".to_string(),
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

    tokio::time::timeout(std::time::Duration::from_secs(2), ws_rx.recv())
        .await
        .expect("owner should receive a message");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let saw_prompt_received = |rx: &mut mpsc::UnboundedReceiver<Message>| {
        std::iter::from_fn(|| rx.try_recv().ok()).any(|msg| {
            matches!(msg, Message::Text(text)
            if serde_json::from_str::<WsEnvelope>(&text).is_ok_and(|env| {
                env.action == "prompt_received"
                    && env.payload.get("client_message_id").and_then(|v| v.as_str())
                        == Some("client-xyz")
            }))
        })
    };

    assert!(
        saw_prompt_received(&mut viewer_rx),
        "a passive viewer must also receive the mirrored prompt_received"
    );
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

    sqlx::query(
        "INSERT INTO agent_sessions (id, feature_id, agent_type, status) VALUES (?, ?, 'session', 'running')"
    )
    .bind(db_session_id)
    .bind(feature_id)
    .execute(&app_state.write_pool)
    .await
    .unwrap();

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
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

    let msg = ws_rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "error");
    } else {
        panic!("expected text message");
    }

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

#[tokio::test]
async fn test_stream_close_mid_turn_surfaces_an_error() {
    // The CLI process went away (clean EOF, no SDK error) while a turn was
    // still running. That must surface as a visible `session.error`, not a
    // silent `stream_closed`, so the agent never appears to just stop.
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 77i64;
    let feature_id = 1i64;

    // A turn is in flight: the DB row is `running`.
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

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    // A `message_start` flips the reader out of "between turns" so the close is
    // recognised as mid-turn; then dropping the sender closes the stream.
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("cli".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({ "type": "stream_event" }),
            },
            RuntimeEventKind::StreamEvent {
                event: crate::domain::agents::adapter::RuntimeStreamEvent::MessageStart {
                    model: Some("claude-opus-4-8".to_string()),
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
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    // Drain envelopes until we see the error (the message_start forward and any
    // status updates may arrive first).
    let mut saw_error = false;
    while let Ok(Some(msg)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), ws_rx.recv()).await
    {
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            if env.action == "error" {
                let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
                assert_eq!(payload.code, "AGENT_STOPPED");
                saw_error = true;
                break;
            }
            assert_ne!(
                env.action, "ended",
                "a mid-turn close must not report a benign `ended`"
            );
        }
    }
    assert!(
        saw_error,
        "expected a session.error for the mid-turn stream close"
    );

    // The session was paused and an error message persisted for history reload.
    let row: (String, i64) = sqlx::query_as(
        "SELECT status, (SELECT COUNT(*) FROM agent_messages WHERE session_id = ? AND message_type = 'error') FROM agent_sessions WHERE id = ?",
    )
    .bind(db_session_id)
    .bind(db_session_id)
    .fetch_one(&app_state.write_pool)
    .await
    .unwrap();
    assert_eq!(row.0, "paused");
    assert_eq!(row.1, 1);
}

#[tokio::test]
async fn test_intentional_teardown_mid_turn_closes_benignly() {
    // An intentional teardown (session.clear / session.destroy) flips the DB
    // status off `running` BEFORE closing the subprocess. The reader must then
    // treat the clean mid-turn close as benign (`stream_closed`), NOT raise the
    // spurious `AGENT_STOPPED` meant only for an unexpected agent death. This
    // guards the contract `handle_clear`/`handle_destroy` rely on.
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();

    let db_session_id = 79i64;
    let feature_id = 1i64;

    // Status is already `completed` — i.e. an intentional teardown ran first.
    sqlx::query("INSERT INTO agent_sessions (id, feature_id, status) VALUES (?, ?, 'completed')")
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

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    // A `message_start` flips the reader out of "between turns" so the close is
    // mid-turn; dropping the sender then closes the stream.
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("cli".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({ "type": "stream_event" }),
            },
            RuntimeEventKind::StreamEvent {
                event: crate::domain::agents::adapter::RuntimeStreamEvent::MessageStart {
                    model: Some("claude-opus-4-8".to_string()),
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
        sdk_sessions.clone(),
        crate::domain::agents::runtime::DEFAULT_PROVIDER,
    );

    let mut saw_ended = false;
    while let Ok(Some(msg)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), ws_rx.recv()).await
    {
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_ne!(
                env.action, "error",
                "an intentional teardown must not raise a spurious error"
            );
            if env.action == "ended" {
                let payload: SessionEndedPayload = serde_json::from_value(env.payload).unwrap();
                assert_eq!(payload.reason, "stream_closed");
                saw_ended = true;
                break;
            }
        }
    }
    assert!(
        saw_ended,
        "expected a benign `ended` for the intentional close"
    );

    // No error message was persisted.
    let errors: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages WHERE session_id = ? AND message_type = 'error'",
    )
    .bind(db_session_id)
    .fetch_one(&app_state.write_pool)
    .await
    .unwrap();
    assert_eq!(errors, 0);
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
    let row: (String, i64) = sqlx::query_as(
        "SELECT status, (SELECT COUNT(*) FROM agent_messages WHERE session_id = ? AND message_type = 'error') FROM agent_sessions WHERE id = ?",
    )
    .bind(db_session_id)
    .bind(db_session_id)
    .fetch_one(&app_state.write_pool)
    .await
    .unwrap();
    assert_eq!(row.0, "completed");
    assert_eq!(row.1, 1);
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
