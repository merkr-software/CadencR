//! End-to-end proof of the optional host conventions an installed provider
//! declares (`docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md`,
//! `docs/PROVIDER_SPEC/INSTALLED_ACP_PROVIDERS.md`): modes and access modes
//! mapped through `_meta.cadencr` in the `models` output, the
//! `host-integration` command (compaction, worktree config, resume command),
//! prompt capabilities, and background sub-agents.
//!
//! The agent is `tests/fixtures/fake_acp_agent.py --host`. Own test binary:
//! `settings_store::init` is first-call-wins and `provider_registry()` scans
//! the providers directory once per process.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use cadencr_service::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeAccessMode, RuntimeEvent, RuntimePermissionMode,
    RuntimePromptAttachment, RuntimeSpawnConfig, RuntimeSubagentStatus, RuntimeTurnStartedSource,
};
use cadencr_service::domain::agents::providers::installed::routes::InstalledProvidersResponse;
use cadencr_service::domain::agents::providers::provider_registry;
use cadencr_service::domain::agents::runtime::ProviderStatus;
use cadencr_service::domain::ws_session::protocol::{
    PromptSendPayload, SessionInitPayload, SessionInitializedPayload, WsEnvelope,
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

const HOST_PROVIDER_ID: &str = "fake-host-acp-agent";
const INVALID_PROVIDER_ID: &str = "fake-invalid-host-acp-agent";
const PLAIN_PROVIDER_ID: &str = "fake-plain-acp-agent";
const EVENT_TIMEOUT: Duration = Duration::from_secs(10);

type TestWebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn fixture_agent() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake_acp_agent.py")
        .canonicalize()
        .expect("fake ACP agent fixture should exist")
}

fn write_descriptor(dir: &Path, id: &str, args: &[&str]) {
    let descriptor = json!({
        "schema_version": 1,
        "agent": {
            "id": id,
            "name": "Fake Host Agent",
            "version": "1.0.0",
            "description": "Deterministic ACP v1 agent used in tests",
        },
        "installation": {
            "executable": { "command": fixture_agent().to_string_lossy(), "args": args },
        },
    });
    std::fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_string_pretty(&descriptor).unwrap(),
    )
    .expect("descriptor should be writable");
}

fn spawn_config(cwd: &Path) -> RuntimeSpawnConfig {
    RuntimeSpawnConfig {
        cwd: cwd.to_path_buf(),
        model: Some("fake-small".to_string()),
        ..RuntimeSpawnConfig::default()
    }
}

/// Collect runtime events until (and including) the turn result.
async fn collect_turn(
    receiver: &mut tokio::sync::mpsc::Receiver<
        Result<RuntimeEvent, cadencr_service::domain::agents::adapter::RuntimeError>,
    >,
) -> Vec<RuntimeEvent> {
    tokio::time::timeout(EVENT_TIMEOUT, async {
        let mut events = Vec::new();
        while let Some(event) = receiver.recv().await {
            let event = event.expect("runtime event");
            let done = event.is_result();
            events.push(event);
            if done {
                return events;
            }
        }
        panic!("runtime closed before its result");
    })
    .await
    .expect("runtime turn timed out")
}

fn streamed_text(events: &[RuntimeEvent]) -> String {
    events
        .iter()
        .map(|event| event.raw_json().to_string())
        .collect()
}

async fn prompt(session: &dyn AgentRuntimeSession, text: &str) {
    session
        .stream_input(json!(text))
        .await
        .expect("prompt should be accepted");
}

