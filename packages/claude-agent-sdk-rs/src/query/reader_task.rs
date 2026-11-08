use std::sync::Arc;

use serde_json::Value;
use tokio::io::BufWriter;
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::error::SdkError;
use crate::messages::{SdkMessage, SystemMessage};
use crate::permissions::CanUseTool;
use crate::transport::CliProcess;
use crate::types::McpServerStatus;

use super::permission_dispatch::{handle_can_use_tool_request, release_permission_wait};
use super::permission_requests::PermissionRequests;
use super::turn_state::TurnState;
use super::wire::{
    build_success_ack, control_cancel_request_id, control_request_subtype, parse_control_response,
    parse_permission_request, write_to_stdin, PendingControl,
};

pub(super) struct ReaderTask {
    pub process: CliProcess,
    pub process_stdin: Arc<Mutex<Option<BufWriter<ChildStdin>>>>,
    pub tx: mpsc::Sender<Result<SdkMessage, SdkError>>,
    pub can_use_tool: Option<Arc<dyn CanUseTool>>,
    pub session_id: Arc<Mutex<Option<String>>>,
    pub mcp_servers: Arc<Mutex<Vec<McpServerStatus>>>,
    pub turn_state: Arc<Mutex<TurnState>>,
    pub pending_control: PendingControl,
    pub permission_requests: PermissionRequests,
    pub cancel_token: Option<CancellationToken>,
    pub kill_rx: mpsc::Receiver<()>,
}

enum ReaderAction {
    Raw(Value),
    Break,
}

enum RawOutcome {
    Continue,
    Break,
}

impl ReaderTask {
    pub async fn run(mut self) {
        while let ReaderAction::Raw(raw) = self.next_action().await {
            if let RawOutcome::Break = self.handle_raw(raw).await {
                break;
            }
        }
    }

    async fn next_action(&mut self) -> ReaderAction {
        tokio::select! {
            result = self.process.read_message() => self.handle_read_result(result).await,
            _ = self.kill_rx.recv() => {
                debug!("kill signal received, terminating CLI process");
                if let Err(e) = self.process.kill().await {
                    warn!("failed to kill CLI process: {e}");
                }
                ReaderAction::Break
            }
            _ = async {
                if let Some(ref token) = self.cancel_token {
                    token.cancelled().await
                } else {
                    std::future::pending().await
                }
            } => {
                warn!("cancel token fired, killing CLI process");
                if let Err(e) = self.process.kill().await {
                    warn!("failed to kill CLI process on cancel: {e}");
                }
                let _ = self.tx.send(Err(SdkError::Cancelled)).await;
                ReaderAction::Break
            }
        }
    }

    async fn handle_read_result(
        &mut self,
        result: Result<Option<Value>, SdkError>,
    ) -> ReaderAction {
        match result {
            Ok(Some(value)) => ReaderAction::Raw(value),
            Ok(None) => {
                let end = self.process.wait_with_stderr().await;
                // A persistent stream-json session only reaches stdout EOF when
                // the CLI ended on its own: a stop or kill through the SDK
                // breaks out before reading on. So anything but exit code 0
                // with an empty stderr is abnormal and surfaces (with stderr),
                // a signal death included (it has no exit code), so the turn
                // never just silently stops.
                if end.is_clean() {
                    info!(code = ?end.code, "CLI process exited cleanly");
                } else {
                    warn!(code = ?end.code, signal = ?end.signal, stderr = %end.stderr, "CLI process exited abnormally; surfacing as error");
                    let _ = self.tx.send(Err(end.into_error())).await;
                }
                ReaderAction::Break
            }
            Err(error) => {
                let _ = self.tx.send(Err(error)).await;
                ReaderAction::Break
            }
        }
    }

    async fn handle_raw(&self, raw: Value) -> RawOutcome {
        if self.handle_control_response(&raw).await {
            return RawOutcome::Continue;
        }
        if self.handle_control_cancel_request(&raw).await {
            return RawOutcome::Continue;
        }
        if let Some(outcome) = self.handle_initialize_request(&raw).await {
            return outcome;
        }
        if self.handle_permission_request(&raw).await {
            return RawOutcome::Continue;
        }
        self.forward_sdk_message(raw).await
    }

