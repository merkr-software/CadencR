//! Permission-mode plumbing: the `parse_permission_mode` /
//! `provider_supports_mode` / `*_wire` helpers, `mode.set` validation, and
//! the `provider.set` mode-reset + `mode.changed` broadcast.

use super::support::*;

// ----- parse_permission_mode + provider_supports_mode -----

#[test]
fn parse_permission_mode_recognizes_auto() {
    assert_eq!(parse_permission_mode("auto"), RuntimePermissionMode::Auto);
}

#[test]
fn parse_permission_mode_recognizes_ask() {
    assert_eq!(parse_permission_mode("ask"), RuntimePermissionMode::Ask);
}

#[test]
fn parse_permission_mode_falls_back_to_default_for_unknown() {
    assert_eq!(
        parse_permission_mode("not-a-mode"),
        RuntimePermissionMode::Default
    );
}

#[test]
fn claude_code_supports_every_mode() {
    for mode in [
        RuntimePermissionMode::Default,
        RuntimePermissionMode::AcceptEdits,
        RuntimePermissionMode::Plan,
        RuntimePermissionMode::Auto,
        RuntimePermissionMode::BypassPermissions,
        RuntimePermissionMode::DontAsk,
    ] {
        assert!(
            provider_supports_mode("claude_code", &mode),
            "claude_code should support {mode:?}"
        );
    }
}

#[test]
fn opencode_supports_only_build_and_plan_levels() {
    assert!(provider_supports_mode(
        "opencode",
        &RuntimePermissionMode::Default
    ));
    assert!(provider_supports_mode(
        "opencode",
        &RuntimePermissionMode::AcceptEdits
    ));
    assert!(provider_supports_mode(
        "opencode",
        &RuntimePermissionMode::Plan
    ));
    assert!(!provider_supports_mode(
        "opencode",
        &RuntimePermissionMode::Ask
    ));
    assert!(!provider_supports_mode(
        "opencode",
        &RuntimePermissionMode::Auto
    ));
    assert!(!provider_supports_mode(
        "opencode",
        &RuntimePermissionMode::BypassPermissions
    ));
}

#[test]
fn codex_supports_default_plan_and_full_access() {
    assert!(provider_supports_mode(
        "codex_cli",
        &RuntimePermissionMode::Default
    ));
    assert!(provider_supports_mode(
        "codex_cli",
        &RuntimePermissionMode::Plan
    ));
    assert!(provider_supports_mode(
        "codex_cli",
        &RuntimePermissionMode::BypassPermissions
    ));
    assert!(!provider_supports_mode(
        "codex_cli",
        &RuntimePermissionMode::Ask
    ));
    assert!(!provider_supports_mode(
        "codex_cli",
        &RuntimePermissionMode::Auto
    ));
    assert!(!provider_supports_mode(
        "codex_cli",
        &RuntimePermissionMode::DontAsk
    ));
}

#[test]
fn default_permission_mode_wire_matches_frontend_catalog() {
    // These wire strings must match `defaultEditModeFor` in
    // packages/desktop/src/lib/provider-modes.ts. Drift between BE/FE here
    // would silently put the chip in a state the backend never wrote.
    assert_eq!(default_permission_mode_wire("claude_code"), "auto");
    assert_eq!(default_permission_mode_wire("opencode"), "acceptEdits");
    assert_eq!(default_permission_mode_wire("codex_cli"), "default");
    assert_eq!(default_permission_mode_wire("cursor"), "default");
    assert_eq!(default_permission_mode_wire("__unknown__"), "acceptEdits");
}