async fn exercise_runtime_conventions(cwd: &Path) {
    let registry = provider_registry();
    let adapter = registry.adapter(HOST_PROVIDER_ID).expect("host provider");

    // --- catalog from `models` + `host-integration` --------------------------
    let entry = adapter.catalog_entry_live_for_cwd(Some(cwd)).await;
    assert_eq!(entry.status, ProviderStatus::Available);
    let modes: Vec<_> = entry.modes.iter().map(|mode| mode.id.as_str()).collect();
    assert_eq!(
        modes,
        ["default", "plan", "ask"],
        "unmapped values are hidden"
    );
    assert_eq!(entry.modes[1].label, "Plan");
    assert_eq!(entry.modes[1].description.as_deref(), Some("Plan mode"));
    let access: Vec<_> = entry
        .access_modes
        .iter()
        .map(|mode| mode.id.as_str())
        .collect();
    assert_eq!(access, ["default", "fullAccess"]);
    assert_eq!(adapter.default_permission_mode_wire(), "default");
    assert!(adapter.supports_permission_mode(&RuntimePermissionMode::Ask));
    assert!(!adapter.supports_permission_mode(&RuntimePermissionMode::AcceptEdits));
    assert!(adapter.compaction_strategy().is_some());
    assert_eq!(adapter.worktree_config_paths(), [".fake/rules"]);
    assert_eq!(
        adapter.access_mode_setting_key().as_deref(),
        Some("provider_access_mode.fake-host-acp-agent")
    );

    // --- worktree config is copied from the declaration ---------------------
    let source = tempfile::tempdir().unwrap();
    let worktree = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(source.path().join(".fake/rules")).unwrap();
    std::fs::write(source.path().join(".fake/rules/a.md"), "rule").unwrap();
    adapter
        .on_worktree_created(source.path(), worktree.path())
        .await
        .expect("worktree config copy");
    assert_eq!(
        std::fs::read_to_string(worktree.path().join(".fake/rules/a.md")).unwrap(),
        "rule"
    );

    // --- mode + access applied with set_config_option at spawn ---------------
    let mut config = spawn_config(cwd);
    config.permission_mode = Some(RuntimePermissionMode::Plan);
    config.access_mode = Some(RuntimeAccessMode::FullAccess);
    let mut session = adapter
        .spawn(json!("report state"), config)
        .await
        .expect("host provider spawn");
    let mut receiver = session.take_message_rx();
    let text = streamed_text(&collect_turn(&mut receiver).await);
    assert!(text.contains("mode=plan access=off"), "{text}");
    let capabilities = adapter
        .prompt_capabilities()
        .expect("observed during initialize");
    assert!(capabilities.embedded_context && !capabilities.image);

    // --- live changes go through the same option -----------------------------
    session
        .set_permission_mode(RuntimePermissionMode::Ask)
        .await
        .expect("mode change");
    session
        .set_access_mode(RuntimeAccessMode::Default)
        .await
        .expect("access change");
    prompt(session.as_ref(), "report state").await;
    let text = streamed_text(&collect_turn(&mut receiver).await);
    assert!(text.contains("mode=ask access=on"), "{text}");

    // --- an agent-initiated switch is reported in host terms ----------------
    prompt(session.as_ref(), "switch to plan").await;
    let events = collect_turn(&mut receiver).await;
    assert!(
        events
            .iter()
            .any(|event| event.permission_mode_changed() == Some(&RuntimePermissionMode::Plan)),
        "agent-initiated mode switch must surface"
    );

    // --- compaction sends `/<compactCommand>` and marks the turn -------------
    session.compact().await.expect("compact");
    let events = collect_turn(&mut receiver).await;
    assert!(events
        .iter()
        .any(|event| event.turn_started_source() == Some(RuntimeTurnStartedSource::ManualCompact)));
    assert!(streamed_text(&events).contains("compacted"));
    let boundary = tokio::time::timeout(EVENT_TIMEOUT, receiver.recv())
        .await
        .expect("compact boundary")
        .expect("runtime open")
        .expect("runtime event");
    assert!(boundary.is_compact_boundary());

    // --- documents ride as embedded resources --------------------------------
    let pdf = adapter.prompt_attachment_block(&RuntimePromptAttachment {
        base64: "JVBERi0xLjQ=",
        mime_type: "application/pdf",
        file_name: "spec.pdf",
        kind: Some("document"),
    });
    session
        .stream_input(json!([{ "type": "text", "text": "read this" }, pdf]))
        .await
        .expect("embedded resource accepted");
    let text = streamed_text(&collect_turn(&mut receiver).await);
    assert!(text.contains("resource=application/pdf"), "{text}");

    // --- background sub-agents outlive the turn ------------------------------
    prompt(session.as_ref(), "background").await;
    let events = collect_turn(&mut receiver).await;
    for id in ["bg-launch", "bg-late"] {
        let last = events
            .iter()
            .flat_map(|event| event.subagent_updates())
            .rfind(|update| update.tool_use_id == id && update.patch.status.is_some())
            .unwrap_or_else(|| panic!("{id} patches"));
        assert_eq!(
            last.patch.status,
            Some(RuntimeSubagentStatus::Running),
            "{id}"
        );
        assert_eq!(last.patch.background, Some(true), "{id}");
    }
    let finished = tokio::time::timeout(EVENT_TIMEOUT, async {
        loop {
            let event = receiver.recv().await.expect("open").expect("event");
            if event.is_subagent_signal_only() {
                return event;
            }
        }
    })
    .await
    .expect("background finish update");
    let update = &finished.subagent_updates()[0];
    assert_eq!(update.tool_use_id, "bg-launch");
    assert_eq!(update.patch.status, Some(RuntimeSubagentStatus::Completed));
    assert_eq!(
        update.patch.result_summary.as_deref(),
        Some("Mapped the repo")
    );
    session.close().await.unwrap();

    // --- an agent without embeddedContext refuses the document visibly ------
    let plain = registry.adapter(PLAIN_PROVIDER_ID).expect("plain provider");
    let mut plain_session = plain
        .spawn(Value::Null, spawn_config(cwd))
        .await
        .expect("plain spawn");
    let error = plain_session
        .stream_input(json!([pdf_block()]))
        .await
        .expect_err("a document must not be dropped silently");
    assert!(error.to_string().contains("does not accept"), "{error}");
    assert!(plain.compaction_strategy().is_none());
    assert!(plain.resume_command().is_none());
    plain_session.close().await.unwrap();
}

