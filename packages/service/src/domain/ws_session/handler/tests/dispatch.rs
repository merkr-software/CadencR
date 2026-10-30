//! Top-level dispatch routing: unknown domain/action handling and the
//! `parse_session_id` helper.

use super::support::*;

#[tokio::test]
async fn test_unknown_domain_returns_error() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));

    let envelope = make_envelope("unknown_domain", "init", serde_json::json!({}));
    let app_state = make_test_app_state().await;
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "error");
        let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
        assert_eq!(payload.code, "UNKNOWN_DOMAIN");
    } else {
        panic!("expected text message");
    }
}

#[tokio::test]
async fn test_unknown_action_returns_error() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));

    let envelope = make_envelope("session", "nonexistent_action", serde_json::json!({}));
    let app_state = make_test_app_state().await;
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "error");
        let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
        assert_eq!(payload.code, "UNKNOWN_ACTION");
    } else {
        panic!("expected text message");
    }
}

#[tokio::test]
async fn neovim_key_input_action_dispatches_to_send_keys() {
    // Skip: NeovimManager is now a stub (RPC surface removed).
    // The PTY-based migration will re-implement this test.
    eprintln!("SKIP: NeovimManager is a stub; PTY migration pending");
}

#[tokio::test]
async fn test_parse_session_id() {
    assert_eq!(parse_session_id("42"), Some(42));
    assert_eq!(parse_session_id("abc"), None);
    assert_eq!(parse_session_id(""), None);
}

#[tokio::test]
async fn typed_command_routing_preserves_existing_payload_errors_and_refs() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    for (action, payload, code, message) in [
        (
            "prompt.send",
            serde_json::json!({"session_id": "42"}),
            "INVALID_PAYLOAD",
            "missing field `text`",
        ),
        (
            "branch.rewind",
            serde_json::json!({"session_id": "42"}),
            "INVALID_PAYLOAD",
            "missing field `message_id`",
        ),
        (
            "draft.get",
            serde_json::json!({"session_id": "42"}),
            "INVALID_PAYLOAD",
            "invalid type: string",
        ),
        (
            "retry_worktree_setup",
            serde_json::json!({}),
            "MISSING_FEATURE_ID",
            "feature_id is required",
        ),
        (
            "retry_worktree_setup",
            serde_json::json!({"feature_id": 1, "session_id": 42}),
            "NO_WORKTREE",
            "No worktree found for this feature",
        ),
        (
            "init",
            serde_json::json!({}),
            "MISSING_FEATURE_ID",
            "feature_id is required for session init",
        ),
        (
            "codex_permission_mode.set",
            serde_json::json!({}),
            "INVALID_PAYLOAD",
            "missing field `session_id`",
        ),
        (
            "future.command",
            serde_json::json!({}),
            "UNKNOWN_ACTION",
            "Unknown session action: future.command",
        ),
    ] {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let envelope = make_envelope("session", action, payload);
        let original_id = envelope.id.clone();
        dispatch_envelope(envelope, &sender, &sdk_sessions, &app_state).await;
        let Message::Text(text) = receiver.try_recv().expect("command must reply") else {
            panic!("expected text reply");
        };
        let reply: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(reply.action, "error", "{action}");
        assert_eq!(
            reply.r#ref.as_deref(),
            Some(original_id.as_str()),
            "{action}"
        );
        let payload: SessionErrorPayload = serde_json::from_value(reply.payload).unwrap();
        assert_eq!(payload.code, code, "{action}");
        assert!(
            payload.message.starts_with(message),
            "{action}: {}",
            payload.message
        );
    }
}
