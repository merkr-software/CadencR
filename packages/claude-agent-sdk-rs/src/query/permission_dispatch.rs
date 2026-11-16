//! Spawned-task handler for the CLI's `can_use_tool` permission requests.
//!
//! Extracted from [`super::reader::reader_loop`] so the reader stays under
//! the 400-line file budget and so this regression-prone path
//! ("don't await the user callback inline") has a focused home.
//!
//! ## Why a separate task
//!
//! The reader loop **must not** await the `CanUseTool` callback inline.
//! Callbacks commonly issue nested control requests of their own — the
//! Cadencr post-`ExitPlanMode` flow calls `set_permission_mode` from
//! inside `can_use_tool` before returning `Allow`. An inline await would
//! freeze the reader loop, and the nested `set_permission_mode` would
//! never see its `control_response`. Mirrors the official Python SDK's
//! `_spawn_control_request_handler`.

use std::sync::Arc;

use tokio::io::BufWriter;
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, warn};

use crate::error::SdkError;
use crate::messages::SdkMessage;
use crate::permissions::{CanUseTool, PermissionRequest};

use super::permission_requests::PermissionRequests;
use super::turn_state::TurnState;
use super::wire::write_to_stdin;

/// Run the `can_use_tool` callback on a spawned task, write the response
/// back to the CLI, and release the turn state's wait on this request.
///
/// Must be called via `tokio::spawn` from the reader loop so the reader
/// stays free to deliver `control_response` messages for nested control
/// requests the callback itself may issue.
pub(super) async fn handle_can_use_tool_request(
    process_stdin: Arc<Mutex<Option<BufWriter<ChildStdin>>>>,
    turn_state: Arc<Mutex<TurnState>>,
    permission_requests: PermissionRequests,
    tx: mpsc::Sender<Result<SdkMessage, SdkError>>,
    can_use_tool: Option<Arc<dyn CanUseTool>>,
    request: PermissionRequest,
) {
    let request_id = request.tool_use_id.clone();
    answer_can_use_tool_request(
        process_stdin,
        turn_state,
        &permission_requests,
        tx,
        can_use_tool,
        request,
    )
    .await;
    permission_requests.close(&request_id).await;
}

async fn answer_can_use_tool_request(
    process_stdin: Arc<Mutex<Option<BufWriter<ChildStdin>>>>,
    turn_state: Arc<Mutex<TurnState>>,
    permission_requests: &PermissionRequests,
    tx: mpsc::Sender<Result<SdkMessage, SdkError>>,
    can_use_tool: Option<Arc<dyn CanUseTool>>,
    request: PermissionRequest,
) {
    let tool_name = request.tool_name.clone();
    let request_id = request.tool_use_id.clone();

    if permission_requests.take(&request_id).await {
        release_permission_wait(&turn_state, &request_id).await;
        return;
    }

    // Surface a serialize failure on `tx` only *after* the deny is written and
    // the turn state is reset — `tx` is bounded, so awaiting it before the deny
    // is written could let a backpressured receiver delay unblocking the turn.
    let mut deferred_error: Option<SdkError> = None;

    let response_value: serde_json::Value = match can_use_tool {
        Some(handler) => {
            let result = handler.can_use_tool(request).await;
            match serde_json::to_value(&result) {
                Ok(v) => v,
                Err(e) => {
                    error!("failed to serialize permission response: {e}");
                    deferred_error = Some(SdkError::SerializationError(e));
                    serde_json::json!({
                        "behavior": "deny",
                        "message": "Cadencr failed to build the permission response; the tool use was denied so the session can continue."
                    })
                }
            }
        }
        None => {
            warn!(
                tool = %tool_name,
                "no canUseTool handler, auto-allowing tool use"
            );
            serde_json::json!({ "behavior": "allow" })
        }
    };

    if permission_requests.take(&request_id).await {
        release_permission_wait(&turn_state, &request_id).await;
        return;
    }

    let response_json = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response_value,
        }
    });

    if let Err(e) = write_to_stdin(&process_stdin, &response_json).await {
        error!(tool = %tool_name, "failed to write permission response to CLI stdin: {e}");
        // The write failed, so the CLI never got an answer — the pipe is almost
        // certainly dead and the process-exit path will surface the real
        // failure. Reset the state first (`WaitingForPermission` would falsely
        // claim the turn is waiting on the user), then surface both the write
        // error and any deferred serialize error — neither may be dropped.
        release_permission_wait(&turn_state, &request_id).await;
        let _ = tx.send(Err(e)).await;
        if let Some(e) = deferred_error {
            let _ = tx.send(Err(e)).await;
        }
        return;
    }

    // Back to agent working — only safe once we've actually written the
    // response, otherwise consumers might race a "still working" state on a
    // turn that's actually waiting on us.
    release_permission_wait(&turn_state, &request_id).await;

    // CLI answered and the state is reset; now it's safe to surface a deferred
    // serialize failure without holding the permission flow open on `tx`.
    if let Some(e) = deferred_error {
        let _ = tx.send(Err(e)).await;
    }
}