fn pdf_block() -> Value {
    json!({
        "type": "resource",
        "resource": { "uri": "file:///attachments/a.pdf", "mimeType": "application/pdf", "blob": "JVBERi0=" }
    })
}

async fn send(socket: &mut TestWebSocket, action: &str, payload: impl Serialize) -> String {
    let envelope = WsEnvelope::new("session", action, serde_json::to_value(payload).unwrap());
    let id = envelope.id.clone();
    socket
        .send(Message::Text(String::from(envelope).into()))
        .await
        .expect("WebSocket send");
    id
}

/// Run a "report state" turn and return its streamed text.
async fn report_state(socket: &mut TestWebSocket, session_id: &str) -> String {
    send(
        socket,
        "prompt.send",
        prompt_payload(session_id, "report state"),
    )
    .await;
    let mut text = String::new();
    loop {
        let envelope = next_action(socket, &["message", "ended"]).await;
        if envelope.action == "ended" {
            return text;
        }
        text.push_str(&envelope.payload.to_string());
    }
}

/// The agent process id a "report state" turn printed.
fn agent_pid(state: &str) -> &str {
    let start = state.find("pid=").expect("state reports a pid") + 4;
    let digits = state[start..]
        .find(|ch: char| !ch.is_ascii_digit())
        .unwrap_or(state.len() - start);
    &state[start..start + digits]
}

