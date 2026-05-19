use super::events_stream_blocks::EventIndexer;
use super::lifecycle::NegotiatedSession;
use super::permissions::PendingPermissions;
use super::provider_hooks::AcpProviderHooks;
use super::server_requests::{spawn_event_loop, EventLoopConfig};
use super::session::AcpRuntimeSession;
use super::session_permissions::SessionPermissions;
use super::terminal_registry::TerminalRegistry;
use super::test_support::{build_in_memory_client, read_request, send_response, write_json_frame};
use super::{spawn_acp_runtime_session, AcpRuntimeSpawnArgs};
use crate::domain::agents::acp::AcpClientInfo;
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimePermissionMode, RuntimeSpawnConfig,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};
use tempfile::TempDir;
use tokio::process::Command;
use tokio::sync::mpsc;

struct SpawnHooks;

#[async_trait]
impl AcpProviderHooks for SpawnHooks {
    fn normalize_tool_name(&self, raw: &str) -> String {
        raw.to_string()
    }
    fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
        input
    }
    fn mode_for_permission_mode(&self, mode: RuntimePermissionMode) -> Option<String> {
        Some(
            if matches!(mode, RuntimePermissionMode::Plan) {
                "plan"
            } else {
                "build"
            }
            .to_string(),
        )
    }
    fn model_config_id(&self) -> Option<&'static str> {
        Some("model")
    }
    fn thinking_effort_config_id(&self) -> Option<&'static str> {
        Some("effort")
    }
    fn default_mode_id(&self) -> Option<&'static str> {
        Some("build")
    }
}

#[tokio::test]
async fn spawn_runs_handshake_initial_config_and_prompt() {
    let temp = TempDir::new().unwrap();
    let log = temp.path().join("fake-acp.log");
    let script = temp.path().join("fake_acp.py");
    fs::write(&script, fake_agent_script(&log)).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

    let mut command = Command::new("python3");
    command.arg(&script).kill_on_drop(true);
    let config = RuntimeSpawnConfig {
        cwd: temp.path().to_path_buf(),
        permission_mode: Some(RuntimePermissionMode::Plan),
        model: Some("openai/gpt-5.4".to_string()),
        thinking_effort: Some("high".to_string()),
        ..RuntimeSpawnConfig::default()
    };
    let mut session = spawn_acp_runtime_session(AcpRuntimeSpawnArgs {
        command,
        spawn_guard: None,
        client_info: AcpClientInfo::default(),
        config,
        initial_content: Value::String("hello".to_string()),
        context_window: Some(1000),
        hooks: Arc::new(SpawnHooks),
    })
    .await
    .unwrap();

    let mut rx = session.take_message_rx();
    let init = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(init.init().is_some());
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while let Some(event) = rx.recv().await {
            let event = event.unwrap();
            if event.is_result() {
                return true;
            }
        }
        false
    })
    .await
    .unwrap();
    assert!(result, "initial prompt should complete");
    session.close().await;

    let log = fs::read_to_string(log).unwrap();
    assert!(log.contains("initialize"));
    assert!(log.contains("session/new"));
    assert!(log.contains("session/set_mode:plan"));
    assert!(log.contains("session/set_config_option:model=openai/gpt-5.4"));
    assert!(log.contains("session/set_config_option:effort=high"));
    assert!(log.contains("session/prompt"));
}

#[tokio::test]
async fn stream_input_steers_immediately_and_cancel_is_non_error() {
    let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
    let negotiated = NegotiatedSession {
        session_id: "s-steer".to_string(),
        model: None,
        mcp_servers: Vec::new(),
        context_window: None,
        current_mode: Some("build".to_string()),
    };
    let (tx, rx) = mpsc::channel(8);
    let mut session = AcpRuntimeSession::assemble(
        &client,
        &negotiated,
        None,
        rx,
        tx,
        Arc::new(SpawnHooks),
        Arc::new(StdMutex::new(EventIndexer::default())),
    );
    let mut runtime_rx = session.take_message_rx();
    let prompt_turn_lock = Arc::clone(&session.prompt_turn_lock);
    let _active_turn = prompt_turn_lock.lock().await;
    let session = Arc::new(session);

    let steer = tokio::spawn({
        let session = Arc::clone(&session);
        async move { session.stream_input(json!("steer then stop")).await }
    });
    let prompt = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        read_request(&mut agent_stdin),
    )
    .await
    .expect("steering prompt should not wait behind the full-turn lock");
    assert_eq!(prompt["method"], "session/prompt");

    session.interrupt().await.unwrap();
    let cancel = read_request(&mut agent_stdin).await;
    assert_eq!(cancel["method"], "session/cancel");
    tokio::time::timeout(std::time::Duration::from_millis(500), steer)
        .await
        .expect("cancel should unblock steering prompt")
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), runtime_rx.recv())
            .await
            .is_err(),
        "cancelled steering prompt must not emit an error or turn result"
    );
}