/// The CLI has this request's answer: the turn is no longer blocked on it.
/// Only a state still waiting on this very request changes. Anything else is
/// newer: the turn's `result` arrived meanwhile (a background sub-agent can
/// ask after the turn that launched it ended, and a stopped turn can end
/// before its open request is answered), or another request is now open.
/// Flipping those to `AgentWorking` made `interrupt` wait for a `result` that
/// never comes.
pub(super) async fn release_permission_wait(turn_state: &Mutex<TurnState>, request_id: &str) {
    let mut state = turn_state.lock().await;
    if matches!(&*state, TurnState::WaitingForPermission { tool_use_id, .. } if tool_use_id == request_id)
    {
        *state = TurnState::AgentWorking;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::query::permission_requests::PermissionRequests;

    use futures::StreamExt;
    use tempfile::TempDir;
    use tokio::sync::{oneshot, Notify};

    /// Regression test for the stranded-permission freeze.
    ///
    /// If writing the permission response to the CLI fails (dead pipe,
    /// closed stdin), the turn state used to stay `WaitingForPermission`
    /// forever: consumers reported the turn as waiting on the user while the
    /// CLI was actually gone — a session frozen with no error anywhere. The
    /// dispatch must surface the error on the stream AND flip the turn state
    /// back so the process-exit path can end the turn visibly.
    #[tokio::test]
    async fn write_failure_surfaces_error_and_does_not_strand_turn_state() {
        use crate::error::SdkError;
        use crate::query::turn_state::TurnState;

        // `None` stdin makes `write_to_stdin` fail deterministically
        // (`SdkError::InputClosed`) — the same shape as a dead pipe.
        let process_stdin = Arc::new(tokio::sync::Mutex::new(None));
        let turn_state = Arc::new(tokio::sync::Mutex::new(TurnState::WaitingForPermission {
            tool_name: "Write".to_string(),
            tool_use_id: "toolu_dead".to_string(),
        }));
        let permission_requests = PermissionRequests::default();
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);

        super::handle_can_use_tool_request(
            Arc::clone(&process_stdin),
            Arc::clone(&turn_state),
            permission_requests,
            tx,
            None, // no handler -> auto-allow path; the write is what fails
            PermissionRequest {
                tool_name: "Write".to_string(),
                input: serde_json::json!({}),
                tool_use_id: "toolu_dead".to_string(),
                agent_id: None,
                suggestions: None,
                blocked_path: None,
                decision_reason: None,
            },
        )
        .await;

        assert!(
            matches!(rx.recv().await, Some(Err(SdkError::InputClosed))),
            "the write failure must surface on the message stream"
        );
        assert!(
            matches!(&*turn_state.lock().await, TurnState::AgentWorking),
            "turn state must not stay WaitingForPermission after a failed write"
        );
    }

    use crate::messages::SdkMessage;
    use crate::options::Options;
    use crate::permissions::{CanUseTool, PermissionMode, PermissionRequest, PermissionResult};
    use crate::query::query;

    use super::super::test_support::{mock_mcp_servers, write_mock_cli};

    /// Regression test for the post-`ExitPlanMode` deadlock.
    ///
    /// Before the spawn-based callback dispatch (this module), calling
    /// `set_permission_mode` from inside `can_use_tool` deadlocked: the
    /// reader loop was blocked awaiting the callback, so the
    /// `control_response` for the nested `set_permission_mode` could never
    /// be delivered, and `set_permission_mode` timed out. The Cadencr WS
    /// handler (`bridge.rs::transition_to_post_plan_mode`) issues exactly
    /// that nested call before returning `Allow` from `can_use_tool`.
    #[tokio::test]
    async fn set_permission_mode_from_inside_can_use_tool_does_not_deadlock() {
        let dir = TempDir::new().unwrap();
        let script_path = write_mock_cli(dir.path(), deadlock_regression_script());

        // Synchronization between the test main task and the callback.
        let entered = Arc::new(Notify::new());
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let release_rx = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));

        let handler: Arc<dyn CanUseTool> = Arc::new(GatedHandler {
            entered: Arc::clone(&entered),
            release_rx,
        });

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            can_use_tool: Some(handler),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();

        // Wait until the callback is actually executing on its spawned task.
        // Cap the wait so a regression manifests as a test failure rather
        // than a hang.
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .expect("can_use_tool callback should be entered within 5s");

        // The very thing the bug used to deadlock on: issue a nested
        // control_request from the test task while the callback is
        // mid-flight. With the spawn-based dispatch, the reader loop is
        // free to deliver the response, so this resolves quickly.
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            q.set_permission_mode(PermissionMode::AcceptEdits),
        )
        .await
        .expect("nested set_permission_mode must not deadlock")
        .expect("set_permission_mode must succeed");

        // Let the callback return Allow so the mock CLI can finish.
        let _ = release_tx.send(());

        // Drain the rest of the stream and confirm we got the Result.
        let mut messages = Vec::new();
        while let Some(msg) = q.next().await {
            messages.push(msg.unwrap());
        }
        assert!(
            messages
                .iter()
                .any(|m| matches!(m, SdkMessage::Result { .. })),
            "expected Result message, got {messages:?}"
        );
    }

    struct GatedHandler {
        entered: Arc<Notify>,
        release_rx: Arc<tokio::sync::Mutex<Option<oneshot::Receiver<()>>>>,
    }

    #[async_trait::async_trait]
    impl CanUseTool for GatedHandler {
        async fn can_use_tool(&self, request: PermissionRequest) -> PermissionResult {
            self.entered.notify_one();
            if let Some(rx) = self.release_rx.lock().await.take() {
                let _ = rx.await;
            }
            PermissionResult::Allow {
                updated_input: request.input,
                updated_permissions: None,
                tool_use_id: Some(request.tool_use_id),
            }
        }
    }

    fn deadlock_regression_script() -> &'static str {
        r#"#!/bin/sh
set -e
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$INIT_ID"
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_dl","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"plan","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"control_request","request_id":"req_exit_plan","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"do stuff"}}}'
read -r NESTED_REQ
NESTED_ID=$(printf '%s' "$NESTED_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$NESTED_ID"
read -r ALLOW_RESPONSE
echo '{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_dl","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
"#
    }
}
