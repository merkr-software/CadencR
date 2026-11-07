use super::server_requests::{spawn_event_loop, EventLoopConfig};
use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
use crate::domain::agents::acp::runtime::prompt_receipts::PendingPromptReceipts;
use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
use crate::domain::agents::acp::runtime::terminal_registry::TerminalRegistry;
use crate::domain::agents::acp::{AcpClient, AcpClientInfo};
use crate::domain::agents::adapter::RuntimePermissionMode;
use crate::domain::mcp::trusted::test_support::injected_browser_servers;
use crate::domain::mcp::trusted::CadencrBrowserTrust;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::{mpsc, RwLock};

struct PlainHooks;
#[async_trait]
impl AcpProviderHooks for PlainHooks {
    fn normalize_tool_name(&self, raw: &str) -> String {
        raw.to_string()
    }
    fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
        input
    }
    fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
        None
    }
}

struct NormalizingHooks;
#[async_trait]
impl AcpProviderHooks for NormalizingHooks {
    fn normalize_tool_name(&self, raw: &str) -> String {
        match raw {
            "MCP: tool" => "mcp__mcp__tool".to_string(),
            "server-echo_probe: echo_probe" => "mcp__server__echo_probe".to_string(),
            "chrome-devtools-new_page: new_page" => "mcp__chrome-devtools__new_page".to_string(),
            "cadencr-browser-browser_open_url: browser_open_url" => {
                "mcp__cadencr-browser__browser_open_url".to_string()
            }
            _ => raw.to_string(),
        }
    }

    fn normalize_tool_input(&self, tool_name: &str, mut input: Value) -> Value {
        if let Some(value) = input.get_mut("textValue").map(Value::take) {
            input["text"] = value;
        }
        if let Some(identity) = tool_name.strip_prefix("mcp__") {
            let Some((server, tool)) = identity.split_once("__") else {
                return input;
            };
            if server != "mcp" {
                if input.get("description").and_then(Value::as_str) == Some("MCP: tool") {
                    input.as_object_mut().expect("object").remove("description");
                }
                return json!({ "server": server, "tool": tool, "arguments": input });
            }
        }
        input
    }

    fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
        None
    }
}

pub(super) async fn client_with_agent_io() -> (AcpClient, DuplexStream, BufReader<DuplexStream>) {
    let (client_reads_stdout, agent_writes_stdout) = duplex(64 * 1024);
    let (agent_reads_stdin, client_writes_stdin) = duplex(64 * 1024);
    let client = AcpClient::spawn_with_streams(
        Box::new(client_writes_stdin),
        client_reads_stdout,
        tokio::io::empty(),
        AcpClientInfo::default(),
    )
    .await
    .unwrap();
    (
        client,
        agent_writes_stdout,
        BufReader::new(agent_reads_stdin),
    )
}

pub(super) fn event_loop_config(cwd: PathBuf) -> EventLoopConfig {
    let hooks = Arc::new(PlainHooks);
    EventLoopConfig {
        session_id: Arc::new(RwLock::new(Some("s-1".to_string()))),
        current_model: Arc::new(RwLock::new(None)),
        current_effort: Arc::new(RwLock::new(None)),
        current_mode: Arc::new(RwLock::new("build".to_string())),
        session_config: super::session_config::AcpSessionConfigState::new(
            Default::default(),
            hooks.clone(),
        ),
        cwd,
        closing: Arc::new(AtomicBool::new(false)),
        pending_permissions: Default::default(),
        session_permissions: Default::default(),
        terminals: Arc::new(TerminalRegistry::default()),
        hooks,
        replay_suppression: Arc::new(AtomicBool::new(false)),
        pending_prompt_receipts: Arc::new(PendingPromptReceipts::default()),
        browser_trust: Default::default(),
        indexer: Arc::new(StdMutex::new(EventIndexer::default())),
    }
}

pub(super) async fn write_agent_request(stdout: &mut DuplexStream, request: Value) {
    let mut frame = serde_json::to_vec(&request).unwrap();
    frame.push(b'\n');
    stdout.write_all(&frame).await.unwrap();
}

