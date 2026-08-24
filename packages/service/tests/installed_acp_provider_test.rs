//! End-to-end proof that a code-backed provider executable becomes a usable
//! provider through the shared package contract.
//!
//! The agent under test is `tests/fixtures/fake_acp_agent.py`: a deterministic
//! ACP v1 process that implements only the baseline (`initialize`,
//! `session/new`, `session/prompt`, `session/cancel`) and answers "method not
//! found" to everything else. If Cadencr needed any optional capability to
//! drive it, these tests would fail.
//!
//! Scope is deliberately the end-to-end path only. Descriptor validation and
//! every refusal code are covered by the inline unit tests in
//! `providers/installed/loader.rs`, which exercise the same pure `load_from_dir`
//! without a subprocess.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use cadencr_service::domain::agents::adapter::{
    AgentRuntimeAdapter, AgentRuntimeSession, RuntimeSessionConfigKind, RuntimeSessionConfigValue,
    RuntimeSpawnConfig,
};
use cadencr_service::domain::agents::providers::installed;
use cadencr_service::domain::agents::providers::installed::rejection::{
    QuarantineCode, RejectionCode,
};
use cadencr_service::domain::agents::providers::installed::routes::{
    InstalledProviderMutationResponse, InstalledProvidersResponse,
};
use cadencr_service::domain::agents::providers::provider_registry;
use cadencr_service::domain::agents::runtime::ProviderStatus;
use cadencr_service::domain::ws_session::protocol::{
    CommandsUpdatedPayload, PermissionDecision, PermissionRequestPayload, PermissionRespondPayload,
    PromptSendPayload, SessionActionPayload, SessionConfigSetPayload, SessionConfigSnapshotPayload,
    SessionEndedPayload, SessionInitPayload, SessionInitializedPayload, SessionMessagePayload,
    SessionUsageUpdatePayload, WsEnvelope, WsSessionAction,
};
use common::{start_migrated_test_server, TEST_AUTH_TOKEN};
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const PROVIDER_ID: &str = "fake-acp-agent";
const CONFIG_PROVIDER_ID: &str = "fake-config-acp-agent";
const RICH_PROVIDER_ID: &str = "fake-rich-acp-agent";
const DURABLE_PROVIDER_ID: &str = "fake-durable-acp-agent";
const QUARANTINED_PROVIDER_ID: &str = "quarantined-acp-agent";
const EVENT_TIMEOUT: Duration = Duration::from_secs(10);

type TestWebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn fixture_agent() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake_acp_agent.py")
        .canonicalize()
        .expect("fake ACP agent fixture should exist")
}

fn descriptor(id: &str, command: &Path) -> Value {
    json!({
        "schema_version": 1,
        "agent": {
            "id": id,
            "name": "Fake ACP Agent",
            "version": "1.0.0",
            "description": "Deterministic ACP v1 agent used in tests",
            "repository": "https://example.invalid/fake-acp-agent",
            "license": "MIT",
        },
        "installation": {
            "executable": { "command": command.to_string_lossy() },
        },
    })
}

fn write_descriptor(dir: &Path, name: &str, value: &Value) {
    std::fs::write(
        dir.join(name),
        serde_json::to_string_pretty(value).expect("descriptor should serialize"),
    )
    .expect("descriptor should be writable");
}

fn event_deadline() -> Instant {
    Instant::now() + EVENT_TIMEOUT
}

async fn send_session_payload(
    socket: &mut TestWebSocket,
    action: &str,
    payload: impl Serialize,
) -> String {
    let envelope = WsEnvelope::new(
        "session",
        action,
        serde_json::to_value(payload).expect("session payload should serialize"),
    );
    let id = envelope.id.clone();
    socket
        .send(Message::Text(String::from(envelope).into()))
        .await
        .expect("WebSocket message should send");
    id
}