#[test]
fn post_plan_approval_mode_wire_matches_frontend_catalog() {
    // OpenCode + Codex inherit their `default_permission_mode_wire` since
    // they don't have a classifier-backed mode. The Claude branch is
    // exercised by adapter-level tests with a seeded model catalog —
    // here we just confirm the dispatch + non-Claude fallbacks.
    assert_eq!(
        post_plan_approval_mode_wire("opencode", None),
        "acceptEdits"
    );
    assert_eq!(
        post_plan_approval_mode_wire("opencode", Some("opencode-default")),
        "acceptEdits"
    );
    assert_eq!(post_plan_approval_mode_wire("codex_cli", None), "default");
    assert_eq!(
        post_plan_approval_mode_wire("codex_cli", Some("gpt-5")),
        "default"
    );
    assert_eq!(
        post_plan_approval_mode_wire("__unknown__", None),
        "acceptEdits"
    );
}

// ----- handle_mode_set integration: provider/mode validation -----

#[tokio::test]
async fn mode_set_rejects_modes_not_supported_by_active_provider() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;

    // Init an OpenCode session.
    let session_id = init_session_with_payload(
        &tx,
        &mut rx,
        &sdk_sessions,
        &app_state,
        SessionInitPayload {
            provider: Some("opencode".to_string()),
            model: None,
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some("/tmp/test".to_string()),
            feature_id: Some(1),
        },
    )
    .await;

    // Ask for `auto` — Claude-only. The handler must reject it via
    // MODE_NOT_SUPPORTED instead of silently writing the mode through to
    // the OpenCode adapter (which would launch the wrong agent).
    let envelope = make_envelope(
        "session",
        "mode.set",
        serde_json::json!({ "session_id": session_id, "mode": "auto" }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "error");
        let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
        assert_eq!(payload.code, "MODE_NOT_SUPPORTED");
    } else {
        panic!("expected text message");
    }

    // Sanity: the in-memory handle's desired mode wasn't poisoned by the
    // failed request. session.init seeds the active provider's default
    // when the client doesn't supply one; a rejected mode.set must leave
    // that untouched.
    let sessions = sdk_sessions.lock().await;
    let db_id: i64 = session_id.parse().unwrap();
    let handle = sessions.get(&db_id).unwrap();
    assert_eq!(
        handle.desired_permission_mode,
        Some(default_permission_mode("opencode"))
    );
}

#[tokio::test]
async fn mode_set_rejection_keeps_accepted_mode_as_desired_mode() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;

    sqlx::query(
        "INSERT INTO agent_sessions (id, feature_id, agent_type, status, permission_mode) VALUES (77, 1, 'session', 'idle', 'plan')",
    )
    .execute(&app_state.write_pool)
    .await
    .unwrap();

    let (permission_tx, _permission_rx) = mpsc::channel(1);
    let query: RuntimeSessionHandle = Arc::new(RwLock::new(Box::new(RejectingModeSession::new())));
    sdk_sessions.lock().await.insert(
        77,
        SdkHandle {
            state: QueryState::Active {
                query,
                permission_tx,
            },
            feature_id: 1,
            runtime_provider: "claude_code".to_string(),
            desired_model: None,
            spawned_model: None,
            desired_permission_mode: Some(RuntimePermissionMode::Plan),
            spawned_permission_mode: Some(RuntimePermissionMode::Plan),
            desired_access_mode: None,
            spawned_access_mode: None,
            desired_thinking_effort: None,
            spawned_thinking_effort: None,
            desired_claude_profile: None,
            spawned_claude_profile: None,
            runtime_control_endpoint: None,
            resume_session_id: None,
            config: SessionConfig {
                cwd: PathBuf::from("/tmp/test"),
                canonical_cwd: PathBuf::from("/tmp/test"),
                permission_mode: Some(RuntimePermissionMode::Plan),
                access_mode: None,
                thinking_effort: None,
                fast_mode: false,
                system_prompt: None,
                allow_bypass_permissions: false,
                claude_profile: None,
                env: None,
                env_unset: Vec::new(),
                overrides: Default::default(),
                runtime_overrides_dirty: false,
                profile_revision: None,
                profile_state_identity: None,
            },
            manual_compact_cancel: Arc::new(AtomicBool::new(false)),
            manual_compact_spawn_pending: Arc::new(AtomicBool::new(false)),
        },
    );

    let envelope = make_envelope(
        "session",
        "mode.set",
        serde_json::json!({ "session_id": "77", "mode": "bypassPermissions" }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "error");
        let payload: SessionErrorPayload = serde_json::from_value(env.payload).unwrap();
        assert_eq!(payload.code, "MODE_REJECTED_BY_CLI");
        assert_eq!(payload.mode.as_deref(), Some("bypassPermissions"));
    } else {
        panic!("expected text message");
    }

    let (desired_mode, spawned_mode, config_mode) = {
        let sessions = sdk_sessions.lock().await;
        let handle = sessions.get(&77).unwrap();
        (
            handle.desired_permission_mode.clone(),
            handle.spawned_permission_mode.clone(),
            handle.config.permission_mode.clone(),
        )
    };
    assert_eq!(desired_mode, Some(RuntimePermissionMode::Plan));
    assert_eq!(spawned_mode, Some(RuntimePermissionMode::Plan));
    assert_eq!(config_mode, Some(RuntimePermissionMode::Plan));

    let persisted_mode: Option<String> =
        sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE id = 77")
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
    assert_eq!(persisted_mode.as_deref(), Some("plan"));
}

