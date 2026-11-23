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
    let mut socket = ws::connect(&server.base_url).await;
    ws::send(
        &mut socket,
        "session",
        "init",
        json!({"feature_id": feature, "cwd": server.repo_path()}),
    )
    .await;
    let payload = expect_event(&mut socket, "initialized").await;
    (socket, payload)
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

fn assert_codex_controls(payload: &Value, fast: bool) {
    assert_eq!(payload["provider"], "codex_cli");
    assert_eq!(payload["model"], "qa-alternate");
    assert_eq!(payload["profile"], "work");
    assert_eq!(payload["thinking_effort"], "high");
    assert_eq!(payload["fast_mode"], fast);
}

#[tokio::test]
async fn new_conversations_reuse_all_five_controls_across_providers() {
    let dir = tempfile::tempdir().unwrap();
    app_paths::pin_roots(Some(dir.path())).unwrap();
    let settings = app_paths::settings_dir().unwrap();
    let providers = settings.join("providers");
    std::fs::create_dir_all(&providers).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_acp_agent.py");
    let descriptor = json!({
        "schema_version": 1,
        "agent": {
            "id": "fake-acp-agent", "name": "Fixture agent", "version": "1.0.0",
            "description": "Test fixture", "repository": "https://example.invalid/fixture", "license": "MIT"
        },
        "installation": {"executable": {"command": fixture}}
    });
    std::fs::write(
        providers.join("fake-acp-agent.json"),
        descriptor.to_string(),
    )
    .unwrap();
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
    assert_codex_controls(&second, true);

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
    assert_codex_controls(&from_queue, true);

    // Reset Fast to the profile default without changing the provider, model or effort.
    ws::send(
        &mut second_socket,
        "session",
        "runtime_overrides.set",
        json!({"session_id": second["session_id"], "runtime_overrides": {"fast_mode": null}}),
    )
    .await;
    let changed = expect_event(&mut second_socket, "runtime_overrides.changed").await;
    assert_eq!(changed["effective"]["fast_mode"], false);
    queued_prompt(&server, second["session_id"].as_str().unwrap()).await;
    let (mut next_socket, next) = initialize(&server, create_feature(&server, project).await).await;
    assert_codex_controls(&next, false);

    // The next prompt comes from another provider with no profiles, effort or Fast.
    ws::send(
        &mut next_socket, "session", "provider.set",
        json!({"session_id": next["session_id"], "provider": "fake-acp-agent", "model": "fake-large"}),
    ).await;
    expect_event(&mut next_socket, "provider.set.ok").await;
    prompt(&mut next_socket, &next["session_id"]).await;
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
    ws::send(
        &mut pending_socket,
        "session",
        "provider.set",
        json!({
            "session_id": pending["session_id"], "provider": "codex_cli", "model": "qa-model",
        }),
    )
    .await;
    expect_event(&mut pending_socket, "provider.set.ok").await;
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

    let (_, reopened) = initialize(&server, 1).await;
    assert_eq!(reopened["session_id"], first["session_id"]);
    assert_codex_controls(&reopened, true);
}
