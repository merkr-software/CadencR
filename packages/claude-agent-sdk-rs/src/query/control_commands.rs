//! Control-protocol methods on [`Query`] — `set_permission_mode`,
//! `set_model`, `set_mcp_servers`, plus the shared
//! `send_control_request` round-trip helper and `stream_input` for user
//! messages.
//!
//! These methods all speak the CLI's bidirectional `control_request` /
//! `control_response` protocol (see [`super::wire`]). The reader loop
//! ([`super::reader`]) is responsible for matching responses back to the
//! oneshot senders this module registers in `pending_control`.

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use tokio::sync::oneshot;

use crate::error::SdkError;
use crate::mcp::McpServerConfig;
use crate::permissions::PermissionMode;

use super::query_struct::Query;
use super::turn_state::TurnState;
use super::wire::{write_to_stdin, ControlOutcome, PendingControlEntry, CONTROL_REQUEST_TIMEOUT};

impl Query {
    /// Send a user message for multi-turn interaction.
    ///
    /// Only valid when `turn_state()` is `TurnComplete` (for session agents).
    /// This writes a `user` message to CLI stdin and resets the turn state
    /// to `AgentWorking`.
    pub async fn stream_input(&self, content: serde_json::Value) -> Result<(), SdkError> {
        self.stream_input_with_uuid(content, None).await
    }

    /// [`stream_input`](Query::stream_input) with a client `uuid` on the
    /// message. The CLI then reports its fate in `command_lifecycle` frames,
    /// and [`cancel_async_message`](Query::cancel_async_message) can withdraw
    /// it while it waits in the CLI's queue.
    pub async fn stream_input_with_uuid(
        &self,
        content: serde_json::Value,
        uuid: Option<&str>,
    ) -> Result<(), SdkError> {
        let session_id = self.session_id.lock().await.clone().unwrap_or_default();

        let mut msg = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "parent_tool_use_id": null,
            "session_id": session_id
        });
        if let Some(uuid) = uuid {
            msg["uuid"] = serde_json::Value::String(uuid.to_string());
        }

        // Working from before the write: set after it, a fast `result` read
        // meanwhile would be overwritten and the finished turn would look open.
        let previous =
            std::mem::replace(&mut *self.turn_state.lock().await, TurnState::AgentWorking);
        if let Err(error) = write_to_stdin(&self.process_stdin, &msg).await {
            let mut turn_state = self.turn_state.lock().await;
            if *turn_state == TurnState::AgentWorking {
                *turn_state = previous;
            }
            return Err(error);
        }
        Ok(())
    }

    /// Withdraw a user message sent with `uuid` that still waits in the
    /// CLI's queue. `Ok(false)`: it was not waiting (a turn already took it
    /// in, or the CLI never got it), so it stays with that turn.
    pub async fn cancel_async_message(&self, uuid: &str) -> Result<bool, SdkError> {
        let response = self
            .send_control_request(serde_json::json!({
                "subtype": "cancel_async_message",
                "message_uuid": uuid,
            }))
            .await?;
        Ok(response
            .get("cancelled")
            .and_then(serde_json::Value::as_bool)
            == Some(true))
    }

    /// Change the active model. The CLI applies the new model on the next
    /// user turn (the in-flight turn keeps the model it started with);
    /// awaits the matching `control_response` so the caller learns whether
    /// the CLI accepted the change.
    pub async fn set_model(&self, model: &str) -> Result<(), SdkError> {
        self.send_control_request(serde_json::json!({
            "subtype": "set_model",
            "model": model,
        }))
        .await
        .map(|_| ())
    }

    /// Change the permission mode mid-session. Per the Claude Agent SDK
    /// docs, the new mode "takes effect immediately for all subsequent
    /// tool requests", so this is the right surface for both mid-turn
    /// chip switches and the post-`ExitPlanMode` build-mode swap.
    ///
    /// Awaits the CLI's `control_response`; surfaces
    /// `SdkError::ControlRequestFailed` if the CLI rejected the request,
    /// `SdkError::Timeout` if no response arrived within the round-trip
    /// window. Callers (e.g. the Cadencr WS handler) MUST gate any
    /// "applied" UI on `Ok(())` to avoid lying about CLI state.
    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), SdkError> {
        self.send_control_request(serde_json::json!({
            "subtype": "set_permission_mode",
            "mode": mode.as_cli_flag(),
        }))
        .await
        .map(|_| ())
    }

    /// Hot-swap the MCP server set mid-session.
    pub async fn set_mcp_servers(
        &self,
        servers: HashMap<String, McpServerConfig>,
    ) -> Result<(), SdkError> {
        self.send_control_request(serde_json::json!({
            "subtype": "set_mcp_servers",
            "mcp_servers": servers,
        }))
        .await
        .map(|_| ())
    }

    /// Send a `control_request` to the CLI and await its matching
    /// `control_response`. Canonical envelope used by every Claude Agent
    /// SDK; the CLI silently drops anything else (this was the source of
    /// the prior fire-and-forget `set_permission_mode` bug). See
    /// <https://github.com/anthropics/claude-agent-sdk-python> for the
    /// reference implementation.
    ///
    /// `request` is the inner object and MUST include a `subtype` field;
    /// the `type` + `request_id` envelope is added here.
    pub(super) async fn send_control_request(
        &self,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, SdkError> {
        self.send_control_request_with_timeout(request, CONTROL_REQUEST_TIMEOUT)
            .await
    }

    pub(super) async fn send_control_request_with_timeout(
        &self,
        request: serde_json::Value,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, SdkError> {
        let subtype = request
            .get("subtype")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let request_id = self.next_control_request_id(&subtype);

        let (tx, rx) = oneshot::channel::<ControlOutcome>();
        self.pending_control.lock().await.insert(
            request_id.clone(),
            PendingControlEntry {
                subtype,
                sender: tx,
            },
        );

        let envelope = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": request,
        });

        if let Err(e) = write_to_stdin(&self.process_stdin, &envelope).await {
            // Drop the pending entry so memory doesn't leak; the oneshot
            // sender goes out of scope and the receiver will see a closed
            // channel if anyone else looks at it.
            self.pending_control.lock().await.remove(&request_id);
            return Err(e);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_recv_err)) => {
                // Sender dropped without resolving — the reader loop must
                // have exited (process gone, channel closed, …).
                Err(SdkError::Cancelled)
            }
            Err(_elapsed) => {
                // Pull the entry so a late response doesn't try to resolve
                // a defunct sender.
                self.pending_control.lock().await.remove(&request_id);
                Err(SdkError::Timeout)
            }
        }
    }

    /// Mint a fresh `request_id` for an outbound control request.
    /// Pattern mirrors the official Python SDK: `req_{counter}_{rand}`.
    fn next_control_request_id(&self, subtype: &str) -> String {
        let counter = self.control_request_counter.fetch_add(1, Ordering::Relaxed);
        // Cheap per-process randomness — nanoseconds of system time fit
        // in 32 bits often enough; we just need uniqueness across
        // concurrent sends within a single Query.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        format!("req_{counter}_{subtype}_{nanos:08x}")
    }
}