#[tokio::test]
async fn claude_bypass_mode_set_rearms_existing_session_before_next_prompt() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;

    // Workspace settings live in the JSON store now (not the SQLite `settings`
    // table), so seed via the repository that production reads through.
    crate::domain::workspace::repository::set_setting(
        &app_state.write_pool,
        "claude_bypass_permissions_enabled",
        "true",
    )
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_sessions (id, feature_id, agent_type, status, permission_mode) VALUES (78, 1, 'session', 'idle', 'plan')",
    )
    .execute(&app_state.write_pool)
    .await
    .unwrap();

    let (permission_tx, _permission_rx) = mpsc::channel(1);
    let query: RuntimeSessionHandle = Arc::new(RwLock::new(Box::new(RejectingModeSession::new())));
    sdk_sessions.lock().await.insert(
        78,
        SdkHandle {
            state: QueryState::Active {
                query,
                permission_tx,
            },
            feature_id: 1,
            runtime_provider: "claude_code".to_string(),
            desired_model: Some("sonnet".to_string()),
            spawned_model: Some("sonnet".to_string()),
            desired_permission_mode: Some(RuntimePermissionMode::Plan),
            spawned_permission_mode: Some(RuntimePermissionMode::Plan),
            desired_access_mode: None,
            spawned_access_mode: None,
            desired_thinking_effort: None,
            spawned_thinking_effort: None,
            desired_claude_profile: None,
            spawned_claude_profile: None,
            runtime_control_endpoint: None,
            resume_session_id: None,
            config: SessionConfig {
                cwd: PathBuf::from("/tmp/test"),
                canonical_cwd: PathBuf::from("/tmp/test"),
                permission_mode: Some(RuntimePermissionMode::Plan),
                access_mode: None,
                thinking_effort: None,
                fast_mode: false,
                system_prompt: None,
                allow_bypass_permissions: false,
                claude_profile: None,
                env: None,
                env_unset: Vec::new(),
                overrides: Default::default(),
                runtime_overrides_dirty: false,
                profile_revision: None,
                profile_state_identity: None,
            },
            manual_compact_cancel: Arc::new(AtomicBool::new(false)),
            manual_compact_spawn_pending: Arc::new(AtomicBool::new(false)),
        },
    );

    let envelope = make_envelope(
        "session",
        "mode.set",
        serde_json::json!({ "session_id": "78", "mode": "bypassPermissions" }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "mode.changed");
        assert_eq!(
            env.payload.get("mode").and_then(|v| v.as_str()),
            Some("bypassPermissions")
        );
    } else {
        panic!("expected text message");
    }

    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&78).unwrap();
    let QueryState::Pending(options) = &handle.state else {
        panic!("existing Claude session should be rearmed as pending");
    };
    assert!(options.allow_bypass_permissions);
    assert_eq!(
        options.permission_mode,
        Some(RuntimePermissionMode::BypassPermissions)
    );
    assert_eq!(
        handle.desired_permission_mode,
        Some(RuntimePermissionMode::BypassPermissions)
    );
}