/// Next session envelope whose action is one of `actions`.
async fn next_action(socket: &mut TestWebSocket, actions: &[&str]) -> WsEnvelope {
    let deadline = Instant::now() + EVENT_TIMEOUT;
    loop {
        let message = tokio::time::timeout_at(deadline, socket.next())
            .await
            .expect("timed out waiting for an envelope")
            .expect("socket open")
            .expect("socket read");
        let Message::Text(text) = message else {
            continue;
        };
        let envelope = WsEnvelope::try_from(text.to_string()).expect("valid envelope");
        if envelope.domain != "session" {
            continue;
        }
        assert_ne!(envelope.action, "error", "{}", envelope.payload);
        if actions.contains(&envelope.action.as_str()) {
            return envelope;
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

async fn exercise_http_and_websocket() {
    let server = start_migrated_test_server().await;

    // --- catalog response fields ---------------------------------------------
    let catalog: Value = server
        .client
        .get(format!("{}/api/agent-catalog", server.base_url))
        .send()
        .await
        .expect("catalog request")
        .json()
        .await
        .expect("catalog JSON");
    let providers = catalog["providers"].as_array().expect("providers");
    let find = |id: &str| {
        providers
            .iter()
            .find(|entry| entry["id"] == id)
            .unwrap_or_else(|| panic!("{id} in catalog"))
            .clone()
    };
    let host = find(HOST_PROVIDER_ID);
    assert_eq!(host["compact_action"], true);
    assert_eq!(
        host["resume_command"],
        json!({ "program": "fake-agent", "args": ["--resume", "{session_id}"] })
    );
    assert_eq!(host["prompt_capabilities"]["embedded_context"], true);
    assert_eq!(host["modes"][0]["id"], "default");
    assert_eq!(host["access_modes"][1]["id"], "fullAccess");
    assert_eq!(find(PLAIN_PROVIDER_ID)["compact_action"], false);
    assert!(find(PLAIN_PROVIDER_ID).get("resume_command").is_none());
    for (id, program, args) in [
        ("claude_code", "claude", json!(["--resume", "{session_id}"])),
        ("opencode", "opencode", json!(["--session", "{session_id}"])),
        ("codex_cli", "codex", json!(["resume", "{session_id}"])),
    ] {
        // Read from the adapter: the live catalog lists only providers whose
        // CLI is installed on this machine.
        let adapter = provider_registry().adapter(id).expect("built-in adapter");
        let resume = adapter.resume_command().expect("resume command");
        assert_eq!(resume.program, program, "{id}");
        assert_eq!(json!(resume.args), args, "{id}");
        let compact_action = adapter.compaction_strategy().is_some();
        assert_eq!(compact_action, id != "claude_code", "{id}");
    }

    // --- host-integration diagnostics ----------------------------------------
    let diagnostics: InstalledProvidersResponse = server
        .client
        .get(format!(
            "{}/api/agents/installed-providers",
            server.base_url
        ))
        .send()
        .await
        .expect("diagnostics request")
        .json()
        .await
        .expect("diagnostics DTO");
    let issue = |id: &str| {
        diagnostics
            .installed
            .iter()
            .find(|entry| entry.id == id)
            .unwrap_or_else(|| panic!("{id} diagnostics"))
            .host_integration_issue
            .clone()
    };
    assert!(issue(HOST_PROVIDER_ID).is_none());
    assert!(issue(INVALID_PROVIDER_ID).is_some_and(|issue| issue.contains("rejected")));
    assert!(issue(PLAIN_PROVIDER_ID)
        .is_some_and(|issue| issue.contains("no `host-integration` command")));

    // --- the remembered workspace access default is a generic setting -------
    let setting_url = format!(
        "{}/api/workspace/settings/provider_access_mode.{HOST_PROVIDER_ID}",
        server.base_url
    );
    let saved = server
        .client
        .put(&setting_url)
        .json(&json!({ "value": "fullAccess" }))
        .send()
        .await
        .expect("setting write");
    assert_eq!(saved.status(), 200);
    let malformed = server
        .client
        .put(format!(
            "{}/api/workspace/settings/provider_access_mode.Not Valid",
            server.base_url
        ))
        .json(&json!({ "value": "fullAccess" }))
        .send()
        .await
        .expect("malformed key write");
    assert_eq!(malformed.status(), 400);

    // --- the WebSocket session follows the agent's own mode switch ----------
    let ws_url = format!("{}/ws", server.base_url.replacen("http://", "ws://", 1));
    let mut request = ws_url.into_client_request().unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&format!("cadencr-token.{TEST_AUTH_TOKEN}")).unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("WebSocket connects");
    send(
        &mut socket,
        "init",
        SessionInitPayload {
            provider: Some(HOST_PROVIDER_ID.to_string()),
            model: Some("fake-small".to_string()),
            thinking_effort: None,
            permission_mode: Some("plan".to_string()),
            system_prompt: None,
            cwd: Some(server.repo_path().to_string_lossy().into_owned()),
            feature_id: Some(1),
        },
    )
    .await;
    let initialized: SessionInitializedPayload =
        serde_json::from_value(next_action(&mut socket, &["initialized"]).await.payload)
            .expect("initialized payload");
    assert_eq!(initialized.permission_mode.as_deref(), Some("plan"));
    let session_id = initialized.session_id;
    let db_session_id: i64 = session_id.parse().unwrap();

    // The first prompt spawns with the remembered access default applied.
    let state_text = report_state(&mut socket, &session_id).await;
    assert!(state_text.contains("mode=plan access=off"), "{state_text}");

    send(
        &mut socket,
        "prompt.send",
        prompt_payload(&session_id, "switch to ask"),
    )
    .await;
    let changed = next_action(&mut socket, &["mode.changed"]).await;
    assert_eq!(changed.payload["mode"], "ask");
    next_action(&mut socket, &["ended"]).await;
    let stored: String =
        sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE id = ?")
            .bind(db_session_id)
            .fetch_one(&server.pool)
            .await
            .unwrap();
    assert_eq!(stored, "ask");

    // --- an access change applies in place: the next prompt keeps the agent -
    send(
        &mut socket,
        "access_mode.set",
        json!({ "session_id": session_id, "mode": "default" }),
    )
    .await;
    next_action(&mut socket, &["access_mode.changed"]).await;
    let switched = report_state(&mut socket, &session_id).await;
    assert!(switched.contains("mode=ask access=on"), "{switched}");
    assert_eq!(
        agent_pid(&switched),
        agent_pid(&state_text),
        "the host respawned the provider"
    );

    // --- background sub-agents survive the turn-end sweep -------------------
    send(
        &mut socket,
        "prompt.send",
        prompt_payload(&session_id, "background"),
    )
    .await;
    next_action(&mut socket, &["ended"]).await;
    let deadline = Instant::now() + EVENT_TIMEOUT;
    loop {
        let update = next_action(&mut socket, &["subagent_updated"]).await;
        if update.payload["toolUseId"] == "bg-launch" && update.payload["status"] == "completed" {
            break;
        }
        assert!(Instant::now() < deadline, "bg-launch never finished");
    }
    let late: (String, bool) = sqlx::query_as(
        "SELECT status, background FROM agent_subagent_runs \
         WHERE session_id = ? AND tool_use_id = 'bg-late'",
    )
    .bind(db_session_id)
    .fetch_one(&server.pool)
    .await
    .expect("bg-late run");
    assert_eq!(late, ("running".to_string(), true));
}

#[tokio::test]
async fn installed_providers_declare_host_conventions_as_data() {
    let home = tempfile::tempdir().expect("settings dir");
    let providers = home.path().join("providers");
    std::fs::create_dir_all(&providers).unwrap();
    write_descriptor(&providers, HOST_PROVIDER_ID, &["--host"]);
    write_descriptor(
        &providers,
        INVALID_PROVIDER_ID,
        &["--host-integration-invalid"],
    );
    write_descriptor(&providers, PLAIN_PROVIDER_ID, &[]);
    cadencr_service::domain::settings_store::init(home.path().to_path_buf());

    let workspace = tempfile::tempdir().unwrap();
    for id in [INVALID_PROVIDER_ID, PLAIN_PROVIDER_ID] {
        provider_registry()
            .adapter(id)
            .expect("installed provider")
            .catalog_entry_live_for_cwd(Some(workspace.path()))
            .await;
    }
    exercise_runtime_conventions(workspace.path()).await;
    exercise_http_and_websocket().await;
}