#[cfg(test)]
mod tests {
    use crate::options::Options;
    use crate::permissions::PermissionMode;
    use crate::query::query;
    use crate::SdkError;
    use futures::StreamExt;
    use tempfile::TempDir;

    use super::super::test_support::{mock_mcp_servers, write_mock_cli};

    /// Drive a real `Query` against a mock CLI shell script and confirm:
    ///   1. `set_permission_mode` writes the documented `control_request`
    ///      envelope (`type`, `request_id`, `request.subtype`,
    ///      `request.mode`) — captured via tee on the mock CLI.
    ///   2. The returned `Ok(())` is gated on a matching
    ///      `control_response` with `subtype: "success"`.
    #[tokio::test]
    async fn set_permission_mode_round_trip_writes_documented_envelope() {
        let dir = TempDir::new().unwrap();
        let captured_path = dir.path().join("captured.json");

        // Mock CLI:
        //   1. consume our `initialize` request, ack it.
        //   2. consume the user prompt line.
        //   3. emit a `system.init`.
        //   4. read the NEXT control_request (will be set_permission_mode);
        //      tee it to the captured file and reply success.
        //   5. block on read so the process stays alive until the test
        //      explicitly drops `Query` (which kills the child).
        let script = format!(
            r#"#!/bin/sh
set -e
CAPTURED='{}'
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{}}}}}}\n' "$INIT_ID"
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"mcpServers":[]}}}}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_mode","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"plan","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}}'
read -r MODE_REQ
printf '%s' "$MODE_REQ" > "$CAPTURED"
MODE_ID=$(printf '%s' "$MODE_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{}}}}}}\n' "$MODE_ID"
read -r DUMMY
"#,
            captured_path.display()
        );
        let script_path = write_mock_cli(dir.path(), &script);

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();

        // Drain the system.init so the reader loop is past it before we
        // call set_permission_mode (the call doesn't actually need this,
        // but it makes the test deterministic about the script's read order).
        let _init_msg = q.next().await.expect("init message");

        // The actual round-trip we're testing:
        q.set_permission_mode(PermissionMode::AcceptEdits)
            .await
            .expect("set_permission_mode must succeed");

        // Tear down so the script's final `read` returns and the captured
        // file is fully flushed.
        q.close().await;

        let captured_raw = std::fs::read_to_string(&captured_path).expect("captured envelope");
        let captured: serde_json::Value =
            serde_json::from_str(captured_raw.trim()).expect("captured envelope is JSON");

        assert_eq!(captured["type"], "control_request");
        assert!(
            captured["request_id"].is_string(),
            "expected request_id, got {captured:?}"
        );
        assert_eq!(captured["request"]["subtype"], "set_permission_mode");
        assert_eq!(captured["request"]["mode"], "acceptEdits");
    }

    /// A queued follow-up carries its client `uuid`, and `cancel_async_message`
    /// withdraws it by that uuid, reading the CLI's `cancelled` answer.
    #[tokio::test]
    async fn a_uuid_message_is_withdrawn_by_cancel_async_message() {
        let dir = TempDir::new().unwrap();
        let captured_input = dir.path().join("input.json");
        let captured_cancel = dir.path().join("cancel.json");
        let script = format!(
            r#"#!/bin/sh
set -e
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{}}}}}}\n' "$INIT_ID"
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"mcpServers":[]}}}}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_q","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}}'
read -r FOLLOW_UP
printf '%s' "$FOLLOW_UP" > '{input}'
read -r CANCEL_REQ
printf '%s' "$CANCEL_REQ" > '{cancel}'
CANCEL_ID=$(printf '%s' "$CANCEL_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"cancelled":true}}}}}}\n' "$CANCEL_ID"
read -r DUMMY
"#,
            input = captured_input.display(),
            cancel = captured_cancel.display(),
        );
        let script_path = write_mock_cli(dir.path(), &script);
        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };
        let mut q = query(serde_json::Value::String("first".into()), options)
            .await
            .unwrap();
        let _init_msg = q.next().await.expect("init message");

        q.stream_input_with_uuid(serde_json::json!("again"), Some("follow-1"))
            .await
            .unwrap();
        assert!(q.cancel_async_message("follow-1").await.unwrap());
        q.close().await;

        let input: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&captured_input).unwrap()).unwrap();
        assert_eq!(input["type"], "user");
        assert_eq!(input["uuid"], "follow-1");
        let cancel: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&captured_cancel).unwrap()).unwrap();
        assert_eq!(cancel["request"]["subtype"], "cancel_async_message");
        assert_eq!(cancel["request"]["message_uuid"], "follow-1");
    }

    /// CLI-reported error → `SdkError::ControlRequestFailed`. Gates the
    /// no-optimistic-updates guarantee — backend must NOT broadcast
    /// `mode.changed` if the CLI rejected the request.
    #[tokio::test]
    async fn set_permission_mode_returns_error_on_cli_error_response() {
        let dir = TempDir::new().unwrap();

        let script = r#"#!/bin/sh
set -e
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$INIT_ID"
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_err","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"plan","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
read -r MODE_REQ
MODE_ID=$(printf '%s' "$MODE_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"unsupported mode"}}\n' "$MODE_ID"
read -r DUMMY
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
        let _init_msg = q.next().await.expect("init message");

        let err = q
            .set_permission_mode(PermissionMode::AcceptEdits)
            .await
            .expect_err("CLI rejection must surface");
        match err {
            SdkError::ControlRequestFailed { subtype, message } => {
                assert_eq!(
                    subtype, "set_permission_mode",
                    "subtype must be the outbound command so callers can branch on it"
                );
                assert!(
                    message.contains("unsupported mode"),
                    "expected CLI's message to surface, got: {message}"
                );
            }
            other => panic!("expected ControlRequestFailed, got {other:?}"),
        }

        q.close().await;
    }

    /// Silent CLI (no `control_response`) → `SdkError::Timeout` after
    /// `CONTROL_REQUEST_TIMEOUT`. This is the exact failure the wire
    /// format bug used to *hide*: the SDK returned `Ok` while the CLI
    /// silently dropped the message. Now it surfaces as a real error.
    #[tokio::test(start_paused = true)]
    async fn set_permission_mode_times_out_when_no_response() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: ack init, emit system.init, then go silent.
        let script = r#"#!/bin/sh
set -e
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$INIT_ID"
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_to","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"plan","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
read -r DUMMY
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
        let _init_msg = q.next().await.expect("init message");

        // Tokio's paused-time runtime auto-advances when all tasks are
        // sleeping, so the timeout fires without a real 5s wall wait.
        let err = q
            .set_permission_mode(PermissionMode::AcceptEdits)
            .await
            .expect_err("silent CLI must time out");
        assert!(
            matches!(err, SdkError::Timeout),
            "expected Timeout, got {err:?}"
        );

        q.close().await;
    }
}