// ----- handle_provider_set: mode reset + mode.changed broadcast -----

#[tokio::test]
async fn provider_set_resets_permission_mode_and_broadcasts_mode_changed() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;

    // Start in Claude with `plan` selected.
    let session_id = init_session_with_payload(
        &tx,
        &mut rx,
        &sdk_sessions,
        &app_state,
        SessionInitPayload {
            provider: Some("claude_code".to_string()),
            model: None,
            thinking_effort: None,
            permission_mode: Some("plan".to_string()),
            system_prompt: None,
            cwd: Some("/tmp/test".to_string()),
            feature_id: Some(1),
        },
    )
    .await;

    // Drain any extra messages from init (e.g. runtime_session_id).
    while rx.try_recv().is_ok() {}

    // Switch to Codex pre-conversation.
    let envelope = make_envelope(
        "session",
        "provider.set",
        serde_json::json!({ "session_id": session_id, "provider": "codex_cli" }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    // Two envelopes back: provider.set.ok, then mode.changed.
    let mut saw_provider_ok = false;
    let mut saw_mode_changed = false;
    for _ in 0..2 {
        let msg = rx.recv().await.unwrap();
        if let Message::Text(text) = msg {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            if env.action == "provider.set.ok" {
                saw_provider_ok = true;
            } else if env.action == "mode.changed" {
                saw_mode_changed = true;
                let mode = env.payload.get("mode").and_then(|v| v.as_str()).unwrap();
                assert_eq!(mode, "default", "Codex's default chip mode is `default`");
            }
        }
    }
    assert!(saw_provider_ok, "expected provider.set.ok envelope");
    assert!(
        saw_mode_changed,
        "expected mode.changed envelope after provider switch"
    );

    // Internal state was reset to the Codex default the chip now shows,
    // rather than carrying the stale Claude `Plan` into the next spawn.
    let sessions = sdk_sessions.lock().await;
    let db_id: i64 = session_id.parse().unwrap();
    let handle = sessions.get(&db_id).unwrap();
    let codex_default = Some(RuntimePermissionMode::Default);
    assert_eq!(handle.desired_permission_mode, codex_default);
    assert_eq!(handle.config.permission_mode, codex_default);
    if let QueryState::Pending(options) = &handle.state {
        assert_eq!(options.permission_mode, codex_default);
    } else {
        panic!("expected pending state");
    }
}

#[tokio::test]
async fn provider_set_to_same_provider_is_a_noop_for_mode_state() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;

    let session_id = init_session_with_payload(
        &tx,
        &mut rx,
        &sdk_sessions,
        &app_state,
        SessionInitPayload {
            provider: Some("claude_code".to_string()),
            model: None,
            thinking_effort: None,
            permission_mode: Some("plan".to_string()),
            system_prompt: None,
            cwd: Some("/tmp/test".to_string()),
            feature_id: Some(1),
        },
    )
    .await;
    while rx.try_recv().is_ok() {}

    let envelope = make_envelope(
        "session",
        "provider.set",
        serde_json::json!({ "session_id": session_id, "provider": "claude_code" }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    // Only provider.set.ok; no mode.changed since nothing changed.
    let msg = rx.recv().await.unwrap();
    if let Message::Text(text) = msg {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(env.action, "provider.set.ok");
    }
    assert!(
        rx.try_recv().is_err(),
        "no mode.changed should fire when provider didn't actually change"
    );

    let sessions = sdk_sessions.lock().await;
    let db_id: i64 = session_id.parse().unwrap();
    let handle = sessions.get(&db_id).unwrap();
    assert_eq!(
        handle.desired_permission_mode,
        Some(RuntimePermissionMode::Plan),
        "permission mode preserved on same-provider re-set"
    );
}
