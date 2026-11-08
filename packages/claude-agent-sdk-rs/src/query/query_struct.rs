//! The [`Query`] handle: lifecycle, accessors, and the `Stream` impl.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::task::{Context, Poll};

use futures::Stream;
use tokio::io::BufWriter;
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::error::SdkError;
use crate::messages::SdkMessage;
use crate::types::McpServerStatus;

use super::turn_state::TurnState;
use super::wire::PendingControl;

/// A running Claude Code CLI query with streaming output and turn management.
///
/// `Query` implements [`Stream<Item = Result<SdkMessage, SdkError>>`] —
/// consume it with `while let Some(msg) = query.next().await { ... }`.
///
/// # Architecture
///
/// A background tokio task reads from the CLI process stdout, handles
/// permission requests internally (calling the `CanUseTool` handler and
/// writing responses back to stdin), and forwards all other messages
/// through an mpsc channel. This keeps the Stream interface clean while
/// supporting the blocking permission protocol.
///
/// # Turn management
///
/// Check [`turn_state()`](Query::turn_state) to determine the current state:
/// - `AgentWorking` — Claude is streaming
/// - `TurnComplete` — CLI sent a `Result` message, turn is over
/// - `WaitingForPermission` — blocked on `canUseTool` callback
pub struct Query {
    /// Channel receiving parsed SdkMessages from the background task.
    pub(super) message_rx: mpsc::Receiver<Result<SdkMessage, SdkError>>,

    /// Handle to write to CLI stdin (for stream_input, control commands).
    pub(super) process_stdin: Arc<Mutex<Option<BufWriter<ChildStdin>>>>,

    /// Session ID captured from System init message.
    pub(super) session_id: Arc<Mutex<Option<String>>>,

    /// MCP server statuses captured from the System init message.
    pub(super) mcp_servers: Arc<Mutex<Vec<McpServerStatus>>>,

    /// MCP servers discovered from Claude configuration before session init.
    pub(super) configured_mcp_servers: Vec<McpServerStatus>,

    /// Current turn state.
    pub(super) turn_state: Arc<Mutex<TurnState>>,

    /// In-flight `control_request`s awaiting a matching `control_response`.
    pub(super) pending_control: PendingControl,

    /// Monotonic counter used to mint unique outbound `request_id`s.
    pub(super) control_request_counter: Arc<AtomicU64>,

    /// Background reader task handle (for cleanup).
    pub(super) reader_task: Option<tokio::task::JoinHandle<()>>,

    /// Channel to signal the reader task to gracefully kill the CLI process.
    pub(super) kill_tx: mpsc::Sender<()>,

    /// Cancellation token.
    pub(super) _cancel_token: Option<CancellationToken>,

    /// PID of the CLI subprocess (captured at spawn time).
    pub(super) pid: Option<u32>,

    /// Cancelled once the reader has let go of the CLI process.
    pub(super) process_ended: CancellationToken,
}

impl Stream for Query {
    type Item = Result<SdkMessage, SdkError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.message_rx.poll_recv(cx)
    }
}

impl Query {
    /// Take the message receiver out of the query.
    ///
    /// This is useful when you need to read messages independently of other
    /// Query operations (e.g. to avoid holding a mutex while awaiting messages).
    /// After calling this, the `Stream` impl will always return `None`.
    pub fn take_message_rx(&mut self) -> mpsc::Receiver<Result<SdkMessage, SdkError>> {
        let (_, dummy_rx) = mpsc::channel(1);
        std::mem::replace(&mut self.message_rx, dummy_rx)
    }

    /// Get the session ID (captured from System init message).
    pub async fn session_id(&self) -> Option<String> {
        self.session_id.lock().await.clone()
    }

    /// Get MCP server statuses available in the current Claude Code session.
    pub async fn available_mcp_servers(&self) -> Result<Vec<McpServerStatus>, SdkError> {
        let known_servers = self.cached_or_configured_mcp_servers().await;
        if !known_servers.is_empty() {
            tracing::info!(
                mcp_count = known_servers.len(),
                "claude mcp: available_mcp_servers returning cached/configured servers"
            );
            return Ok(known_servers);
        }
        tracing::info!("claude mcp: no cached/configured servers, querying live mcp_status");
        let live_servers = self.mcp_server_status().await?;
        if live_servers.is_empty() {
            tracing::info!("claude mcp: live mcp_status returned no servers");
            return Ok(known_servers);
        }
        tracing::info!(
            mcp_count = live_servers.len(),
            "claude mcp: available_mcp_servers returning live servers"
        );
        Ok(live_servers)
    }

    async fn cached_or_configured_mcp_servers(&self) -> Vec<McpServerStatus> {
        let cached_servers = self.mcp_servers.lock().await.clone();
        if cached_servers.is_empty() {
            return self.configured_mcp_servers.clone();
        }
        cached_servers
    }

    /// Get the current turn state.
    pub async fn turn_state(&self) -> TurnState {
        self.turn_state.lock().await.clone()
    }

    /// Get the PID of the CLI subprocess (captured at spawn time).
    /// Returns `None` for test stubs or if the process had no PID.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Resolves once the CLI process is gone: it exited and was waited on, or
    /// it was sent SIGKILL because the query was dropped. Whatever it leaves
    /// behind (its process group, see
    /// [`Options::own_process_group`](crate::Options::own_process_group)) can
    /// be cleaned up from then on. Resolves at once for a stub.
    pub fn process_exited(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        self.process_ended.clone().cancelled_owned()
    }

