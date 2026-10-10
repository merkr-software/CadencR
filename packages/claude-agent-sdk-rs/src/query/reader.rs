//! Background task that reads from the CLI's stdout, routes control
//! protocol messages, dispatches permission callbacks, and forwards
//! parsed [`SdkMessage`]s to the [`Query`](super::query_struct::Query)
//! channel.
//!
//! The permission-callback spawn lives in
//! [`super::permission_dispatch`] so this file stays focused on the
//! read/route/forward loop.

use std::sync::Arc;

use tokio::io::BufWriter;
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::error::SdkError;
use crate::messages::SdkMessage;
use crate::permissions::CanUseTool;
use crate::transport::CliProcess;
use crate::types::McpServerStatus;

use super::cancelled_control::CancelledControlRequests;
use super::reader_task::ReaderTask;
use super::turn_state::TurnState;
use super::wire::{InterruptAck, PendingControl};

/// Core background loop that reads from CLI stdout, handles permission
/// requests, and forwards messages to the channel.
#[allow(clippy::too_many_arguments)]
pub(super) async fn reader_loop(
    process: CliProcess,
    process_stdin: Arc<Mutex<Option<BufWriter<ChildStdin>>>>,
    tx: mpsc::Sender<Result<SdkMessage, SdkError>>,
    can_use_tool: Option<Arc<dyn CanUseTool>>,
    session_id: Arc<Mutex<Option<String>>>,
    mcp_servers: Arc<Mutex<Vec<McpServerStatus>>>,
    turn_state: Arc<Mutex<TurnState>>,
    pending_control: PendingControl,
    cancelled_control_requests: CancelledControlRequests,
    cancel_token: Option<CancellationToken>,
    interrupt_rx: mpsc::Receiver<InterruptAck>,
    kill_rx: mpsc::Receiver<()>,
) {
    ReaderTask {
        process,
        process_stdin,
        tx,
        can_use_tool,
        session_id,
        mcp_servers,
        turn_state,
        pending_control,
        cancelled_control_requests,
        cancel_token,
        interrupt_rx,
        kill_rx,
    }
    .run()
    .await;
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use futures::StreamExt;
    use tempfile::TempDir;

    use crate::error::SdkError;
    use crate::messages::SdkMessage;
    use crate::options::Options;
    use crate::query::query;

    use super::super::test_support::{
        control_cancel_permission_script, mock_mcp_servers, write_mock_cli,
    };
    use super::super::wire::{control_cancel_request_id, control_request_subtype};

    #[tokio::test]
    async fn close_kills_child_process() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: drain the SDK init handshake and initial user prompt,
        // emit system init, then sleep forever (simulates a long-running process).
        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_close","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
sleep 300
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();

        // Read the system init message
        let msg = q.next().await;
        assert!(msg.is_some());

        // Close should kill the process and the stream should end
        q.close().await;

        // After close, the stream should be done (no more messages)
        let remaining = q.next().await;
        assert!(remaining.is_none(), "stream should end after close()");
    }

    #[tokio::test]
    async fn clean_exit_with_stderr_surfaces_a_process_exit_error() {
        // Regression: a CLI that exits 0 but wrote to stderr (e.g. crashed after
        // an internal error it "handled" by quitting) used to end the stream
        // silently — code-0 exits sent nothing and the stderr was discarded. It
        // must now surface as a `ProcessExit` carrying the stderr so the turn
        // never just stops without explanation.
        let dir = TempDir::new().unwrap();
        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo "fatal: the agent crashed" 1>&2
exit 0
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();

        let item = q.next().await.expect("a terminal item");
        match item {
            Err(SdkError::ProcessExit { code, stderr }) => {
                assert_eq!(code, Some(0));
                assert!(
                    stderr.contains("the agent crashed"),
                    "stderr must be surfaced, got: {stderr:?}"
                );
            }
            other => panic!("expected ProcessExit carrying stderr, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn interrupt_returns_after_interrupted_turn_completes() {
        let dir = TempDir::new().unwrap();
        let script = r#"#!/usr/bin/env python3
import json
import signal
import sys
import time

interrupted = False

def send(value):
    print(json.dumps(value), flush=True)

def handle_int(_signum, _frame):
    global interrupted
    interrupted = True

signal.signal(signal.SIGINT, handle_int)

init_req = json.loads(sys.stdin.readline())
send({"type":"control_response","response":{"subtype":"success","request_id":init_req["request_id"],"response":{}}})
sys.stdin.readline()
send({"type":"system","subtype":"init","uuid":"u1","session_id":"sess_interrupt_wait","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]})

while True:
    if interrupted:
        time.sleep(0.05)
        send({"type":"result","subtype":"success","uuid":"u2","session_id":"sess_interrupt_wait","duration_ms":10,"duration_api_ms":5,"is_error":False,"num_turns":1,"result":"interrupted","errors":None,"stop_reason":"interrupt","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":None})
        interrupted = False
    time.sleep(0.01)
"#;
        let script_path = write_mock_cli(dir.path(), script);
        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: None,
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("initial".into()), options)
            .await
            .unwrap();
        q.next().await.expect("init message").unwrap();

        q.interrupt().await.unwrap();
        assert!(matches!(
            q.turn_state().await,
            super::super::turn_state::TurnState::TurnComplete { .. }
        ));
        q.close().await;
    }

    #[tokio::test]
    async fn query_handles_permission_request() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: handle initialize, read user prompt, emit a permission request,
        // read the response, then emit result
        let script = r#"#!/bin/sh
read -r INIT_REQ
echo '{"type":"control_response","response":{"subtype":"success","request_id":"init_perm","response":{"pid":9999}}}'
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_456","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"control_request","request_id":"req_1_perm","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"path":"/tmp/test.txt"}}}'
read -r RESPONSE
echo '{"type":"result","subtype":"success","uuid":"u3","session_id":"sess_456","duration_ms":50,"duration_api_ms":40,"is_error":false,"num_turns":1,"result":"done","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{"input_tokens":5,"output_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
"#;
        let script_path = write_mock_cli(dir.path(), script);

        // Use AllowAllTools handler
        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            can_use_tool: Some(Arc::new(crate::permissions::AllowAllTools)),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();

        let mut messages = Vec::new();
        while let Some(msg) = q.next().await {
            messages.push(msg.unwrap());
        }

        // Permission request should NOT appear in messages (handled internally)
        // Should get: System(Init), Result
        assert!(messages.len() >= 2, "got {} messages", messages.len());
        assert!(messages
            .iter()
            .all(|m| !matches!(m, SdkMessage::Unknown(v) if control_request_subtype(v) == Some("can_use_tool"))));
    }

    #[tokio::test]
    async fn control_cancel_request_cancels_permission_without_late_stdin_write() {
        struct DelayedAllow {
            done_path: PathBuf,
            started_path: PathBuf,
        }

        #[async_trait::async_trait]
        impl crate::permissions::CanUseTool for DelayedAllow {
            async fn can_use_tool(
                &self,
                request: crate::permissions::PermissionRequest,
            ) -> crate::permissions::PermissionResult {
                tokio::fs::write(&self.started_path, b"started")
                    .await
                    .unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(75)).await;
                tokio::fs::write(&self.done_path, b"done").await.unwrap();
                crate::permissions::PermissionResult::Allow {
                    updated_input: request.input,
                    updated_permissions: None,
                    tool_use_id: Some(request.tool_use_id),
                }
            }
        }

        let dir = TempDir::new().unwrap();
        let done_path = dir.path().join("permission_done");
        let started_path = dir.path().join("permission_started");
        let done_literal = serde_json::to_string(&done_path.to_string_lossy()).unwrap();
        let started_literal = serde_json::to_string(&started_path.to_string_lossy()).unwrap();
        let script = control_cancel_permission_script(&done_literal, &started_literal);
        let script_path = write_mock_cli(dir.path(), &script);
        let options = Options {
            path_to_cli: Some(script_path),
            cwd: dir.path().to_path_buf(),
            can_use_tool: Some(Arc::new(DelayedAllow {
                done_path,
                started_path,
            })),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();
        let mut messages = Vec::new();
        while let Some(msg) = q.next().await {
            messages.push(msg.unwrap());
        }

        assert!(messages.iter().all(|m| {
            !matches!(m, SdkMessage::Unknown(raw)
                if control_cancel_request_id(raw).is_some())
        }));
        let result = messages.iter().find_map(|m| match m {
            SdkMessage::Result {
                is_error, result, ..
            } => Some((*is_error, result.as_deref())),
            _ => None,
        });
        assert_eq!(result, Some((false, Some("cancelled cleanly"))));
    }

    #[tokio::test]
    async fn query_responds_to_initialize_control_request_from_cli() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: read init + prompt from SDK, then send its OWN initialize
        // control_request (the CLI sometimes sends this). The SDK must respond
        // so the CLI continues. Then emit system init + result.
        let script = r#"#!/bin/sh
read -r SDK_INIT
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"control_request","request_id":"cli_init_1","request":{"subtype":"initialize"}}'
read -r SDK_RESPONSE
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_clinit","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_clinit","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();

        let mut messages = Vec::new();
        while let Some(msg) = q.next().await {
            messages.push(msg.unwrap());
        }

        // The CLI's initialize request should be handled (responded to) and not
        // forwarded as a message. We should only see System(Init) + Result.
        assert_eq!(
            messages.len(),
            2,
            "expected 2 messages, got {}",
            messages.len()
        );

        let sid = q.session_id().await;
        assert_eq!(sid, Some("sess_clinit".to_string()));
    }
}