    async fn handle_control_response(&self, raw: &Value) -> bool {
        if raw.get("type").and_then(|t| t.as_str()) != Some("control_response") {
            return false;
        }
        let Some(request_id) = raw.pointer("/response/request_id").and_then(|v| v.as_str()) else {
            debug!("received control_response without request_id, skipping");
            return true;
        };
        match self.pending_control.lock().await.remove(request_id) {
            Some(entry) => {
                let outcome = parse_control_response(raw, &entry.subtype);
                let _ = entry.sender.send(outcome);
            }
            None => {
                debug!(
                    request_id,
                    "received control_response with no pending sender, skipping"
                );
            }
        }
        true
    }

    async fn handle_control_cancel_request(&self, raw: &Value) -> bool {
        if raw.get("type").and_then(|t| t.as_str()) != Some("control_cancel_request") {
            return false;
        }
        let Some(request_id) = control_cancel_request_id(raw) else {
            debug!("received control_cancel_request without request_id, skipping");
            return true;
        };

        if self.permission_requests.mark(request_id).await {
            release_permission_wait(&self.turn_state, request_id).await;
        } else {
            debug!(
                request_id,
                "received control_cancel_request for non-active permission request"
            );
        }
        true
    }

    async fn handle_initialize_request(&self, raw: &Value) -> Option<RawOutcome> {
        if control_request_subtype(raw) != Some("initialize") {
            return None;
        }
        let request_id = raw
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        debug!("received initialize control request, responding");
        if let Err(error) =
            write_to_stdin(&self.process_stdin, &build_success_ack(&request_id)).await
        {
            let _ = self.tx.send(Err(error)).await;
            return Some(RawOutcome::Break);
        }
        Some(RawOutcome::Continue)
    }

    async fn handle_permission_request(&self, raw: &Value) -> bool {
        if control_request_subtype(raw) != Some("can_use_tool") {
            return false;
        }
        let request = parse_permission_request(raw);
        debug!(tool = %request.tool_name, "received permission request");
        self.permission_requests.open(&request.tool_use_id).await;
        {
            let mut turn_state = self.turn_state.lock().await;
            // A request after the turn's `result` comes from work that
            // outlived the turn (a background sub-agent): it blocks no turn,
            // and must not make `interrupt` wait for a `result`.
            if !matches!(*turn_state, TurnState::TurnComplete { .. }) {
                *turn_state = TurnState::WaitingForPermission {
                    tool_name: request.tool_name.clone(),
                    tool_use_id: request.tool_use_id.clone(),
                };
            }
        }
        tokio::spawn(handle_can_use_tool_request(
            Arc::clone(&self.process_stdin),
            Arc::clone(&self.turn_state),
            self.permission_requests.clone(),
            self.tx.clone(),
            self.can_use_tool.as_ref().map(Arc::clone),
            request,
        ));
        true
    }

    async fn forward_sdk_message(&self, raw: Value) -> RawOutcome {
        // Infallible: falls back to `Unknown(raw)` (raw payload preserved)
        // and logs internally when the message matches no known schema.
        let message = SdkMessage::from_raw(raw);
        self.capture_session_id(&message).await;
        self.cache_mcp_servers(&message).await;
        self.update_turn_state(&message).await;
        if self.tx.send(Ok(message)).await.is_err() {
            debug!("receiver dropped, stopping reader loop");
            return RawOutcome::Break;
        }
        RawOutcome::Continue
    }

    async fn capture_session_id(&self, message: &SdkMessage) {
        let Some(sid) = message.session_id() else {
            return;
        };
        let mut guard = self.session_id.lock().await;
        if guard.is_none() {
            debug!(session_id = sid, "captured session ID");
            *guard = Some(sid.to_string());
        }
    }

    async fn cache_mcp_servers(&self, message: &SdkMessage) {
        if let SdkMessage::System(SystemMessage::Init {
            mcp_servers: servers,
            ..
        }) = message
        {
            let mut cached = self.mcp_servers.lock().await;
            let init_names = servers
                .iter()
                .map(|server| format!("{}:{}", server.name, server.status))
                .collect::<Vec<_>>();
            let cached_before = cached
                .iter()
                .map(|server| format!("{}:{}", server.name, server.status))
                .collect::<Vec<_>>();
            if !servers.is_empty() || cached.is_empty() {
                *cached = servers.clone();
                info!(
                    init_mcp_count = init_names.len(),
                    init_mcp_servers = ?init_names,
                    cached_before = ?cached_before,
                    "claude mcp: cached MCP servers from system init"
                );
            } else {
                info!(
                    init_mcp_count = 0,
                    cached_before = ?cached_before,
                    "claude mcp: ignored empty system init MCP list because cache is already populated"
                );
            }
        }
    }