    /// Gracefully kill the child process (SIGTERM → wait 5s → SIGKILL) and
    /// stop the background reader task.
    ///
    /// After this call the stream will end.
    pub async fn close(&mut self) {
        self.kill().await;

        // Wait for the reader task to finish (it will break after killing).
        if let Some(task) = self.reader_task.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), task).await;
        }

        // Drop stdin for good measure.
        self.process_stdin.lock().await.take();
    }

    /// Kill the child process without waiting for it, through a shared
    /// handle. The stream ends once the reader has stopped it; use
    /// [`close`](Query::close) to also wait for that.
    pub async fn kill(&self) {
        let _ = self.kill_tx.send(()).await;
    }

    /// Close stdin (no more user input). The CLI will finish its current
    /// turn and exit.
    pub async fn close_input(&self) -> Result<(), SdkError> {
        self.process_stdin.lock().await.take();
        Ok(())
    }

    /// Create a stub `Query` for testing (no real CLI process).
    /// The returned `Query` has the given `session_id` pre-set and a dummy
    /// message channel that will never produce messages.
    #[doc(hidden)]
    pub fn new_test_stub(session_id: Option<String>) -> Self {
        let (msg_tx, message_rx) = mpsc::channel(1);
        drop(msg_tx); // close immediately so stream_input will fail
        let (kill_tx, _kill_rx) = mpsc::channel(1);
        let process_ended = CancellationToken::new();
        process_ended.cancel();
        Self {
            message_rx,
            process_stdin: Arc::new(Mutex::new(None)),
            session_id: Arc::new(Mutex::new(session_id)),
            mcp_servers: Arc::new(Mutex::new(Vec::new())),
            configured_mcp_servers: Vec::new(),
            turn_state: Arc::new(Mutex::new(TurnState::AgentWorking)),
            pending_control: Arc::new(Mutex::new(HashMap::new())),
            control_request_counter: Arc::new(AtomicU64::new(0)),
            reader_task: None,
            kill_tx,
            _cancel_token: None,
            pid: None,
            process_ended,
        }
    }
}

impl Drop for Query {
    fn drop(&mut self) {
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::options::Options;
    use crate::query::query;
    use futures::StreamExt;
    use tempfile::TempDir;

    use super::super::test_support::{mock_mcp_servers, write_mock_cli};

    #[tokio::test]
    async fn query_stream_from_mock_cli() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: drain the SDK init handshake and initial user prompt,
        // then emit a system init, a stream event, and a result.
        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r MCP_REQ; MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p'); printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_123","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"stream_event","uuid":"u2","session_id":"sess_123","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}'
echo '{"type":"result","subtype":"success","uuid":"u3","session_id":"sess_123","duration_ms":100,"duration_api_ms":80,"is_error":false,"num_turns":1,"result":"Hello","errors":null,"stop_reason":"end_turn","total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
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

        // Should get: System(Init), StreamEvent, Result
        assert!(messages.len() >= 3, "got {} messages", messages.len());

        // Verify session_id was captured
        let sid = q.session_id().await;
        assert_eq!(sid, Some("sess_123".to_string()));

        // Verify turn state is TurnComplete
        let state = q.turn_state().await;
        assert!(matches!(
            state,
            TurnState::TurnComplete {
                ref result_subtype,
                is_error: false,
            } if result_subtype == "success"
        ));
    }

    #[tokio::test]
    async fn query_caches_mcp_servers_from_system_init() {
        let dir = TempDir::new().unwrap();

        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r MCP_REQ; MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p'); printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_mcp","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[{"name":"cadencr-session","status":"connected"},{"name":"filesystem","status":"unavailable"}],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_mcp","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
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
        q.next().await.expect("init message").unwrap();

        let servers = q.available_mcp_servers().await.unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "cadencr-session");
        assert_eq!(servers[0].status, "connected");
        assert_eq!(servers[1].name, "filesystem");
        assert_eq!(servers[1].status, "unavailable");
        q.close().await;
    }

    #[tokio::test]
    async fn query_falls_back_to_configured_mcp_servers_when_init_reports_none() {
        let dir = TempDir::new().unwrap();

        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r MCP_REQ; MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p'); printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_cfg","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_cfg","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
"#;
        let script_path = write_mock_cli(dir.path(), script);
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"chrome-devtools":{"command":"npx","args":["chrome-devtools-mcp@latest"]}}}"#,
        )
        .unwrap();

        let options = Options {
            cwd: dir.path().to_path_buf(),
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();
        q.next().await.expect("init message").unwrap();

        let servers = q.available_mcp_servers().await.unwrap();
        let server = servers
            .iter()
            .find(|server| server.name == "chrome-devtools")
            .expect("project server");
        assert_eq!(server.status, "configured");
        q.close().await;
    }

    #[tokio::test]
    async fn take_message_rx_drains_stream_and_receiver_works() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: drain the SDK init handshake and initial user prompt,
        // then emit system init and a result.
        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r MCP_REQ; MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p'); printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_take","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_take","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            replay_user_messages: false,
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();

        // Take the receiver out
        let mut rx = q.take_message_rx();

        // After take, Stream impl should return None
        let stream_result = q.next().await;
        assert!(
            stream_result.is_none(),
            "stream should return None after take_message_rx"
        );

        // The taken receiver should still get messages
        let mut messages = Vec::new();
        while let Some(msg) = rx.recv().await {
            messages.push(msg.unwrap());
        }

        assert!(
            messages.len() >= 2,
            "receiver should get messages, got {}",
            messages.len()
        );
    }
}