pub(super) async fn read_agent_response(stdin: &mut BufReader<DuplexStream>) -> Value {
    let mut line = String::new();
    // Subprocess-backed requests include process startup and output draining.
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stdin.read_line(&mut line),
    )
    .await
    .expect("timed out waiting for ACP response")
    .unwrap();
    serde_json::from_str(line.trim()).unwrap()
}

#[tokio::test]
async fn event_loop_rejects_unknown_server_request_method() {
    let (client, mut stdout, mut stdin) = client_with_agent_io().await;
    let (_tx, _rx) = mpsc::channel(8);
    let _loop = spawn_event_loop(
        client.clone(),
        client.subscribe_reliable(),
        _tx,
        event_loop_config(PathBuf::from("/tmp")),
    );
    write_agent_request(
        &mut stdout,
        json!({ "jsonrpc": "2.0", "id": "u-1", "method": "unknown/request", "params": {} }),
    )
    .await;
    let response = read_agent_response(&mut stdin).await;
    assert_eq!(response["id"], "u-1");
    assert_eq!(response["error"]["code"], -32601);
}

#[tokio::test]
async fn event_loop_suppresses_resume_replay_until_prompt_dispatch() {
    let (client, mut stdout, _stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(8);
    let config = event_loop_config(PathBuf::from("/tmp"));
    let replay_suppression = Arc::clone(&config.replay_suppression);
    replay_suppression.store(true, Ordering::SeqCst);
    let _loop = spawn_event_loop(client.clone(), client.subscribe_reliable(), tx, config);

    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "replayed" }
                }
            }
        }),
    )
    .await;
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv())
            .await
            .is_err(),
        "resume replay transcript should not be forwarded"
    );

    replay_suppression.store(false, Ordering::SeqCst);
    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "live" }
                }
            }
        }),
    )
    .await;
    let event = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv())
        .await
        .expect("live transcript should be forwarded")
        .expect("runtime channel open")
        .expect("runtime event ok");
    assert!(!event.is_result());
}

#[tokio::test]
async fn event_loop_handles_fs_read_server_request() {
    let cwd = std::env::temp_dir().join(format!("cadencr-acp-server-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(cwd.join("readme.txt"), "hello acp").unwrap();
    let (client, mut stdout, mut stdin) = client_with_agent_io().await;
    let (_tx, _rx) = mpsc::channel(8);
    let _loop = spawn_event_loop(
        client.clone(),
        client.subscribe_reliable(),
        _tx,
        event_loop_config(cwd),
    );
    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "fs-1",
            "method": "fs/read_text_file",
            "params": { "sessionId": "s-1", "path": "readme.txt" }
        }),
    )
    .await;
    let response = read_agent_response(&mut stdin).await;
    assert_eq!(response["id"], "fs-1");
    assert!(response["result"]["content"]
        .as_str()
        .unwrap()
        .contains("hello acp"));
}

#[tokio::test]
async fn event_loop_rejects_malformed_permission_server_request() {
    let (client, mut stdout, mut stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(8);
    let _loop = spawn_event_loop(
        client.clone(),
        client.subscribe_reliable(),
        tx,
        event_loop_config(PathBuf::from("/tmp")),
    );
    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "perm-1",
            "method": "session/request_permission",
            "params": { "sessionId": "s-1" }
        }),
    )
    .await;
    let response = read_agent_response(&mut stdin).await;
    assert_eq!(response["id"], "perm-1");
    assert_eq!(response["error"]["code"], -32602);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn permission_request_uses_recorded_tool_input_when_payload_is_empty() {
    let (client, mut stdout, _stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(8);
    let _loop = spawn_event_loop(
        client.clone(),
        client.subscribe_reliable(),
        tx,
        event_loop_config(PathBuf::from("/tmp")),
    );
    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-bash",
                    "toolName": "Bash",
                    "toolInput": { "command": "git status --short" }
                }
            }
        }),
    )
    .await;
    let _tool_event = rx.recv().await.expect("tool event").expect("ok");

    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "perm-1",
            "method": "session/request_permission",
            "params": {
                "sessionId": "s-1",
                "toolCall": {
                    "toolCallId": "call-bash",
                    "toolName": "Bash",
                    "toolInput": {}
                }
            }
        }),
    )
    .await;
    let permission_event = rx.recv().await.expect("permission event").expect("ok");
    let raw = permission_event.raw_json();
    assert_eq!(raw["tool_input"]["command"], "git status --short");
    assert_eq!(raw["preview"], "git status --short");
}

