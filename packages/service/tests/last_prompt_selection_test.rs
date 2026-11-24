//! New conversations inherit the last accepted interactive prompt across providers.
//! Isolated binary for the process-wide settings directory and Codex fixture.
mod common;
#[path = "common/ws.rs"]
mod ws;

use cadencr_service::domain::settings_store;
use cadencr_service::shared::app_paths;
use serde_json::{json, Value};
use std::path::Path;

async fn expect_event(socket: &mut ws::Socket, action: &str) -> Value {
    loop {
        let event = ws::next(socket).await;
        assert_ne!(event["action"], "error", "{event}");
        if event["action"] == action {
            return event["payload"].clone();
        }
    }
}

async fn initialize(server: &common::TestServer, feature: i64) -> (ws::Socket, Value) {
    initialize_with_mode(server, feature, None).await
}

async fn initialize_with_mode(
    server: &common::TestServer,
    feature: i64,
    permission_mode: Option<&str>,
) -> (ws::Socket, Value) {
    let mut socket = ws::connect(&server.base_url).await;
    let mut payload = json!({"feature_id": feature, "cwd": server.repo_path()});
    if let Some(mode) = permission_mode {
        payload["permission_mode"] = json!(mode);
    }
    ws::send(&mut socket, "session", "init", payload).await;
    let payload = expect_event(&mut socket, "initialized").await;
    (socket, payload)
}

async fn set_mode(socket: &mut ws::Socket, session: &Value, mode: &str) {
    ws::send(
        socket,
        "session",
        "mode.set",
        json!({"session_id": session, "mode": mode}),
    )
    .await;
    expect_event(socket, "mode.changed").await;
}

async fn set_provider(socket: &mut ws::Socket, session: &Value, provider: &str, model: &str) {
    ws::send(
        socket,
        "session",
        "provider.set",
        json!({"session_id": session, "provider": provider, "model": model}),
    )
    .await;
    expect_event(socket, "provider.set.ok").await;
}

async fn report_state(socket: &mut ws::Socket, session: &Value) -> String {
    let uuid = uuid::Uuid::new_v4().to_string();
    send_prompt(socket, session, "report state", &uuid).await;
    let mut text = String::new();
    loop {
        let event = ws::next(socket).await;
        assert_ne!(event["action"], "error", "{event}");
        if event["action"] == "ended" {
            return text;
        }
        if event["action"] == "message" {
            text.push_str(&event["payload"].to_string());
        }
    }
}

