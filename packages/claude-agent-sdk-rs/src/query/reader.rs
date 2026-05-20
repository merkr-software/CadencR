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
use tracing::{debug, info, warn};

use crate::error::SdkError;
use crate::messages::SdkMessage;
use crate::permissions::CanUseTool;
use crate::transport::CliProcess;

use super::permission_dispatch::handle_can_use_tool_request;
use super::turn_state::TurnState;
use super::wire::{
    build_success_ack, control_request_subtype, parse_control_response, parse_permission_request,
    write_to_stdin, PendingControl,
};

/// Core background loop that reads from CLI stdout, handles permission
/// requests, and forwards messages to the channel.
#[allow(clippy::too_many_arguments)]
pub(super) async fn reader_loop(
    mut process: CliProcess,
    process_stdin: Arc<Mutex<Option<BufWriter<ChildStdin>>>>,
    tx: mpsc::Sender<Result<SdkMessage, SdkError>>,
    can_use_tool: Option<Arc<dyn CanUseTool>>,
    session_id: Arc<Mutex<Option<String>>>,
    turn_state: Arc<Mutex<TurnState>>,
    pending_control: PendingControl,
    cancel_token: Option<CancellationToken>,
    mut interrupt_rx: mpsc::Receiver<()>,
    mut kill_rx: mpsc::Receiver<()>,
) {
    loop {
        // Select between reading the next message, receiving an interrupt signal,
        // and cancellation. The cancellation branch ensures we break out even if
        // the reader is blocked waiting for CLI output.
        let raw = tokio::select! {
            result = process.read_message() => {
                match result {
                    Ok(Some(value)) => value,
                    Ok(None) => {
                        // EOF — process exited, check exit code
                        let (code, stderr) = process.wait_with_stderr().await;
                        if code.unwrap_or(0) != 0 {
                            let _ = tx
                                .send(Err(SdkError::ProcessExit { code, stderr }))
                                .await;
                        }
                        info!("CLI process exited (code={code:?})");
                        break;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        break;
                    }
                }
            }
            _ = interrupt_rx.recv() => {
                debug!("interrupt signal received, sending SIGINT to CLI process");
                if let Err(e) = process.interrupt().await {
                    warn!("failed to interrupt CLI process: {e}");
                }
                continue;
            }
            _ = kill_rx.recv() => {
                debug!("kill signal received, terminating CLI process");
                if let Err(e) = process.kill().await {
                    warn!("failed to kill CLI process: {e}");
                }
                break;
            }
            _ = async {
                if let Some(ref token) = cancel_token {
                    token.cancelled().await
                } else {
                    std::future::pending().await
                }
            } => {
                warn!("cancel token fired, killing CLI process");
                if let Err(e) = process.kill().await {
                    warn!("failed to kill CLI process on cancel: {e}");
                }
                let _ = tx.send(Err(SdkError::Cancelled)).await;
                break;
            }
        };

        // Route `control_response` messages to whoever is awaiting them.
        //
        // The CLI replies to every `control_request` we send with a
        // `control_response` carrying the same `request_id`. We resolve
        // the matching oneshot in `pending_control` (registered by
        // `Query::send_control_request`) so the caller learns the CLI's
        // verdict — `subtype: "success"` → `Ok(inner_response)`,
        // `subtype: "error"` → `Err(SdkError::ControlRequestFailed)`.
        //
        // Replies with no matching pending entry are intentionally
        // dropped: the CLI sometimes echoes responses to its own
        // `initialize` round-trip (or the SDK's startup `initialize`
        // never registers a pending entry). These are not SDK messages
        // and must not be forwarded to the caller.
        if raw.get("type").and_then(|t| t.as_str()) == Some("control_response") {
            let Some(request_id) = raw.pointer("/response/request_id").and_then(|v| v.as_str())
            else {
                debug!("received control_response without request_id, skipping");
                continue;
            };
            match pending_control.lock().await.remove(request_id) {
                Some(entry) => {
                    let outcome = parse_control_response(&raw, &entry.subtype);
                    // Receiver may have timed out and dropped — ignore.
                    let _ = entry.sender.send(outcome);
                }
                None => {
                    debug!(
                        request_id,
                        "received control_response with no pending sender, skipping"
                    );
                }
            }
            continue;
        }

        // Handle `initialize` control_request from the CLI (if it sends one).
        // Respond so the CLI knows we support the control protocol.
        if control_request_subtype(&raw) == Some("initialize") {
            let request_id = raw
                .get("request_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            debug!("received initialize control request, responding");
            if let Err(e) = write_to_stdin(&process_stdin, &build_success_ack(&request_id)).await {
                let _ = tx.send(Err(e)).await;
                break;
            }
            continue;
        }

        // Check if this is a permission request (canUseTool protocol).
        // The actual callback dispatch is spawned onto a separate task —
        // see `permission_dispatch::handle_can_use_tool_request` for why.
        if control_request_subtype(&raw) == Some("can_use_tool") {
            let request = parse_permission_request(&raw);
            debug!(tool = %request.tool_name, "received permission request");

            // Update turn state — we're now waiting for user. Done before
            // the spawn so subsequent reads in this loop see the new state
            // without racing the spawned task.
            *turn_state.lock().await = TurnState::WaitingForPermission {
                tool_name: request.tool_name.clone(),
                tool_use_id: request.tool_use_id.clone(),
            };

            tokio::spawn(handle_can_use_tool_request(
                Arc::clone(&process_stdin),
                Arc::clone(&turn_state),
                tx.clone(),
                can_use_tool.as_ref().map(Arc::clone),
                request,
            ));

            continue; // Don't yield permission requests to the caller
        }

        // Parse into SdkMessage
        let message: SdkMessage = match serde_json::from_value(raw.clone()) {
            Ok(msg) => msg,
            Err(_) => SdkMessage::Unknown(raw),
        };

        // Capture session_id from System init
        if let Some(sid) = message.session_id() {
            let mut guard = session_id.lock().await;
            if guard.is_none() {
                debug!(session_id = sid, "captured session ID");
                *guard = Some(sid.to_string());
            }
        }

        // Update turn state on Result message
        if let SdkMessage::Result {
            ref subtype,
            is_error,
            ..
        } = message
        {
            *turn_state.lock().await = TurnState::TurnComplete {
                result_subtype: subtype.clone(),
                is_error,
            };
        }

        // Send message to caller
        if tx.send(Ok(message)).await.is_err() {
            debug!("receiver dropped, stopping reader loop");
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::StreamExt;
    use tempfile::TempDir;

    use crate::messages::SdkMessage;
    use crate::options::Options;
    use crate::query::query;

    use super::super::test_support::write_mock_cli;
    use super::super::wire::control_request_subtype;

    #[tokio::test]
    async fn close_kills_child_process() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: drain the SDK init handshake and initial user prompt,
        // emit system init, then sleep forever (simulates a long-running process).
        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_close","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
sleep 300
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let options = Options {
            path_to_cli: Some(script_path),
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
    async fn query_handles_permission_request() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: handle initialize, read user prompt, emit a permission request,
        // read the response, then emit result
        let script = r#"#!/bin/sh
read -r INIT_REQ
echo '{"type":"control_response","response":{"subtype":"success","request_id":"init_perm","response":{"pid":9999}}}'
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
    async fn query_responds_to_initialize_control_request_from_cli() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: read init + prompt from SDK, then send its OWN initialize
        // control_request (the CLI sometimes sends this). The SDK must respond
        // so the CLI continues. Then emit system init + result.
        let script = r#"#!/bin/sh
read -r SDK_INIT
read -r USER_PROMPT
echo '{"type":"control_request","request_id":"cli_init_1","request":{"subtype":"initialize"}}'
read -r SDK_RESPONSE
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_clinit","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_clinit","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let options = Options {
            path_to_cli: Some(script_path),
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