#[tokio::test]
async fn permission_request_uses_provider_tool_normalization_before_dispatch() {
    let (client, mut stdout, _stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(8);
    let mut config = event_loop_config(PathBuf::from("/tmp"));
    config.hooks = Arc::new(NormalizingHooks);
    let _loop = spawn_event_loop(client.clone(), client.subscribe_reliable(), tx, config);

    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "perm-mcp",
            "method": "session/request_permission",
            "params": {
                "sessionId": "s-1",
                "toolCall": {
                    "toolCallId": "call-mcp",
                    "title": "server-echo_probe: echo_probe",
                    "kind": "other",
                    "rawInput": { "textValue": "hello" }
                }
            }
        }),
    )
    .await;

    let event = rx.recv().await.expect("permission event").expect("ok");
    let raw = event.raw_json();
    assert_eq!(raw["tool_name"], "mcp__server__echo_probe");
    assert_eq!(raw["tool_input"]["server"], "server");
    assert_eq!(raw["tool_input"]["tool"], "echo_probe");
    assert_eq!(raw["tool_input"]["arguments"]["text"], "hello");
}

#[tokio::test]
async fn permission_repairs_cursor_mcp_identity_on_the_existing_tool_block() {
    let (client, mut stdout, _stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(8);
    let mut config = event_loop_config(PathBuf::from("/tmp"));
    config.hooks = Arc::new(NormalizingHooks);
    let _loop = spawn_event_loop(client.clone(), client.subscribe_reliable(), tx, config);

    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-mcp",
                    "title": "MCP: tool",
                    "kind": "other",
                    "status": "pending"
                }
            }
        }),
    )
    .await;
    let start = rx.recv().await.expect("tool event").expect("ok");
    assert_eq!(
        start.raw_json().pointer("/event/content_block/name"),
        Some(&json!("mcp__mcp__tool"))
    );

    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "perm-mcp",
            "method": "session/request_permission",
            "params": {
                "sessionId": "s-1",
                "toolCall": {
                    "toolCallId": "call-mcp",
                    "title": "chrome-devtools-new_page: new_page",
                    "kind": "other",
                    "rawInput": { "url": "https://google.com" }
                },
                "options": [{
                    "optionId": "allow-once",
                    "name": "Allow once",
                    "kind": "allow_once"
                }]
            }
        }),
    )
    .await;

    let identity_delta = rx.recv().await.expect("identity delta").expect("ok");
    let partial_json = identity_delta
        .raw_json()
        .pointer("/event/delta/partial_json")
        .and_then(Value::as_str)
        .expect("input json delta");
    assert_eq!(
        serde_json::from_str::<Value>(partial_json).expect("valid JSON"),
        json!({
            "description": "MCP: tool",
            "server": "chrome-devtools",
            "tool": "new_page",
            "arguments": { "url": "https://google.com" }
        })
    );

    let permission = rx.recv().await.expect("permission event").expect("ok");
    assert_eq!(
        permission.raw_json()["tool_name"],
        "mcp__chrome-devtools__new_page"
    );
}

#[tokio::test]
async fn normalized_cadencr_browser_permission_is_auto_allowed() {
    let (client, mut stdout, mut stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(8);
    let mut config = event_loop_config(PathBuf::from("/tmp"));
    config.hooks = Arc::new(NormalizingHooks);
    config.browser_trust = CadencrBrowserTrust::injected_in(Some(&injected_browser_servers()));
    let _loop = spawn_event_loop(client.clone(), client.subscribe_reliable(), tx, config);

    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "perm-browser",
            "method": "session/request_permission",
            "params": {
                "sessionId": "s-1",
                "toolCall": {
                    "toolCallId": "call-browser",
                    "title": "cadencr-browser-browser_open_url: browser_open_url",
                    "kind": "other",
                    "rawInput": { "url": "http://localhost:1420" }
                },
                "options": [{
                    "optionId": "allow-once",
                    "name": "Allow once",
                    "kind": "allow_once"
                }]
            }
        }),
    )
    .await;

    let response = read_agent_response(&mut stdin).await;
    assert_eq!(response["id"], "perm-browser");
    assert_eq!(response["result"]["outcome"]["optionId"], "allow-once");
    assert!(
        rx.try_recv().is_err(),
        "trusted browser permission should not reach the UI"
    );
}