    async fn update_turn_state(&self, message: &SdkMessage) {
        let completed = match message {
            SdkMessage::Result {
                subtype, is_error, ..
            } => TurnState::TurnComplete {
                result_subtype: subtype.clone(),
                is_error: *is_error,
            },
            // A `result` that failed to decode still ends the turn; unless the
            // CLI explicitly reported success, treat it as failed.
            SdkMessage::Malformed(malformed) if malformed.is_result() => TurnState::TurnComplete {
                result_subtype: malformed.subtype().unwrap_or("malformed").to_string(),
                is_error: malformed.reported_is_error().unwrap_or(true),
            },
            _ => return,
        };
        *self.turn_state.lock().await = completed;
    }
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;
    use tempfile::TempDir;

    use super::super::test_support::{mock_mcp_servers, write_mock_cli};
    use crate::error::SdkError;
    use crate::messages::SdkMessage;
    use crate::options::Options;
    use crate::query::{query, TurnState};

    /// A `result` whose `subtype` drifted cannot decode, yet the turn is over:
    /// the turn state must still complete (as a failure) instead of staying
    /// "streaming" forever.
    #[tokio::test]
    async fn malformed_result_still_completes_the_turn() {
        let dir = TempDir::new().unwrap();
        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r MCP_REQ; MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p'); printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"result","subtype":{"kind":"success"},"uuid":"u1","session_id":"sess_bad","duration_ms":"later"}'
"#;
        let options = Options {
            path_to_cli: Some(write_mock_cli(dir.path(), script)),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };
        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();

        let mut saw_turn_end = false;
        while let Some(message) = q.next().await {
            if let Ok(message @ SdkMessage::Malformed(_)) = message {
                saw_turn_end |= message.is_turn_complete();
            }
        }

        assert!(saw_turn_end, "the malformed result must reach the consumer");
        assert_eq!(q.session_id().await, Some("sess_bad".to_string()));
        assert!(matches!(
            q.turn_state().await,
            TurnState::TurnComplete { ref result_subtype, is_error: true }
                if result_subtype == "malformed"
        ));
    }

    /// A CLI that completes the handshake and reads the prompt, then runs
    /// `then` (shell) in the middle of its turn.
    async fn cli_mid_turn(dir: &std::path::Path, then: &str) -> crate::Query {
        let script = format!(
            r#"#!/bin/sh
read -r INIT_REQ
read -r MCP_REQ; MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p'); printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"mcpServers":[]}}}}}}\n' "$MCP_ID"
read -r USER_PROMPT
{then}
"#
        );
        let options = Options {
            path_to_cli: Some(write_mock_cli(dir, &script)),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };
        query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap()
    }

    /// Found live: a CLI killed with `kill -9` has no exit code, and was
    /// taken for a clean exit (nothing reported). It must end the stream with
    /// an explicit abnormal end naming the signal.
    #[tokio::test]
    async fn a_signal_death_surfaces_as_an_abnormal_end() {
        let dir = TempDir::new().unwrap();
        let mut q = cli_mid_turn(dir.path(), "kill -9 $$").await;

        let end = tokio::time::timeout(std::time::Duration::from_secs(5), q.next())
            .await
            .expect("the death must end the stream")
            .expect("a terminal item");

        match end {
            Err(error @ SdkError::ProcessSignaled { signal: 9, .. }) => {
                assert!(error.to_string().contains("SIGKILL"), "{error}");
            }
            other => panic!("expected a signal death, got {other:?}"),
        }
        assert!(q.next().await.is_none());
    }

    /// A kill through the SDK (Stop escalation, close) is intended: the
    /// stream ends without reporting the signal it sent.
    #[tokio::test]
    async fn a_kill_through_the_sdk_is_not_an_abnormal_end() {
        let dir = TempDir::new().unwrap();
        let mut q = cli_mid_turn(dir.path(), "exec sleep 30").await;

        q.kill().await;
        let rest = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let mut items = Vec::new();
            while let Some(item) = q.next().await {
                items.push(item);
            }
            items
        })
        .await
        .expect("the kill must end the stream");

        assert!(
            rest.iter().all(Result::is_ok),
            "an intended kill must not surface an error: {rest:?}"
        );
    }

    /// A clean exit (code 0, empty stderr) still ends the stream silently.
    #[tokio::test]
    async fn a_clean_exit_reports_nothing() {
        let dir = TempDir::new().unwrap();
        let mut q = cli_mid_turn(dir.path(), "exit 0").await;

        let end = tokio::time::timeout(std::time::Duration::from_secs(5), q.next())
            .await
            .expect("the exit must end the stream");
        assert!(end.is_none(), "{end:?}");
    }
}
