//! Bidirectional remote session controls: a turn started on one connection
//! (e.g. a phone/remote) must be controllable from another connection (e.g. the
//! host), and the resulting change must mirror to every device viewing the
//! feature. Mirrors the cross-connection setup in `prompt.rs`.

use super::support::*;

/// Build an owner connection (A) that drives a live `Active` turn for a freshly
/// initialized session, registered as the turn owner in the global registry —
/// the shape a conversation started on a remote device has on the host.
async fn owner_with_live_turn(
    app_state: &AppState,
    feature_id: i64,
) -> (WsSender, mpsc::UnboundedReceiver<Message>, SdkSessions, i64) {
    let (tx_a, mut rx_a) = mpsc::unbounded_channel();
    let owner_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let session_id = init_session(&tx_a, &mut rx_a, &owner_sessions, app_state, feature_id).await;
    let db_id: i64 = session_id.parse().unwrap();
    {
        let mut sessions = owner_sessions.lock().await;
        let handle = sessions.get_mut(&db_id).unwrap();
        let (permission_tx, _permission_rx) = session_prompt::permission_response_channel();
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(InPlaceEffortSession::new()))),
            permission_tx,
        };
    }
    app_state
        .active_turns
        .begin_turn(db_id, &owner_sessions)
        .await;
    // As `mark_agent_running` announces every turn it starts.
    app_state
        .session_status_tx
        .broadcast_running(db_id, feature_id);
    // Drain everything `init` emitted so later assertions only see the mirror.
    while rx_a.try_recv().is_ok() {}
    (tx_a, rx_a, owner_sessions, db_id)
}

fn action_of(msg: Message) -> WsEnvelope {
    let Message::Text(text) = msg else {
        panic!("expected text message");
    };
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn test_host_mode_set_reaches_remote_started_session_and_mirrors() {
    let app_state = make_test_app_state().await;
    let feature_id = 1i64;
    let (_tx_a, mut rx_a, owner_sessions, db_id) =
        owner_with_live_turn(&app_state, feature_id).await;

    // Host connection B: no handle of its own for this session.
    let (tx_b, mut rx_b) = mpsc::unbounded_channel();
    let host_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));

    let envelope = make_envelope(
        "session",
        "mode.set",
        serde_json::json!({ "session_id": db_id.to_string(), "mode": "plan" }),
    );
    dispatch_envelope(envelope, &tx_b, &host_sessions, &app_state).await;

    // The host gets its direct reply...
    let reply = action_of(rx_b.recv().await.unwrap());
    assert_eq!(reply.action, "mode.changed");
    // ...and the change mirrors to the other device viewing the feature.
    let mirror = action_of(rx_a.recv().await.unwrap());
    assert_eq!(mirror.action, "mode.changed");

    // The live turn — owned by A — actually received the new mode.
    let desired = {
        let sessions = owner_sessions.lock().await;
        sessions
            .get(&db_id)
            .unwrap()
            .desired_permission_mode
            .clone()
    };
    assert_eq!(desired, Some(RuntimePermissionMode::Plan));

    let persisted: Option<String> =
        sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE id = ?")
            .bind(db_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted.as_deref(), Some("plan"));
}

#[tokio::test]
async fn test_host_model_set_reaches_remote_started_session_and_mirrors() {
    let app_state = make_test_app_state().await;
    let feature_id = 1i64;
    let (_tx_a, mut rx_a, _owner_sessions, db_id) =
        owner_with_live_turn(&app_state, feature_id).await;

    let (tx_b, mut rx_b) = mpsc::unbounded_channel();
    let host_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));

    let envelope = make_envelope(
        "session",
        "model.set",
        serde_json::json!({ "session_id": db_id.to_string(), "model": "opus" }),
    );
    dispatch_envelope(envelope, &tx_b, &host_sessions, &app_state).await;

    let reply = action_of(rx_b.recv().await.unwrap());
    assert_eq!(reply.action, "model.set.ok");
    let mirror = action_of(rx_a.recv().await.unwrap());
    assert_eq!(mirror.action, "model.set.ok");

    let persisted: Option<String> =
        sqlx::query_scalar("SELECT model FROM agent_sessions WHERE id = ?")
            .bind(db_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted.as_deref(), Some("opus"));
}

#[tokio::test]
async fn test_host_interrupt_reaches_remote_started_session() {
    let app_state = make_test_app_state().await;
    let feature_id = 1i64;
    let (_tx_a, _rx_a, _owner_sessions, db_id) = owner_with_live_turn(&app_state, feature_id).await;

    let (tx_b, mut rx_b) = mpsc::unbounded_channel();
    let host_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));

    let envelope = make_envelope(
        "session",
        "interrupt",
        serde_json::json!({ "session_id": db_id.to_string() }),
    );
    dispatch_envelope(envelope, &tx_b, &host_sessions, &app_state).await;

    // Before the fix the host's own (empty) map yielded SESSION_NOT_FOUND. With
    // the owner-registry fallback the interrupt resolves to A's live turn and
    // succeeds silently — so the host receives no error envelope.
    assert!(
        rx_b.try_recv().is_err(),
        "interrupt from the host must resolve the remote-owned turn, not error"
    );
}