async fn next_ws_envelope(socket: &mut TestWebSocket, deadline: Instant) -> WsEnvelope {
    loop {
        let message = tokio::time::timeout_at(deadline, socket.next())
            .await
            .expect("timed out waiting for a WebSocket envelope")
            .expect("WebSocket closed before the expected envelope")
            .expect("WebSocket read should succeed");
        match message {
            Message::Text(text) => {
                return WsEnvelope::try_from(text.to_string())
                    .expect("server text should be a valid WsEnvelope")
            }
            Message::Ping(payload) => socket
                .send(Message::Pong(payload))
                .await
                .expect("pong should send"),
            Message::Close(frame) => panic!("WebSocket closed unexpectedly: {frame:?}"),
            Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

async fn next_session_action(socket: &mut TestWebSocket, action: WsSessionAction) -> WsEnvelope {
    let deadline = event_deadline();
    loop {
        let envelope = next_ws_envelope(socket, deadline).await;
        if envelope.domain != "session" {
            continue;
        }
        assert_ne!(
            envelope.action, "error",
            "unexpected WebSocket session error: {}",
            envelope.payload
        );
        if envelope.action == action.as_str() {
            return envelope;
        }
        assert_ne!(
            envelope.action,
            WsSessionAction::Ended.as_str(),
            "session ended before the expected {} action",
            action.as_str()
        );
    }
}

fn message_text(payload: &SessionMessagePayload) -> String {
    payload
        .blocks
        .iter()
        .filter(|block| {
            block.pointer("/event/type").and_then(Value::as_str) == Some("content_block_delta")
                && block.pointer("/event/delta/type").and_then(Value::as_str) == Some("text_delta")
        })
        .filter_map(|block| block.pointer("/event/delta/text").and_then(Value::as_str))
        .collect()
}

async fn collect_ws_turn(socket: &mut TestWebSocket) -> (String, SessionEndedPayload) {
    let deadline = event_deadline();
    let mut text = String::new();
    let mut previous_seq = 0;
    loop {
        let envelope = next_ws_envelope(socket, deadline).await;
        if envelope.domain != "session" {
            continue;
        }
        match envelope.action.as_str() {
            "message" => {
                let payload: SessionMessagePayload = serde_json::from_value(envelope.payload)
                    .expect("session.message payload should match its DTO");
                let seq = payload.seq.expect("streamed messages carry a sequence");
                assert!(seq > previous_seq, "message sequence must increase");
                previous_seq = seq;
                text.push_str(&message_text(&payload));
            }
            "ended" => {
                let payload = serde_json::from_value(envelope.payload)
                    .expect("session.ended payload should match its DTO");
                return (text, payload);
            }
            "error" => panic!("unexpected WebSocket session error: {}", envelope.payload),
            _ => {}
        }
    }
}

async fn collect_runtime_turn(session: &mut dyn AgentRuntimeSession) -> String {
    let mut receiver = session.take_message_rx();
    tokio::time::timeout(EVENT_TIMEOUT, async {
        let mut events = String::new();
        while let Some(event) = receiver.recv().await {
            let event = event.expect("durable ACP runtime event");
            events.push_str(&event.raw_json().to_string());
            if event.is_result() {
                return events;
            }
        }
        panic!("durable ACP runtime closed before its result");
    })
    .await
    .expect("durable ACP runtime turn timed out")
}

async fn next_ws_text(socket: &mut TestWebSocket) -> String {
    let deadline = event_deadline();
    loop {
        let envelope = next_ws_envelope(socket, deadline).await;
        if envelope.domain != "session" {
            continue;
        }
        match envelope.action.as_str() {
            "message" => {
                let payload: SessionMessagePayload = serde_json::from_value(envelope.payload)
                    .expect("session.message payload should match its DTO");
                let text = message_text(&payload);
                if !text.is_empty() {
                    return text;
                }
            }
            "ended" => panic!("session ended before streaming text: {}", envelope.payload),
            "error" => panic!("unexpected WebSocket session error: {}", envelope.payload),
            _ => {}
        }
    }
}

async fn collect_rich_until_permission(
    socket: &mut TestWebSocket,
) -> (
    Vec<Value>,
    CommandsUpdatedPayload,
    SessionUsageUpdatePayload,
    PermissionRequestPayload,
) {
    let deadline = event_deadline();
    let mut blocks = Vec::new();
    let mut commands = None;
    let mut usage = None;
    loop {
        let envelope = next_ws_envelope(socket, deadline).await;
        if envelope.domain == "commands" && envelope.action == "updated" {
            commands =
                Some(serde_json::from_value(envelope.payload).expect("commands.updated payload"));
            continue;
        }
        if envelope.domain != "session" {
            continue;
        }
        match envelope.action.as_str() {
            "message" => {
                let payload: SessionMessagePayload =
                    serde_json::from_value(envelope.payload).expect("rich session.message");
                blocks.extend(payload.blocks);
            }
            "usage_update" => {
                usage = Some(
                    serde_json::from_value(envelope.payload).expect("rich usage_update payload"),
                );
            }
            "permission.request" => {
                let permission = serde_json::from_value(envelope.payload)
                    .expect("rich permission.request payload");
                return (
                    blocks,
                    commands.expect("commands.updated must precede permission"),
                    usage.expect("usage_update must precede permission"),
                    permission,
                );
            }
            "error" => panic!("unexpected rich session error: {}", envelope.payload),
            "ended" => panic!("rich session ended before its permission request"),
            _ => {}
        }
    }
}

async fn collect_rich_after_permission(socket: &mut TestWebSocket) -> Vec<Value> {
    let deadline = event_deadline();
    let mut blocks = Vec::new();
    loop {
        let envelope = next_ws_envelope(socket, deadline).await;
        if envelope.domain != "session" {
            continue;
        }
        match envelope.action.as_str() {
            "message" => {
                let payload: SessionMessagePayload =
                    serde_json::from_value(envelope.payload).expect("rich session.message");
                blocks.extend(payload.blocks);
            }
            "ended" => {
                let ended: SessionEndedPayload =
                    serde_json::from_value(envelope.payload).expect("rich session.ended payload");
                assert_eq!(ended.reason, "turn_complete");
                return blocks;
            }
            "error" => panic!("unexpected rich session error: {}", envelope.payload),
            _ => {}
        }
    }
}

fn prompt_payload(session_id: &str, text: &str) -> PromptSendPayload {
    PromptSendPayload {
        session_id: session_id.to_string(),
        text: text.to_string(),
        profile: None,
        claude_profile: None,
        images: Vec::new(),
        attachments: Vec::new(),
        use_worktree: Some(false),
        new_project_branch: None,
        message_uuid: None,
        track_prompt_receipt: false,
    }
}

/// The headline case: drop a descriptor next to the settings, and the agent is
/// selectable, can create a session, streams a prompt, and cancels.
#[tokio::test]
async fn a_local_acp_executable_is_selectable_and_drives_a_full_turn() {
    let home = tempfile::tempdir().expect("settings dir");
    let providers = home.path().join("providers");
    std::fs::create_dir_all(&providers).expect("providers dir");
    let agent = fixture_agent();
    std::fs::write(
        home.path().join("icon.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    )
    .expect("provider icon");
    let mut primary_descriptor = descriptor(PROVIDER_ID, &agent);
    primary_descriptor["agent"]["icon"] = json!("icon.svg");
    primary_descriptor["installation"]["assets"] =
        json!({ "directory": home.path().to_string_lossy() });
    write_descriptor(&providers, "fake-acp-agent.json", &primary_descriptor);
    let mut config_descriptor = descriptor(CONFIG_PROVIDER_ID, &agent);
    config_descriptor["installation"]["executable"]["args"] = json!(["--session-config"]);
    write_descriptor(&providers, "fake-config-acp-agent.json", &config_descriptor);
    let mut rich_descriptor = descriptor(RICH_PROVIDER_ID, &agent);
    rich_descriptor["installation"]["executable"]["args"] = json!(["--rich"]);
    write_descriptor(&providers, "fake-rich-acp-agent.json", &rich_descriptor);
    let durable_state = home.path().join("durable-session.json");
    let mut durable_descriptor = descriptor(DURABLE_PROVIDER_ID, &agent);
    durable_descriptor["installation"]["executable"]["args"] =
        json!(["--durable", durable_state.to_string_lossy()]);
    write_descriptor(
        &providers,
        "fake-durable-acp-agent.json",
        &durable_descriptor,
    );
    // A second descriptor claiming a built-in id must lose to the built-in.
    write_descriptor(&providers, "cursor.json", &descriptor("cursor", &agent));
    // Disabled entries reserve names too, and aliases are part of the built-in
    // namespace: this must not be able to hijack `claude` on a later enable.
    let mut alias_collision = descriptor("claude", &agent);
    alias_collision["installation"]["enabled"] = json!(false);
    write_descriptor(&providers, "claude.json", &alias_collision);
    write_descriptor(
        &providers,
        "quarantined-acp-agent.json",
        &descriptor(
            QUARANTINED_PROVIDER_ID,
            &home.path().join("missing-acp-binary"),
        ),
    );
    cadencr_service::domain::settings_store::init(home.path().to_path_buf());

    // --- catalog -----------------------------------------------------------
    let registry = provider_registry();
    let ids = registry.provider_ids();
    assert_eq!(
        ids,
        vec![
            "claude_code",
            "codex_cli",
            "cursor",
            "opencode",
            PROVIDER_ID,
            CONFIG_PROVIDER_ID,
            DURABLE_PROVIDER_ID,
            RICH_PROVIDER_ID,
            QUARANTINED_PROVIDER_ID,
        ],
        "built-ins keep their order and the install is appended"
    );
    let adapter = registry
        .adapter(PROVIDER_ID)
        .expect("the installed provider should resolve");
    let cold_entry = adapter.catalog_entry();
    assert_eq!(cold_entry.label, "Fake ACP Agent");
    assert!(cold_entry
        .icon_data
        .as_deref()
        .is_some_and(|icon| icon.starts_with("data:image/svg+xml;base64,")));
    assert_eq!(cold_entry.status, ProviderStatus::Unavailable);
    let entry = adapter.catalog_entry_live_for_cwd(Some(home.path())).await;
    assert_eq!(entry.status, ProviderStatus::Available);
    assert_eq!(
        entry
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["fake-small", "fake-large"]
    );
    assert_eq!(entry.default_model.as_deref(), Some("fake-small"));
    assert!(entry.modes.is_empty());

    // A connector that advertises ACP `session/load` keeps provider-owned
    // context when Cadencr replaces the subprocess. This is the same spawn
    // path used after a desktop/service restart, without keeping the first
    // runtime alive as an accidental source of continuity.
    let durable_adapter = registry
        .adapter(DURABLE_PROVIDER_ID)
        .expect("durable installed provider should resolve");
    let runtime_config = RuntimeSpawnConfig {
        cwd: home.path().to_path_buf(),
        model: Some("fake-small".to_string()),
        ..RuntimeSpawnConfig::default()
    };
    let mut first_runtime = durable_adapter
        .spawn(
            json!("remember this across a subprocess restart"),
            runtime_config,
        )
        .await
        .expect("durable provider first spawn");
    collect_runtime_turn(first_runtime.as_mut()).await;
    let durable_session_id = first_runtime
        .session_id()
        .await
        .expect("durable provider session id");
    assert_eq!(
        durable_adapter
            .persistable_resume_session_id(Some(&durable_session_id))
            .as_deref(),
        Some(durable_session_id.as_str())
    );
    first_runtime.close().await;

    // Recreate the adapter too: after a service restart its process-local
    // capability cache is unknown until the replacement connector completes
    // `initialize`, while the DB-owned resume id is already available.
    let durable_installation = installed::startup_load()
        .installations
        .iter()
        .find(|installation| installation.provider_id() == DURABLE_PROVIDER_ID)
        .expect("durable installed provider installation")
        .clone();
    let restarted_adapter = installed::GenericAcpAdapter::new(durable_installation);
    let mut resumed_runtime = restarted_adapter
        .spawn(
            json!("recall the value from the previous subprocess"),
            RuntimeSpawnConfig {
                cwd: home.path().to_path_buf(),
                model: Some("fake-small".to_string()),
                resume_session_id: Some(durable_session_id.clone()),
                ..RuntimeSpawnConfig::default()
            },
        )
        .await
        .expect("durable provider resumed spawn");
    let resumed_events = collect_runtime_turn(resumed_runtime.as_mut()).await;
    resumed_runtime.close().await;
    assert!(
        resumed_events.contains("durable-host-memory"),
        "resumed ACP runtime lost connector-owned context: {resumed_events}"
    );
    assert_eq!(
        restarted_adapter
            .resolve_resume_session_id(Some(&durable_session_id))
            .as_deref(),
        Some(durable_session_id.as_str())
    );
    assert_eq!(
        restarted_adapter
            .persistable_resume_session_id(Some(&durable_session_id))
            .as_deref(),
        Some(durable_session_id.as_str())
    );
    // The colliding descriptor was refused, and `cursor` still resolves to the
    // built-in adapter.
    let rejections = &installed::startup_load().rejections;
    assert_eq!(rejections.len(), 2, "{rejections:?}");
    for rejected_id in ["claude", "cursor"] {
        let rejection = rejections
            .iter()
            .find(|rejection| rejection.provider_id.as_deref() == Some(rejected_id))
            .unwrap_or_else(|| panic!("missing rejection for {rejected_id}"));
        assert_eq!(rejection.code.as_str(), "DUPLICATE_PROVIDER_ID");
    }
    assert_eq!(
        registry
            .adapter("cursor")
            .expect("cursor")
            .catalog_entry()
            .label,
        cadencr_service::domain::agents::cursor::CursorAdapter
            .catalog_entry()
            .label
    );

    // --- authenticated HTTP diagnostics -----------------------------------
    let server = start_migrated_test_server().await;
    let response = server
        .client
        .get(format!(
            "{}/api/agents/installed-providers",
            server.base_url
        ))
        .send()
        .await
        .expect("installed-provider diagnostics request");
    assert_eq!(response.status(), 200);
    let diagnostics: InstalledProvidersResponse =
        response.json().await.expect("diagnostics response DTO");
    let fake = diagnostics
        .installed
        .iter()
        .find(|entry| entry.id == PROVIDER_ID)
        .expect("fake provider diagnostics");
    assert!(fake.registered);
    assert!(fake.quarantine_code.is_none());
    assert!(fake.icon_issue.is_none());
    let catalog: Value = server
        .client
        .get(format!("{}/api/agent-catalog", server.base_url))
        .send()
        .await
        .expect("catalog request")
        .json()
        .await
        .expect("catalog JSON");
    assert!(catalog["providers"]
        .as_array()
        .expect("provider catalog")
        .iter()
        .filter(|entry| {
            entry["id"] == PROVIDER_ID
                || entry["id"] == RICH_PROVIDER_ID
                || entry["id"] == DURABLE_PROVIDER_ID
        })
        .all(|entry| entry["origin"] == "installed_local"));
    assert!(catalog["providers"]
        .as_array()
        .expect("provider catalog")
        .iter()
        .filter(|entry| entry["id"] == "claude_code" || entry["id"] == "codex_cli")
        .all(|entry| entry["origin"] == "built_in"));
    assert!(catalog["providers"]
        .as_array()
        .expect("provider catalog")
        .iter()
        .find(|entry| entry["id"] == PROVIDER_ID)
        .and_then(|entry| entry["icon_data"].as_str())
        .is_some_and(|icon| icon.starts_with("data:image/svg+xml;base64,")));
    let quarantined = diagnostics
        .installed
        .iter()
        .find(|entry| entry.id == QUARANTINED_PROVIDER_ID)
        .expect("quarantined provider diagnostics");
    assert!(quarantined.registered);
    assert_eq!(
        quarantined.quarantine_code.as_deref(),
        Some(QuarantineCode::ExecutableNotFound.as_str())
    );
    for rejected_id in ["claude", "cursor"] {
        let collision = diagnostics
            .rejected
            .iter()
            .find(|rejection| rejection.provider_id.as_deref() == Some(rejected_id))
            .unwrap_or_else(|| panic!("missing diagnostics rejection for {rejected_id}"));
        assert_eq!(collision.code, RejectionCode::DuplicateProviderId.as_str());
    }

    let rejected_enable = server
        .client
        .put(format!(
            "{}/api/agents/installed-providers/claude/enabled",
            server.base_url
        ))
        .json(&json!({ "enabled": true }))
        .send()
        .await
        .expect("enable rejected descriptor request");
    assert_eq!(rejected_enable.status(), 409);
    let error: Value = rejected_enable
        .json()
        .await
        .expect("enable rejection response");
    assert_eq!(error["code"], RejectionCode::DuplicateProviderId.as_str());
    let unchanged: Value = serde_json::from_str(
        &std::fs::read_to_string(providers.join("claude.json")).expect("read rejected descriptor"),
    )
    .expect("parse rejected descriptor");
    assert_eq!(unchanged["installation"]["enabled"], false);

    let unauthenticated = reqwest::Client::new()
        .get(format!(
            "{}/api/agents/installed-providers",
            server.base_url
        ))
        .send()
        .await
        .expect("unauthenticated diagnostics request");
    assert_eq!(unauthenticated.status(), 401);

    // --- real WebSocket session path --------------------------------------
    let ws_url = format!("{}/ws", server.base_url.replacen("http://", "ws://", 1));
    let mut request = ws_url
        .into_client_request()
        .expect("valid WebSocket request");
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&format!("cadencr-token.{TEST_AUTH_TOKEN}"))
            .expect("valid protocol header"),
    );
    let (mut socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("authenticated WebSocket should connect");
    assert_eq!(response.status(), 101);

    let init_id = send_session_payload(
        &mut socket,
        "init",
        SessionInitPayload {
            provider: Some(PROVIDER_ID.to_string()),
            model: Some("fake-small".to_string()),
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some(server.repo_path().to_string_lossy().into_owned()),
            feature_id: Some(1),
        },
    )
    .await;
    let initialized_envelope = next_session_action(&mut socket, WsSessionAction::Initialized).await;
    assert_eq!(
        initialized_envelope.r#ref.as_deref(),
        Some(init_id.as_str())
    );
    let initialized: SessionInitializedPayload =
        serde_json::from_value(initialized_envelope.payload)
            .expect("session.initialized payload should match its DTO");
    assert_eq!(initialized.provider.as_deref(), Some(PROVIDER_ID));
    let session_id = initialized.session_id;

    send_session_payload(
        &mut socket,
        "prompt.send",
        prompt_payload(&session_id, "say hello"),
    )
    .await;
    let (streamed_text, ended) = collect_ws_turn(&mut socket).await;
    assert_eq!(streamed_text, "Hello from the fake ACP agent.");
    assert_eq!(ended.reason, "turn_complete");
    let persisted: (String, Option<String>) = sqlx::query_as(
        "SELECT runtime_provider, runtime_session_id FROM agent_sessions WHERE id = ?",
    )
    .bind(session_id.parse::<i64>().expect("numeric session id"))
    .fetch_one(&server.pool)
    .await
    .expect("persisted session");
    assert_eq!(persisted.0, PROVIDER_ID);
    assert!(
        persisted.1.is_none(),
        "an agent that advertised loadSession=false must not leave an unusable resume id"
    );

    // Cancellation crosses the same public WebSocket boundary. Wait for the
    // first chunk so the interrupt cannot race session/prompt startup.
    send_session_payload(
        &mut socket,
        "prompt.send",
        prompt_payload(&session_id, "hang until cancelled"),
    )
    .await;
    assert_eq!(next_ws_text(&mut socket).await, "Hello ");
    send_session_payload(
        &mut socket,
        "interrupt",
        SessionActionPayload {
            session_id,
            message_uuid: None,
        },
    )
    .await;
    let (_, ended) = collect_ws_turn(&mut socket).await;
    assert_eq!(ended.reason, "turn_interrupted");

    // The optional ACP v1 configuration bridge is exercised through the same
    // authenticated public WebSocket, without a desktop consumer or a
    // provider-specific adapter.
    sqlx::query(
        "INSERT INTO features (id, project_id, title, type) \
         VALUES (2, 1, 'Configured ACP Feature', 'ws-session')",
    )
    .execute(&server.pool)
    .await
    .expect("configured ACP feature");
    sqlx::query(
        "INSERT INTO feature_settings (feature_id, key, value) \
         VALUES (2, 'worktree_path', ?)",
    )
    .bind(server.repo_path().to_string_lossy().as_ref())
    .execute(&server.pool)
    .await
    .expect("configured ACP worktree path");
    let init_id = send_session_payload(
        &mut socket,
        "init",
        SessionInitPayload {
            provider: Some(CONFIG_PROVIDER_ID.to_string()),
            model: Some("fake-small".to_string()),
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some(server.repo_path().to_string_lossy().into_owned()),
            feature_id: Some(2),
        },
    )
    .await;
    let initialized_envelope = next_session_action(&mut socket, WsSessionAction::Initialized).await;
    assert_eq!(
        initialized_envelope.r#ref.as_deref(),
        Some(init_id.as_str())
    );
    let initialized: SessionInitializedPayload =
        serde_json::from_value(initialized_envelope.payload)
            .expect("configured session.initialized payload should match its DTO");
    assert_eq!(initialized.provider.as_deref(), Some(CONFIG_PROVIDER_ID));
    let config_session_id = initialized.session_id;
    send_session_payload(
        &mut socket,
        "prompt.send",
        prompt_payload(&config_session_id, "start configured runtime"),
    )
    .await;
    let (streamed_text, ended) = collect_ws_turn(&mut socket).await;
    assert_eq!(streamed_text, "Hello from the fake ACP agent.");
    assert_eq!(ended.reason, "turn_complete");

    let get_id = send_session_payload(
        &mut socket,
        "config.get",
        SessionActionPayload {
            session_id: config_session_id.clone(),
            message_uuid: None,
        },
    )
    .await;
    let snapshot_envelope = next_session_action(&mut socket, WsSessionAction::ConfigSnapshot).await;
    assert_eq!(snapshot_envelope.r#ref.as_deref(), Some(get_id.as_str()));
    let snapshot: SessionConfigSnapshotPayload = serde_json::from_value(snapshot_envelope.payload)
        .expect("configuration snapshot should match its DTO");
    let safe_mode = snapshot
        .config
        .options
        .iter()
        .find(|option| option.id == "safe_mode")
        .expect("safe mode option");
    assert!(matches!(
        safe_mode.kind,
        RuntimeSessionConfigKind::Boolean {
            current_value: false
        }
    ));

    let set_id = send_session_payload(
        &mut socket,
        "config.set",
        SessionConfigSetPayload {
            session_id: config_session_id,
            config_id: "safe_mode".to_string(),
            value: RuntimeSessionConfigValue::Boolean(true),
        },
    )
    .await;
    let snapshot_envelope = next_session_action(&mut socket, WsSessionAction::ConfigSnapshot).await;
    assert_eq!(snapshot_envelope.r#ref.as_deref(), Some(set_id.as_str()));
    let snapshot: SessionConfigSnapshotPayload = serde_json::from_value(snapshot_envelope.payload)
        .expect("updated configuration snapshot should match its DTO");
    let safe_mode = snapshot
        .config
        .options
        .iter()
        .find(|option| option.id == "safe_mode")
        .expect("safe mode option");
    assert!(matches!(
        safe_mode.kind,
        RuntimeSessionConfigKind::Boolean {
            current_value: true
        }
    ));

    // A rich, still provider-neutral ACP v1 stream proves the generic adapter
    // keeps the standard details needed by the desktop: advertised commands,
    // plan/todo state, usage, permission options, shell output, diffs, and an
    // MCP-shaped tool name. No provider-id repair participates in this path.
    sqlx::query(
        "INSERT INTO features (id, project_id, title, type) \
         VALUES (3, 1, 'Rich ACP Feature', 'ws-session')",
    )
    .execute(&server.pool)
    .await
    .expect("rich ACP feature");
    sqlx::query(
        "INSERT INTO feature_settings (feature_id, key, value) \
         VALUES (3, 'worktree_path', ?)",
    )
    .bind(server.repo_path().to_string_lossy().as_ref())
    .execute(&server.pool)
    .await
    .expect("rich ACP worktree path");
    send_session_payload(
        &mut socket,
        "init",
        SessionInitPayload {
            provider: Some(RICH_PROVIDER_ID.to_string()),
            model: Some("fake-small".to_string()),
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some(server.repo_path().to_string_lossy().into_owned()),
            feature_id: Some(3),
        },
    )
    .await;
    let initialized = next_session_action(&mut socket, WsSessionAction::Initialized).await;
    let initialized: SessionInitializedPayload =
        serde_json::from_value(initialized.payload).expect("rich session.initialized payload");
    let rich_session_id = initialized.session_id;
    send_session_payload(
        &mut socket,
        "prompt.send",
        prompt_payload(&rich_session_id, "exercise the rich contract"),
    )
    .await;
    let (mut blocks, commands, usage, permission) =
        collect_rich_until_permission(&mut socket).await;
    assert_eq!(
        commands
            .commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>(),
        vec!["review", "summarize"]
    );
    assert_eq!(usage.input_tokens, 321);
    assert_eq!(usage.output_tokens, 0);
    assert_eq!(usage.context_window, Some(8192));
    assert_eq!(permission.request_id, "rich-permission-1");
    assert_eq!(permission.tool_name, "Bash");
    assert_eq!(permission.tool_input["command"], "printf rich-acp");
    assert_eq!(permission.options.len(), 3);
    send_session_payload(
        &mut socket,
        "permission.respond",
        PermissionRespondPayload {
            session_id: rich_session_id,
            request_id: permission.request_id,
            message_uuid: None,
            decision: PermissionDecision::AllowOnce,
            option_id: Some("allow-once".to_string()),
            feedback: None,
            updated_input: None,
        },
    )
    .await;
    blocks.extend(collect_rich_after_permission(&mut socket).await);
    let projected = serde_json::to_string(&blocks).expect("rich blocks serialize");
    for expected in [
        "sessionUpdate\":\"plan",
        "Inspect the workspace",
        "Bash",
        "rich-acp",
        "Edit",
        "fixture.txt",
        "before\\n",
        "after\\n",
        "mcp__fixture__lookup",
        "MCP result",
        "Rich ACP turn complete.",
    ] {
        assert!(
            projected.contains(expected),
            "{expected} missing from {projected}"
        );
    }
    socket.close(None).await.expect("WebSocket should close");

    // --- restart-gated descriptor lifecycle -------------------------------
    let lifecycle_id = "lifecycle-acp-agent";
    let lifecycle_url = format!("{}/api/agents/installed-providers", server.base_url);
    let malformed = server
        .client
        .post(&lifecycle_url)
        .header("content-type", "application/json")
        .body("{")
        .send()
        .await
        .expect("malformed descriptor request");
    assert_eq!(malformed.status(), 400);
    let error: Value = malformed
        .json()
        .await
        .expect("coded malformed JSON response");
    assert_eq!(error["code"], "DESCRIPTOR_INVALID_JSON");

    let wrong_shape = server
        .client
        .post(&lifecycle_url)
        .json(&json!({}))
        .send()
        .await
        .expect("schema-invalid descriptor request");
    assert_eq!(wrong_shape.status(), 400);
    let error: Value = wrong_shape
        .json()
        .await
        .expect("coded schema violation response");
    assert_eq!(error["code"], "DESCRIPTOR_SCHEMA_VIOLATION");

    let alias_collision = server
        .client
        .post(&lifecycle_url)
        .json(&descriptor("openai", &agent))
        .send()
        .await
        .expect("built-in alias collision request");
    assert_eq!(alias_collision.status(), 409);
    let error: Value = alias_collision
        .json()
        .await
        .expect("built-in alias collision response");
    assert_eq!(error["code"], "PROVIDER_ALREADY_INSTALLED");
    assert_eq!(
        cadencr_service::domain::agents::providers::canonical_provider_or_error("openai")
            .expect("built-in alias should resolve")
            .as_str(),
        "codex_cli"
    );

    let response = server
        .client
        .post(&lifecycle_url)
        .json(&descriptor(lifecycle_id, &agent))
        .send()
        .await
        .expect("descriptor install request");
    assert_eq!(response.status(), 200);
    let mutation: InstalledProviderMutationResponse =
        response.json().await.expect("install mutation response");
    assert_eq!(mutation.provider_id, lifecycle_id);
    assert!(!mutation.active_now);
    assert!(mutation.active_after_restart);
    assert!(mutation.restart_required);
    assert!(providers.join(format!("{lifecycle_id}.json")).exists());
    assert!(
        !provider_registry().contains(lifecycle_id),
        "the running registry must remain immutable"
    );
    let diagnostics: InstalledProvidersResponse = server
        .client
        .get(&lifecycle_url)
        .send()
        .await
        .expect("diagnostics after install")
        .json()
        .await
        .expect("installed-provider diagnostics");
    let durable = diagnostics
        .installed
        .iter()
        .find(|entry| entry.id == lifecycle_id)
        .expect("new descriptor should be immediately visible");
    assert!(durable.enabled);
    assert!(!durable.registered);

    let duplicate = server
        .client
        .post(&lifecycle_url)
        .json(&descriptor(lifecycle_id, &agent))
        .send()
        .await
        .expect("duplicate descriptor request");
    assert_eq!(duplicate.status(), 409);
    let error: Value = duplicate.json().await.expect("coded error response");
    assert_eq!(error["code"], "PROVIDER_ALREADY_INSTALLED");

    let disabled = server
        .client
        .put(format!("{lifecycle_url}/{lifecycle_id}/enabled"))
        .json(&json!({ "enabled": false }))
        .send()
        .await
        .expect("disable descriptor request");
    assert_eq!(disabled.status(), 200);
    let mutation: InstalledProviderMutationResponse =
        disabled.json().await.expect("disable mutation response");
    assert!(!mutation.active_now);
    assert!(!mutation.active_after_restart);
    assert!(!mutation.enabled_after_restart);
    assert!(!mutation.restart_required);

    let disabled_again = server
        .client
        .put(format!("{lifecycle_url}/{lifecycle_id}/enabled"))
        .json(&json!({ "enabled": false }))
        .send()
        .await
        .expect("repeat disable descriptor request");
    let mutation: InstalledProviderMutationResponse = disabled_again
        .json()
        .await
        .expect("repeat disable mutation response");
    assert!(!mutation.restart_required);

    let diagnostics: InstalledProvidersResponse = server
        .client
        .get(&lifecycle_url)
        .send()
        .await
        .expect("diagnostics after disable")
        .json()
        .await
        .expect("installed-provider diagnostics");
    let durable = diagnostics
        .installed
        .iter()
        .find(|entry| entry.id == lifecycle_id)
        .expect("disabled descriptor should stay visible");
    assert!(!durable.enabled);
    assert!(!durable.registered);

    // A no-op durable write does not erase an outstanding restart: this
    // provider is active in the immutable registry until the next boot.
    for _ in 0..2 {
        let response = server
            .client
            .put(format!("{lifecycle_url}/{PROVIDER_ID}/enabled"))
            .json(&json!({ "enabled": false }))
            .send()
            .await
            .expect("disable active descriptor request");
        let mutation: InstalledProviderMutationResponse = response
            .json()
            .await
            .expect("active disable mutation response");
        assert!(mutation.active_now);
        assert!(!mutation.active_after_restart);
        assert!(mutation.restart_required);
    }
}