#[tokio::test]
async fn browser_permission_reaches_the_ui_when_cadencr_browser_is_untrusted() {
    let (client, mut stdout, _stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(8);
    let mut config = event_loop_config(PathBuf::from("/tmp"));
    config.hooks = Arc::new(NormalizingHooks);
    let _loop = spawn_event_loop(client.clone(), client.subscribe_reliable(), tx, config);

    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "perm-foreign-browser",
            "method": "session/request_permission",
            "params": {
                "sessionId": "s-1",
                "toolCall": {
                    "toolCallId": "call-foreign-browser",
                    "title": "cadencr-browser-browser_open_url: browser_open_url",
                    "kind": "other",
                    "rawInput": { "url": "http://localhost:1420" }
                },
                "options": [{ "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" }]
            }
        }),
    )
    .await;

    let permission = rx.recv().await.expect("permission event").expect("ok");
    assert_eq!(
        permission.raw_json()["tool_name"],
        "mcp__cadencr-browser__browser_open_url"
    );
}

#[tokio::test]
async fn pending_permission_is_refreshed_when_opencode_sends_input_after_request() {
    let (client, mut stdout, _stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(8);
    let _loop = spawn_event_loop(
        client.clone(),
        client.subscribe_reliable(),
        tx,
        event_loop_config(PathBuf::from("/tmp")),
    );
    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-late-bash",
                    "title": "bash",
                    "kind": "execute",
                    "status": "pending",
                    "rawInput": {}
                }
            }
        }),
    )
    .await;
    let _tool_event = rx.recv().await.expect("tool event").expect("ok");

    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s-1",
                "toolCall": {
                    "toolCallId": "call-late-bash",
                    "status": "pending",
                    "title": "bash",
                    "rawInput": {},
                    "kind": "execute"
                },
                "options": [
                    { "optionId": "once", "name": "Allow once", "kind": "allow_once" },
                    { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
                ]
            }
        }),
    )
    .await;
    let initial_permission = rx.recv().await.expect("permission event").expect("ok");
    assert_eq!(initial_permission.raw_json()["request_id"], "2");
    assert_eq!(
        initial_permission.raw_json()["tool_input"],
        json!({ "description": "bash" })
    );

    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-late-bash",
                    "status": "in_progress",
                    "title": "bash",
                    "kind": "execute",
                    "rawInput": {
                        "command": "opencode --version 2>/dev/null || which opencode 2>/dev/null",
                        "description": "Get OpenCode version"
                    }
                }
            }
        }),
    )
    .await;

    let refreshed = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            let event = rx.recv().await.expect("refreshed permission").expect("ok");
            if event.raw_json()["type"] == "acp_permission_request" {
                break event;
            }
        }
    })
    .await
    .expect("timed out waiting for refreshed permission");
    let raw = refreshed.raw_json();
    assert_eq!(raw["request_id"], "2");
    assert_eq!(
        raw["tool_input"]["command"],
        "opencode --version 2>/dev/null || which opencode 2>/dev/null"
    );
    assert_eq!(
        raw["preview"],
        "opencode --version 2>/dev/null || which opencode 2>/dev/null"
    );
    assert_eq!(raw["tool_input"]["description"], "Get OpenCode version");
}

fn text_chunk(n: usize) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": format!("chunk-{n} ") }
            }
        }
    })
}