async fn create_feature(server: &common::TestServer, project_id: i64) -> i64 {
    let feature: Value = server
        .client
        .post(format!("{}/api/features", server.base_url))
        .json(&json!({"project_id": project_id, "worktree_mode": "skip"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    feature["id"].as_i64().unwrap()
}

async fn send_prompt(socket: &mut ws::Socket, session: &Value, text: &str, uuid: &str) {
    ws::send(
        socket,
        "session",
        "prompt.send",
        json!({
            "session_id": session, "text": text,
            "use_worktree": false, "message_uuid": uuid
        }),
    )
    .await;
}

async fn prompt(socket: &mut ws::Socket, session: &Value) -> String {
    let uuid = uuid::Uuid::new_v4().to_string();
    send_prompt(socket, session, "legacy", &uuid).await;
    expect_event(socket, "ended").await;
    uuid
}

async fn expect_provider_rejection(socket: &mut ws::Socket, session: &Value) {
    send_prompt(
        socket,
        session,
        "qa-reject",
        &uuid::Uuid::new_v4().to_string(),
    )
    .await;
    loop {
        let event = ws::next(socket).await;
        if event["action"] == "error" {
            assert!(
                event["payload"].to_string().contains("QA prompt rejected"),
                "{event}"
            );
            break;
        }
    }
}

async fn queued_prompt(server: &common::TestServer, session: &str) {
    let url = format!("{}/api/sessions/{session}/prompt-queue", server.base_url);
    let queued: Value = server
        .client
        .post(&url)
        .json(&json!({"content": "legacy"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let rows: Vec<Value> = server
                .client
                .get(&url)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            let row = rows.iter().find(|r| r["id"] == queued["id"]);
            match row.map(|r| &r["status"]).and_then(Value::as_str) {
                Some("delivered") | None => break,
                Some("pending" | "delivering") => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await
                }
                state => panic!("unexpected queue state: {state:?}, {row:?}"),
            }
        }
    })
    .await
    .expect("queued prompt should be delivered");
}

fn assert_codex_controls(payload: &Value, fast: bool, permission_mode: &str) {
    assert_eq!(payload["provider"], "codex_cli");
    assert_eq!(payload["model"], "qa-alternate");
    assert_eq!(payload["profile"], "work");
    assert_eq!(payload["thinking_effort"], "high");
    assert_eq!(payload["fast_mode"], fast);
    assert_eq!(payload["permission_mode"], permission_mode);
}

#[tokio::test]
async fn new_conversations_reuse_all_controls_including_permission_mode_across_providers() {
    let dir = tempfile::tempdir().unwrap();
    app_paths::pin_roots(Some(dir.path())).unwrap();
    let settings = app_paths::settings_dir().unwrap();
    let providers = settings.join("providers");
    std::fs::create_dir_all(&providers).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_acp_agent.py");
    for (id, args) in [
        ("fake-acp-agent", json!([])),
        ("fake-host-acp-agent", json!(["--host"])),
    ] {
        let descriptor = json!({
            "schema_version": 1,
            "agent": {
                "id": id, "name": "Fixture agent", "version": "1.0.0",
                "description": "Test fixture", "repository": "https://example.invalid/fixture", "license": "MIT"
            },
            "installation": {"executable": {"command": fixture, "args": args}}
        });
        std::fs::write(providers.join(format!("{id}.json")), descriptor.to_string()).unwrap();
    }
    settings_store::init(settings);
    settings_store::global_modify_object("codex_profiles", |profiles| {
        profiles.insert("work".into(), json!({"id":"work","name":"Work"}));
        Ok(())
    })
    .await
    .unwrap();
    codex_app_server_sdk_rs::set_binary_override(Some(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_codex_conversation.py"),
    ));
    let server = common::start_migrated_test_server().await;
    settings_store::global_set("agent_runtime_session", "codex_cli")
        .await
        .unwrap();
    let (mut socket, first) = initialize(&server, 1).await;
    assert_eq!(first["model"], "qa-model");
    assert!(first["runtime_overrides"]["model"].is_null());

    ws::send(
        &mut socket,
        "session",
        "profile.set",
        json!({"session_id": first["session_id"], "profile":"work"}),
    )
    .await;
    expect_event(&mut socket, "profile.changed").await;
    ws::send(
        &mut socket, "session", "runtime_overrides.set",
        json!({
            "session_id": first["session_id"],
            "runtime_overrides": {"model": "qa-alternate", "thinking_effort": "high", "fast_mode": true}
        }),
    ).await;
    expect_event(&mut socket, "runtime_overrides.changed").await;
    set_mode(&mut socket, &first["session_id"], "plan").await;
    let first_prompt = prompt(&mut socket, &first["session_id"]).await;
    let other_repo = server.tmp_dir.path().join("second-repo");
    std::fs::create_dir(&other_repo).unwrap();
    common::create_test_repo(&other_repo);
    let project: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, path) VALUES ('second project', ?) RETURNING id",
    )
    .bind(other_repo.to_str().unwrap())
    .fetch_one(&server.pool)
    .await
    .unwrap();
    let id = create_feature(&server, project).await;
    let (mut second_socket, second) = initialize(&server, id).await;
    assert_codex_controls(&second, true, "plan");

    // A queued first message has no WebSocket to initialize its controls.
    let queued_feature = create_feature(&server, project).await;
    let mut persistence =
        cadencr_service::domain::ws_session::persistence::WsSessionPersistence::new(
            server.pool.clone(),
            queued_feature,
        );
    let session = persistence
        .find_or_create_session_for_binding(None, None, None)
        .await
        .unwrap();
    queued_prompt(&server, &session.to_string()).await;
    let (_, from_queue) = initialize(&server, queued_feature).await;
    assert_codex_controls(&from_queue, true, "plan");

    // Reset Fast to the profile default and switch back to default mode.
    ws::send(
        &mut second_socket,
        "session",
        "runtime_overrides.set",
        json!({"session_id": second["session_id"], "runtime_overrides": {"fast_mode": null}}),
    )
    .await;
    let changed = expect_event(&mut second_socket, "runtime_overrides.changed").await;
    assert_eq!(changed["effective"]["fast_mode"], false);
    set_mode(&mut second_socket, &second["session_id"], "default").await;
    queued_prompt(&server, second["session_id"].as_str().unwrap()).await;
    let (mut next_socket, next) = initialize(&server, create_feature(&server, project).await).await;
    assert_codex_controls(&next, false, "default");

    // An installed ACP provider declaring modes (like Antigravity) restores its
    // last prompted mode on new conversations, both at initial spawn and after
    // live mode switches.
    set_provider(
        &mut next_socket,
        &next["session_id"],
        "fake-host-acp-agent",
        "fake-large",
    )
    .await;
    set_mode(&mut next_socket, &next["session_id"], "plan").await;
    let host_first_state = report_state(&mut next_socket, &next["session_id"]).await;
    assert!(
        host_first_state.contains("mode=plan "),
        "{host_first_state}"
    );

    let (mut host_second_socket, host_second) =
        initialize(&server, create_feature(&server, project).await).await;
    assert_eq!(host_second["provider"], "fake-host-acp-agent");
    assert_eq!(host_second["model"], "fake-large");
    assert_eq!(host_second["permission_mode"], "plan");
    let host_second_state = report_state(&mut host_second_socket, &host_second["session_id"]).await;
    assert!(
        host_second_state.contains("mode=plan "),
        "{host_second_state}"
    );

    // Switching live to another mode and prompting updates the mode inherited
    // by subsequent new conversations. ACP follow-ups emit `ended` on the
    // stream reader concurrently with `stream_followup_prompt` persisting
    // `last_prompt_selection`, so wait for the persisted snapshot to land.
    set_mode(&mut host_second_socket, &host_second["session_id"], "ask").await;
    let host_ask_state = report_state(&mut host_second_socket, &host_second["session_id"]).await;
    assert!(host_ask_state.contains("mode=ask "), "{host_ask_state}");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if settings_store::global_get("last_prompt_selection")
                .is_some_and(|raw| raw.contains(r#""permission_mode":"ask""#))
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("follow-up prompt should persist the switched permission mode");

    let (mut host_third_socket, host_third) =
        initialize(&server, create_feature(&server, project).await).await;
    assert_eq!(host_third["provider"], "fake-host-acp-agent");
    assert_eq!(host_third["model"], "fake-large");
    assert_eq!(host_third["permission_mode"], "ask");
    let host_third_state = report_state(&mut host_third_socket, &host_third["session_id"]).await;
    assert!(host_third_state.contains("mode=ask "), "{host_third_state}");

    // A queued first prompt on an installed ACP provider also inherits its mode.
    let queued_acp_feature = create_feature(&server, project).await;
    let mut acp_persistence =
        cadencr_service::domain::ws_session::persistence::WsSessionPersistence::new(
            server.pool.clone(),
            queued_acp_feature,
        );
    let acp_session = acp_persistence
        .find_or_create_session_for_binding(None, None, None)
        .await
        .unwrap();
    queued_prompt(&server, &acp_session.to_string()).await;
    let (_, from_acp_queue) = initialize(&server, queued_acp_feature).await;
    assert_eq!(from_acp_queue["provider"], "fake-host-acp-agent");
    assert_eq!(from_acp_queue["model"], "fake-large");
    assert_eq!(from_acp_queue["permission_mode"], "ask");

    // An explicit pre-init permission mode overrides the inherited mode and is
    // persisted durably (survives reconnect and DB inspection).
    let explicit_feature = create_feature(&server, project).await;
    let (_, host_explicit) = initialize_with_mode(&server, explicit_feature, Some("default")).await;
    assert_eq!(host_explicit["provider"], "fake-host-acp-agent");
    assert_eq!(host_explicit["model"], "fake-large");
    assert_eq!(host_explicit["permission_mode"], "default");
    let stored_explicit_mode: Option<String> =
        sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE feature_id = ?")
            .bind(explicit_feature)
            .fetch_one(&server.pool)
            .await
            .unwrap();
    assert_eq!(stored_explicit_mode.as_deref(), Some("default"));
    let (_, explicit_reopened) = initialize(&server, explicit_feature).await;
    assert_eq!(explicit_reopened["permission_mode"], "default");

    // Legacy snapshots (without `permission_mode`) and corrupted wire strings
    // fall back to the provider's primary mode and persist it durably.
    for snapshot in [
        r#"{"provider":"fake-host-acp-agent","model":"fake-large","profile":null,"thinking_effort":null,"fast_mode":false}"#,
        r#"{"provider":"fake-host-acp-agent","model":"fake-large","profile":null,"thinking_effort":null,"fast_mode":false,"permission_mode":"not-a-mode"}"#,
    ] {
        settings_store::global_set("last_prompt_selection", snapshot)
            .await
            .unwrap();
        let fallback_feature = create_feature(&server, project).await;
        let (_, initialized) = initialize(&server, fallback_feature).await;
        assert_eq!(initialized["provider"], "fake-host-acp-agent");
        assert_eq!(initialized["model"], "fake-large");
        assert_eq!(initialized["permission_mode"], "default");
        let stored_mode: Option<String> =
            sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE feature_id = ?")
                .bind(fallback_feature)
                .fetch_one(&server.pool)
                .await
                .unwrap();
        assert_eq!(stored_mode.as_deref(), Some("default"));
    }

    // The next prompt comes from another provider with no profiles, effort, modes or Fast.
    let (mut plain_socket, plain) =
        initialize(&server, create_feature(&server, project).await).await;
    set_provider(
        &mut plain_socket,
        &plain["session_id"],
        "fake-acp-agent",
        "fake-large",
    )
    .await;
    prompt(&mut plain_socket, &plain["session_id"]).await;
    // Replaying the first message on its original runtime must leave the ACP selection intact.
    send_prompt(&mut socket, &first["session_id"], "legacy", &first_prompt).await;
    ws::send(
        &mut socket,
        "session",
        "init",
        json!({"feature_id": 1, "cwd": server.repo_path()}),
    )
    .await;
    expect_event(&mut socket, "initialized").await;
    assert_eq!(
        settings_store::global_get("agent_runtime_session").as_deref(),
        Some("fake-acp-agent")
    );

    expect_provider_rejection(&mut socket, &first["session_id"]).await;
    // The same failure during the first spawn must also keep the last delivered selection.
    let (mut pending_socket, pending) =
        initialize(&server, create_feature(&server, project).await).await;
    set_provider(
        &mut pending_socket,
        &pending["session_id"],
        "codex_cli",
        "qa-model",
    )
    .await;
    expect_provider_rejection(&mut pending_socket, &pending["session_id"]).await;
    // An older per-model preference must not replace the prompt's default effort.
    let effort_key = cadencr_service::domain::settings::thinking_effort_model_key(
        "fake-acp-agent",
        "fake-large",
    );
    settings_store::global_set(&effort_key, "high")
        .await
        .unwrap();
    let (_, third) = initialize(&server, create_feature(&server, project).await).await;
    assert_eq!(third["provider"], "fake-acp-agent");
    assert_eq!(third["model"], "fake-large");
    assert!(third["profile"].is_null());
    assert!(third["thinking_effort"].is_null());
    assert_eq!(third["fast_mode"], false);
    assert!(third["permission_mode"].is_null());

    let (_, reopened) = initialize(&server, 1).await;
    assert_eq!(reopened["session_id"], first["session_id"]);
    assert_codex_controls(&reopened, true, "plan");
}
