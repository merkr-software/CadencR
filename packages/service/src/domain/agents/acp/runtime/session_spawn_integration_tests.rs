use super::events_stream_blocks::EventIndexer;
use super::lifecycle::NegotiatedSession;
use super::permissions::PendingPermissions;
use super::provider_hooks::AcpProviderHooks;
use super::server_requests::{spawn_event_loop, EventLoopConfig};
use super::session::AcpRuntimeSession;
use super::session_permissions::SessionPermissions;
use super::terminal_registry::TerminalRegistry;
use super::test_support::{
    build_in_memory_client, read_request, send_response, spawn_event_barrier_acker,
    write_json_frame,
};
use super::{spawn_acp_runtime_session, AcpRuntimeSpawnArgs};
use crate::domain::agents::acp::{AcpClientInfo, AcpProcessTreePolicy, AcpStderrPolicy};
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
    fn model_config_id(&self) -> Option<&str> {
        Some("model")
    }
    fn thinking_effort_config_id(&self) -> Option<String> {
        Some("effort".to_string())
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
        child_session: None,
        spawn_guard: None,
        client_info: AcpClientInfo::default(),
        stderr_policy: AcpStderrPolicy::Log,
        process_tree_policy: AcpProcessTreePolicy::Inherit,
        config,
        initial_content: Value::String("hello".to_string()),
        context_window: Some(1000),
        hooks: Arc::new(SpawnHooks),
        wire_transform: None,
    })
    .await
    .unwrap();

    let mut rx = session.take_message_rx();
    assert_eq!(session.negotiated_prompt_steering(), None);
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
    session.close().await.unwrap();

    let log = fs::read_to_string(log).unwrap();
    assert!(log.contains("initialize"));
    assert!(log.contains("session/new"));
    assert!(log.contains("session/set_mode:plan"));
    assert!(log.contains("session/set_config_option:model=openai/gpt-5.4"));
    assert!(log.contains("session/set_config_option:effort=high"));
    assert!(log.contains("session/prompt"));
}

#[tokio::test]
async fn close_during_initial_prompt_closes_stream_with_runtime_retained() {
    let temp = TempDir::new().unwrap();
    let log = temp.path().join("hanging-acp.log");
    let script = temp.path().join("hanging_acp.py");
    fs::write(&script, hanging_prompt_agent_script(&log)).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

    let mut command = Command::new("python3");
    command.arg(&script).kill_on_drop(true);
    let mut session = spawn_acp_runtime_session(AcpRuntimeSpawnArgs {
        command,
        child_session: None,
        spawn_guard: None,
        client_info: AcpClientInfo::default(),
        stderr_policy: AcpStderrPolicy::Log,
        process_tree_policy: AcpProcessTreePolicy::Inherit,
        config: RuntimeSpawnConfig {
            cwd: temp.path().to_path_buf(),
            ..RuntimeSpawnConfig::default()
        },
        initial_content: Value::String("remain in flight".to_string()),
        context_window: None,
        hooks: Arc::new(SpawnHooks),
        wire_transform: None,
    })
    .await
    .unwrap();

    let mut runtime_rx = session.take_message_rx();
    let init = tokio::time::timeout(std::time::Duration::from_secs(2), runtime_rx.recv())
        .await
        .expect("initialization event timed out")
        .expect("runtime stream closed before initialization")
        .expect("initialization failed");
    assert!(init.init().is_some());
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if fs::read_to_string(&log)
                .is_ok_and(|contents| contents.lines().any(|line| line == "session/prompt"))
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("initial prompt did not start");

    // The agent never answers `session/close`: close gives it 1 s, then the
    // client waits up to 2 s for each of its three tasks. Under load that
    // passes the 2 s stream-reader deadline, which production tolerates (it
    // retries the close); that the 1 s stays below it is checked at compile
    // time in `session/close.rs`. Waiting on the silent agent would never end.
    tokio::time::timeout(std::time::Duration::from_secs(10), session.close())
        .await
        .expect("runtime close waited on the silent agent")
        .unwrap();
    // The runtime dropped its sender: only buffered events remain to drain.
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while runtime_rx.recv().await.is_some() {}
    })
    .await
    .expect("runtime stream remained pending after close");

    assert_eq!(
        session.session_id().await.as_deref(),
        Some("ses_hanging"),
        "closed runtime should remain available for resume metadata"
    );
    let log = fs::read_to_string(log).unwrap();
    assert!(log.lines().any(|line| line == "session/close"));
    // The fallback cancel is verified by the in-memory close test. This peer
    // may be killed before it reads that notification; EOF is the contract here.
}