#[tokio::test]
async fn stalled_runtime_consumer_still_receives_requests_after_a_burst() {
    // Regression: the loop used to read a broadcast(4096). With the runtime
    // consumer stalled, a burst lagged it and the permission request behind
    // the burst was skipped — its responder waited forever.
    let (client, mut stdout, mut stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(1);
    let _loop = spawn_event_loop(
        client.clone(),
        client.subscribe_reliable(),
        tx,
        event_loop_config(PathBuf::from("/tmp")),
    );
    for n in 0..5_000 {
        write_agent_request(&mut stdout, text_chunk(n)).await;
    }
    write_agent_request(
        &mut stdout,
        json!({
            "jsonrpc": "2.0", "id": "perm-after-burst",
            "method": "session/request_permission", "params": { "sessionId": "s-1" }
        }),
    )
    .await;
    let drain = tokio::spawn(async move {
        let markers = [0, 4095, 4096, 4999].map(|n| format!("chunk-{n} "));
        let mut seen = [false; 4];
        while let Some(event) = rx.recv().await {
            // Each chunk's text appears verbatim in its delta event.
            let raw = event.expect("no transport error").raw_json().to_string();
            for (marker, seen) in markers.iter().zip(seen.iter_mut()) {
                *seen |= raw.contains(marker.as_str());
            }
            if seen[3] {
                break;
            }
        }
        seen
    });
    let response = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        read_agent_response(&mut stdin).await
    })
    .await
    .expect("request behind the burst must be answered");
    assert_eq!(response["id"], "perm-after-burst");
    assert_eq!(response["error"]["code"], -32602);
    let seen = tokio::time::timeout(std::time::Duration::from_secs(30), drain)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        seen, [true; 4],
        "chunks 0, 4095, 4096 and 4999 must all arrive"
    );
}

#[tokio::test]
async fn event_queue_overflow_ends_the_session_with_a_visible_error() {
    let (client, mut stdout, _stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(1);
    let _loop = spawn_event_loop(
        client.clone(),
        client.subscribe_reliable(),
        tx,
        event_loop_config(PathBuf::from("/tmp")),
    );
    // One text chunk wedges the loop on the full runtime channel; cheap
    // extension notifications then fill the queue past its event limit.
    write_agent_request(&mut stdout, text_chunk(0)).await;
    let mut burst = Vec::new();
    for _ in 0..65_600 {
        burst.extend_from_slice(br#"{"jsonrpc":"2.0","method":"_qa/noise","params":{}}"#);
        burst.push(b'\n');
    }
    stdout.write_all(&burst).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let error = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            match rx.recv().await.expect("terminal error before EOF") {
                Ok(_) => continue,
                Err(error) => break error,
            }
        }
    })
    .await
    .expect("overflow must surface");
    assert!(error.to_string().contains("safety limit"), "{error}");
}

#[cfg(unix)]
#[tokio::test]
async fn wait_for_exit_does_not_block_the_loop_and_kill_still_reaches_the_command() {
    // Regression: wait_for_exit was awaited inline (stalling every later
    // event) and moved the Child out, so terminal/kill returned success
    // without killing anything and the wait never returned.
    let (client, mut stdout, mut stdin) = client_with_agent_io().await;
    let (tx, _rx) = mpsc::channel(8);
    let _loop = spawn_event_loop(
        client.clone(),
        client.subscribe_reliable(),
        tx,
        event_loop_config(std::env::temp_dir()),
    );
    let request = |id: &str, method: &str, params: Value| json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    write_agent_request(
        &mut stdout,
        request(
            "create",
            "terminal/create",
            json!({ "sessionId": "s-1", "command": "/bin/sh", "args": ["-c", "exec sleep 30"] }),
        ),
    )
    .await;
    let created = read_agent_response(&mut stdin).await;
    let terminal = json!({
        "sessionId": "s-1",
        "terminalId": created["result"]["terminalId"].as_str().expect("terminal id"),
    });
    write_agent_request(
        &mut stdout,
        request("wait", "terminal/wait_for_exit", terminal.clone()),
    )
    .await;
    write_agent_request(
        &mut stdout,
        request("output", "terminal/output", terminal.clone()),
    )
    .await;
    let output = read_agent_response(&mut stdin).await;
    assert_eq!(output["id"], "output", "the loop must not wait for exit");
    assert!(output["result"].get("exitStatus").is_none());
    write_agent_request(&mut stdout, request("kill", "terminal/kill", terminal)).await;
    let mut responses = vec![
        read_agent_response(&mut stdin).await,
        read_agent_response(&mut stdin).await,
    ];
    responses.sort_by_key(|response| response["id"].as_str().unwrap_or_default().to_string());
    assert_eq!(responses[0]["id"], "kill");
    assert!(responses[0].get("result").is_some(), "{}", responses[0]);
    assert_eq!(responses[1]["id"], "wait");
    assert_eq!(responses[1]["result"]["signal"], libc::SIGKILL);
}