#[tokio::test]
async fn prompt_receipt_waits_for_user_message_echo() {
    let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
    let negotiated = NegotiatedSession {
        session_id: "s-receipt".to_string(),
        model: None,
        mcp_servers: Vec::new(),
        context_window: None,
        current_mode: Some("build".to_string()),
    };
    let (tx, rx) = mpsc::channel(8);
    let mut session = AcpRuntimeSession::assemble(
        &client,
        &negotiated,
        None,
        rx,
        tx.clone(),
        Arc::new(SpawnHooks),
        Arc::new(StdMutex::new(EventIndexer::default())),
    );
    let event_rx = client.subscribe();
    let _event_loop = spawn_event_loop(
        client.clone(),
        event_rx,
        tx,
        EventLoopConfig {
            session_id: Arc::clone(&session.session_id),
            current_model: Arc::clone(&session.current_model),
            current_effort: Arc::clone(&session.current_effort),
            current_mode: Arc::clone(&session.current_mode),
            cwd: PathBuf::from("/tmp"),
            closing: Arc::new(AtomicBool::new(false)),
            pending_permissions: PendingPermissions::default(),
            session_permissions: SessionPermissions::new(),
            terminals: Arc::new(TerminalRegistry::default()),
            hooks: Arc::new(SpawnHooks),
            replay_suppression: Arc::clone(&session.replay_suppression),
            pending_prompt_receipts: Arc::clone(&session.pending_prompt_receipts),
            indexer: Arc::clone(&session.indexer),
        },
    );
    let mut runtime_rx = session.take_message_rx();
    let prompt_turn_lock = Arc::clone(&session.prompt_turn_lock);
    let _active_turn = prompt_turn_lock.lock().await;
    let session = Arc::new(session);

    let steer = tokio::spawn({
        let session = Arc::clone(&session);
        async move {
            session
                .stream_input_with_client_message_id(
                    json!("steer once a tool is safe"),
                    Some("client-1".to_string()),
                )
                .await
        }
    });
    let prompt = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        read_request(&mut agent_stdin),
    )
    .await
    .expect("steering prompt should be sent immediately");
    assert_eq!(prompt["params"]["messageId"], "client-1");

    write_json_frame(
        &mut agent_stdout,
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s-receipt",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "steer once a tool is safe" }
                }
            }
        }),
    )
    .await;
    let received = tokio::time::timeout(std::time::Duration::from_millis(500), runtime_rx.recv())
        .await
        .expect("timed out waiting for prompt receipt")
        .expect("runtime event")
        .expect("ok");
    assert_eq!(
        received.prompt_received_client_message_id(),
        Some("client-1")
    );

    session.interrupt().await.unwrap();
    let cancel = read_request(&mut agent_stdin).await;
    assert_eq!(cancel["method"], "session/cancel");
    tokio::time::timeout(std::time::Duration::from_millis(500), steer)
        .await
        .expect("cancel should unblock steering prompt")
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn prompt_receipt_falls_back_to_prompt_response_without_user_echo() {
    let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
    let negotiated = NegotiatedSession {
        session_id: "s-receipt-response".to_string(),
        model: None,
        mcp_servers: Vec::new(),
        context_window: None,
        current_mode: Some("build".to_string()),
    };
    let (tx, rx) = mpsc::channel(8);
    let mut session = AcpRuntimeSession::assemble(
        &client,
        &negotiated,
        None,
        rx,
        tx,
        Arc::new(SpawnHooks),
        Arc::new(StdMutex::new(EventIndexer::default())),
    );
    let mut runtime_rx = session.take_message_rx();
    let prompt_turn_lock = Arc::clone(&session.prompt_turn_lock);
    let _active_turn = prompt_turn_lock.lock().await;
    let session = Arc::new(session);

    let steer = tokio::spawn({
        let session = Arc::clone(&session);
        async move {
            session
                .stream_input_with_client_message_id(
                    json!("steer without echo"),
                    Some("client-1".to_string()),
                )
                .await
        }
    });
    let prompt = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        read_request(&mut agent_stdin),
    )
    .await
    .expect("steering prompt should be sent immediately");
    assert_eq!(prompt["method"], "session/prompt");
    assert_eq!(prompt["params"]["messageId"], "client-1");
    send_response(
        &mut agent_stdout,
        prompt["id"].clone(),
        json!({ "stopReason": "end_turn" }),
    )
    .await;
    tokio::time::timeout(std::time::Duration::from_millis(500), steer)
        .await
        .expect("prompt response should complete steering prompt")
        .unwrap()
        .unwrap();

    let event = tokio::time::timeout(std::time::Duration::from_millis(500), runtime_rx.recv())
        .await
        .expect("timed out waiting for fallback receipt")
        .expect("runtime event")
        .expect("ok");
    assert_eq!(event.prompt_received_client_message_id(), Some("client-1"));
}

fn fake_agent_script(log: &std::path::Path) -> String {
    format!(
        r#"import json, sys
log_path = {log_path}
def log(item):
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(item + "\n")
def send(value):
    print(json.dumps(value), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    method = req.get("method")
    params = req.get("params") or {{}}
    log(method)
    if method == "initialize":
        send({{"jsonrpc":"2.0","id":req["id"],"result":{{"protocolVersion":1,"agentCapabilities":{{"loadSession":False}}}}}})
    elif method == "session/new":
        send({{"jsonrpc":"2.0","id":req["id"],"result":{{"sessionId":"ses_fake","modes":{{"currentModeId":"build"}}}}}})
    elif method == "session/set_mode":
        log(method + ":" + str(params.get("modeId")))
        send({{"jsonrpc":"2.0","id":req["id"],"result":{{}}}})
    elif method == "session/set_config_option":
        log(method + ":" + str(params.get("configId")) + "=" + str(params.get("value")))
        send({{"jsonrpc":"2.0","id":req["id"],"result":{{}}}})
    elif method == "session/prompt":
        send({{"jsonrpc":"2.0","id":req["id"],"result":{{"stopReason":"end_turn"}}}})
"#,
        log_path = serde_json::to_string(&log.to_string_lossy()).unwrap()
    )
}