#[tokio::test]
async fn stream_input_waits_for_active_turn_and_cancel_emits_terminal_result() {
    let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
    spawn_event_barrier_acker(&client);
    let negotiated = NegotiatedSession {
        session_id: "s-steer".to_string(),
        model: None,
        mcp_servers: Vec::new(),
        context_window: None,
        current_mode: Some("build".to_string()),
        session_config: Default::default(),
        supports_session_close: false,
        supports_prompt_steering: false,
        may_replay_history: false,
    };
    let (tx, rx) = mpsc::channel(8);
    let mut session = AcpRuntimeSession::assemble()
        .client(&client)
        .negotiated(&negotiated)
        .cwd(std::env::temp_dir())
        .rx(rx)
        .local_tx(tx)
        .hooks(Arc::new(SpawnHooks))
        .indexer(Arc::new(StdMutex::new(EventIndexer::default())))
        .call();
    let mut runtime_rx = session.take_message_rx();
    let prompt_turn_lock = Arc::clone(&session.prompt_turn_lock);
    let active_turn = prompt_turn_lock.lock().await;
    let session = Arc::new(session);

    let steer = tokio::spawn({
        let session = Arc::clone(&session);
        async move { session.stream_input(json!("steer then stop")).await }
    });
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            read_request(&mut agent_stdin),
        )
        .await
        .is_err(),
        "ACP v1 follow-up must wait for the active prompt turn"
    );
    drop(active_turn);
    let prompt = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        read_request(&mut agent_stdin),
    )
    .await
    .expect("queued prompt should start after the active turn ends");
    assert_eq!(prompt["method"], "session/prompt");

    session.interrupt().await.unwrap();
    let cancel = read_request(&mut agent_stdin).await;
    assert_eq!(cancel["method"], "session/cancel");
    send_response(
        &mut agent_stdout,
        prompt["id"].clone(),
        json!({"stopReason": "cancelled"}),
    )
    .await;
    tokio::time::timeout(std::time::Duration::from_millis(500), steer)
        .await
        .expect("cancel should unblock steering prompt")
        .unwrap()
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_millis(500), runtime_rx.recv())
        .await
        .expect("cancelled prompt should emit a terminal result")
        .expect("runtime event")
        .expect("ok");
    assert!(result.is_result());
    assert_eq!(result.raw_json()["stop_reason"], "cancelled");
}

