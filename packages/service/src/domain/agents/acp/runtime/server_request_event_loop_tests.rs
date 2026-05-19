use super::server_requests::{spawn_event_loop, EventLoopConfig};
use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
use crate::domain::agents::acp::runtime::prompt_receipts::PendingPromptReceipts;
use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
use crate::domain::agents::acp::runtime::terminal_registry::TerminalRegistry;
use crate::domain::agents::acp::{AcpClient, AcpClientInfo};
use crate::domain::agents::adapter::RuntimePermissionMode;
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

async fn client_with_agent_io() -> (AcpClient, DuplexStream, BufReader<DuplexStream>) {
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

fn event_loop_config(cwd: PathBuf) -> EventLoopConfig {
    EventLoopConfig {
        session_id: Arc::new(RwLock::new(Some("s-1".to_string()))),
        current_model: Arc::new(RwLock::new(None)),
        current_effort: Arc::new(RwLock::new(None)),
        current_mode: Arc::new(RwLock::new("build".to_string())),
        cwd,
        closing: Arc::new(AtomicBool::new(false)),
        pending_permissions: Default::default(),
        session_permissions: Default::default(),
        terminals: Arc::new(TerminalRegistry::default()),
        hooks: Arc::new(PlainHooks),
        replay_suppression: Arc::new(AtomicBool::new(false)),
        pending_prompt_receipts: Arc::new(PendingPromptReceipts::default()),
        indexer: Arc::new(StdMutex::new(EventIndexer::default())),
    }
}

async fn write_agent_request(stdout: &mut DuplexStream, request: Value) {
    let mut frame = serde_json::to_vec(&request).unwrap();
    frame.push(b'\n');
    stdout.write_all(&frame).await.unwrap();
}

async fn read_agent_response(stdin: &mut BufReader<DuplexStream>) -> Value {
    let mut line = String::new();
    tokio::time::timeout(
        std::time::Duration::from_millis(500),
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
        client.subscribe(),
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
    let _loop = spawn_event_loop(client.clone(), client.subscribe(), tx, config);

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
        client.subscribe(),
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
        client.subscribe(),
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
        client.subscribe(),
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
async fn pending_permission_is_refreshed_when_opencode_sends_input_after_request() {
    let (client, mut stdout, _stdin) = client_with_agent_io().await;
    let (tx, mut rx) = mpsc::channel(8);
    let _loop = spawn_event_loop(
        client.clone(),
        client.subscribe(),
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
    assert_eq!(initial_permission.raw_json()["tool_input"], json!({}));

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
}