#[tokio::test]
async fn negotiated_steering_submits_before_the_earlier_response_and_finishes_once() {
    use std::time::Duration;
    use tokio::sync::Mutex;

    let (client, mut stdout, mut stdin) = build_in_memory_client().await;
    spawn_event_barrier_acker(&client);
    let negotiated = NegotiatedSession {
        session_id: "s-steer".into(),
        model: None,
        mcp_servers: Vec::new(),
        context_window: None,
        current_mode: None,
        session_config: Default::default(),
        supports_session_close: false,
        supports_prompt_steering: true,
        may_replay_history: false,
    };
    let (tx, rx) = mpsc::channel(16);
    let mut session = AcpRuntimeSession::assemble()
        .client(&client)
        .negotiated(&negotiated)
        .cwd(std::env::temp_dir())
        .rx(rx)
        .local_tx(tx)
        .hooks(Arc::new(SpawnHooks))
        .indexer(Arc::new(StdMutex::new(EventIndexer::default())))
        .call();
    session.prompt_cancel = session
        .prompt_cancel
        .with_cancel_grace(Duration::from_secs(1));
    let mut events = session.take_message_rx();
    let session = Arc::new(session);
    let delivery_order = Arc::new(Mutex::new(()));
    let submit = |id: &'static str| {
        let session = Arc::clone(&session);
        let delivery_order = Arc::clone(&delivery_order);
        tokio::spawn(async move {
            let mut order = Some(delivery_order.lock_owned().await);
            session
                .stream_input_with_delivery_order(json!(id), Some(id.into()), &mut order, &mut None)
                .await
        })
    };
    for stop_reason in ["end_turn", "cancelled"] {
        let mut outstanding = Vec::new();
        // Read every request before replying to any of them. No second or
        // third request could get here if dispatch still held the host order.
        for id in ["first", "second", "third"] {
            let task = submit(id);
            let request = tokio::time::timeout(Duration::from_secs(3), read_request(&mut stdin))
                .await
                .unwrap();
            assert_eq!(request["method"], "session/prompt");
            assert_eq!(request["params"]["sessionId"], "s-steer");
            assert_eq!(request["params"]["messageId"], id);
            outstanding.push((id, request["id"].clone(), task));
        }
        if stop_reason == "cancelled" {
            let confirmed = session
                .pending_prompt_receipts
                .acknowledge_from_session_update(&json!({
                    "update":{"sessionUpdate":"user_message_chunk","messageId":"third",
                        "content":{"type":"text","text":"third"}}
                }))
                .unwrap();
            assert_eq!(confirmed.prompt_received_client_message_id(), Some("third"));
            session.interrupt().await.unwrap();
            let cancel = read_request(&mut stdin).await;
            assert_eq!(cancel["method"], "session/cancel");
        }
        for (id, rpc_id, task) in outstanding {
            assert!(!task.is_finished());
            send_response(
                &mut stdout,
                rpc_id,
                json!({
                    "stopReason":stop_reason, "usage":{"inputTokens":10,"outputTokens":1},
                }),
            )
            .await;
            let delivery = tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap();
            if stop_reason == "cancelled" && id == "second" {
                assert!(
                    delivery.is_err(),
                    "unconfirmed cancellation must fail delivery"
                );
            } else {
                delivery.unwrap();
                if stop_reason != "cancelled" || id != "third" {
                    assert_eq!(
                        events
                            .try_recv()
                            .unwrap()
                            .unwrap()
                            .prompt_received_client_message_id(),
                        Some(id)
                    );
                }
            }
            let event = events.try_recv().unwrap().unwrap();
            assert!(event.token_usage().is_some());
            if id == "third" {
                assert!(event.is_result());
                assert_eq!(event.raw_json()["stop_reason"], stop_reason);
            } else {
                assert!(event.is_usage_accounting());
            }
            assert!(events.try_recv().is_err());
        }
    }

    let original = submit("original");
    let first = read_request(&mut stdin).await;
    let rejected = submit("rejected");
    let steer = read_request(&mut stdin).await;
    send_response(
        &mut stdout,
        first["id"].clone(),
        json!({
            "stopReason":"end_turn", "usage":{"inputTokens":12,"outputTokens":1},
            "_meta":{"cadencr":{"backgroundWorkPending":true}},
        }),
    )
    .await;
    original.await.unwrap().unwrap();
    assert_eq!(
        events
            .try_recv()
            .unwrap()
            .unwrap()
            .prompt_received_client_message_id(),
        Some("original")
    );
    assert!(events.try_recv().unwrap().unwrap().is_usage_accounting());
    let pending = events.try_recv().unwrap().unwrap();
    assert!(pending.background_agent_signal().is_some() && !pending.is_result());
    write_json_frame(
        &mut stdout,
        json!({
            "jsonrpc":"2.0", "id":steer["id"], "error":{"code":-32602,"message":"steer rejected"}
        }),
    )
    .await;
    assert!(rejected.await.unwrap().is_err());
    let boundary = events
        .try_recv()
        .expect("the earlier result must settle the turn")
        .unwrap();
    assert!(boundary.is_result());
    assert!(boundary.token_usage().is_none());
    assert!(boundary.background_agent_signal().is_some());

    let cancelled = submit("cancelled-by-agent");
    let wire = read_request(&mut stdin).await;
    send_response(
        &mut stdout,
        wire["id"].clone(),
        json!({"stopReason":"cancelled"}),
    )
    .await;
    assert!(cancelled.await.unwrap().is_err());
    let boundary = events.try_recv().unwrap().unwrap();
    assert!(boundary.is_result() && boundary.result_error().is_some());
    assert!(events.try_recv().is_err());

    let original = submit("before-force-stop");
    let first = read_request(&mut stdin).await;
    let stopped = submit("unconfirmed-at-stop");
    let _pending = read_request(&mut stdin).await;
    send_response(
        &mut stdout,
        first["id"].clone(),
        json!({"stopReason":"end_turn"}),
    )
    .await;
    original.await.unwrap().unwrap();
    assert_eq!(
        events
            .try_recv()
            .unwrap()
            .unwrap()
            .prompt_received_client_message_id(),
        Some("before-force-stop")
    );
    session.interrupt().await.unwrap();
    assert_eq!(read_request(&mut stdin).await["method"], "session/cancel");
    let error = tokio::time::timeout(Duration::from_secs(5), stopped)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(error.is_stop_escalation());
    assert!(events.try_recv().unwrap().unwrap_err().is_stop_escalation());
    assert!(
        events.try_recv().is_err(),
        "an unresponsive killed prompt cannot acknowledge delivery"
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
        session_config: Default::default(),
        supports_session_close: false,
        supports_prompt_steering: false,
        may_replay_history: false,
    };
    let (tx, rx) = mpsc::channel(8);
    let mut session = AcpRuntimeSession::assemble()
        .client(&client)
        .negotiated(&negotiated)
        .cwd(std::env::temp_dir())
        .rx(rx)
        .local_tx(tx.clone())
        .hooks(Arc::new(SpawnHooks))
        .indexer(Arc::new(StdMutex::new(EventIndexer::default())))
        .call();
    let event_rx = client.subscribe_reliable();
    let _event_loop = spawn_event_loop(
        client.clone(),
        event_rx,
        tx,
        EventLoopConfig {
            session_id: Arc::clone(&session.session_id),
            current_model: Arc::clone(&session.current_model),
            current_effort: Arc::clone(&session.current_effort),
            current_mode: Arc::clone(&session.current_mode),
            session_config: session.session_config.clone(),
            cwd: PathBuf::from("/tmp"),
            closing: Arc::new(AtomicBool::new(false)),
            pending_permissions: PendingPermissions::default(),
            session_permissions: SessionPermissions::new(),
            terminals: Arc::new(TerminalRegistry::default()),
            hooks: Arc::new(SpawnHooks),
            replay_suppression: Arc::clone(&session.replay_suppression),
            pending_prompt_receipts: Arc::clone(&session.pending_prompt_receipts),
            browser_trust: Default::default(),
            attached_mcp: Default::default(),
            #[cfg(unix)]
            connected_mcp: Default::default(),
            indexer: Arc::clone(&session.indexer),
            prompt_turn_lock: Arc::clone(&session.prompt_turn_lock),
        },
    );
    let mut runtime_rx = session.take_message_rx();
    let prompt_turn_lock = Arc::clone(&session.prompt_turn_lock);
    let active_turn = prompt_turn_lock.lock().await;
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
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            read_request(&mut agent_stdin),
        )
        .await
        .is_err(),
        "follow-up should remain queued while another ACP prompt owns the turn"
    );
    drop(active_turn);
    let prompt = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        read_request(&mut agent_stdin),
    )
    .await
    .expect("queued prompt should start after the active turn ends");
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
    send_response(
        &mut agent_stdout,
        prompt["id"].clone(),
        json!({"stopReason": "cancelled"}),
    )
    .await;
    tokio::time::timeout(std::time::Duration::from_millis(500), steer)
        .await
        .expect("cancel should unblock steering prompt")
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn prompt_receipt_falls_back_to_prompt_response_without_user_echo() {
    let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
    spawn_event_barrier_acker(&client);
    let negotiated = NegotiatedSession {
        session_id: "s-receipt-response".to_string(),
        model: None,
        mcp_servers: Vec::new(),
        context_window: None,
        current_mode: Some("build".to_string()),
        session_config: Default::default(),
        supports_session_close: false,
        supports_prompt_steering: false,
        may_replay_history: false,
    };
    let (tx, rx) = mpsc::channel(8);
    let mut session = AcpRuntimeSession::assemble()
        .client(&client)
        .negotiated(&negotiated)
        .cwd(std::env::temp_dir())
        .rx(rx)
        .local_tx(tx)
        .hooks(Arc::new(SpawnHooks))
        .indexer(Arc::new(StdMutex::new(EventIndexer::default())))
        .call();
    let mut runtime_rx = session.take_message_rx();
    let prompt_turn_lock = Arc::clone(&session.prompt_turn_lock);
    let active_turn = prompt_turn_lock.lock().await;
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
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            read_request(&mut agent_stdin),
        )
        .await
        .is_err(),
        "follow-up should remain queued while another ACP prompt owns the turn"
    );
    drop(active_turn);
    let prompt = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        read_request(&mut agent_stdin),
    )
    .await
    .expect("queued prompt should start after the active turn ends");
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

fn hanging_prompt_agent_script(log: &std::path::Path) -> String {
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
    log(method)
    if method == "initialize":
        send({{"jsonrpc":"2.0","id":req["id"],"result":{{"protocolVersion":1,"agentCapabilities":{{"loadSession":False,"sessionCapabilities":{{"close":{{}}}}}}}}}})
    elif method == "session/new":
        send({{"jsonrpc":"2.0","id":req["id"],"result":{{"sessionId":"ses_hanging","modes":{{"currentModeId":"build"}}}}}})
    elif method == "session/prompt":
        pass
    elif method == "session/close":
        pass
"#,
        log_path = serde_json::to_string(&log.to_string_lossy()).unwrap()
    )
}
