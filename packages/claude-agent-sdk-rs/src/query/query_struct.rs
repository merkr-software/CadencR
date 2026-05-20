//! The [`Query`] handle: lifecycle, accessors, and the `Stream` impl.
//!
//! Control-protocol methods (`set_permission_mode`, `set_model`, …) live
//! in [`super::control_commands`]. The background reader task that feeds
//! the message channel lives in [`super::reader`]. The top-level
//! constructor [`query`](super::spawn::query) builds this struct via
//! [`Query::new`].

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

    /// Current turn state.
    pub(super) turn_state: Arc<Mutex<TurnState>>,

    /// In-flight `control_request`s awaiting a matching `control_response`.
    /// Keyed by `request_id`. The reader loop owns the receive side of each
    /// oneshot and resolves it when a `control_response` with the same id
    /// arrives. Shared with the reader loop via `Arc`.
    pub(super) pending_control: PendingControl,

    /// Monotonic counter used to mint unique `request_id`s for outbound
    /// control requests. Mirrors the Python SDK's `f"req_{ctr}_{rand}"`
    /// pattern; the random suffix is added at call site.
    pub(super) control_request_counter: Arc<AtomicU64>,

    /// Background reader task handle (for cleanup).
    pub(super) reader_task: Option<tokio::task::JoinHandle<()>>,

    /// Channel to signal the reader task to send SIGINT to the CLI process.
    pub(super) interrupt_tx: mpsc::Sender<()>,

    /// Channel to signal the reader task to gracefully kill the CLI process.
    pub(super) kill_tx: mpsc::Sender<()>,

    /// Cancellation token.
    pub(super) _cancel_token: Option<CancellationToken>,

    /// PID of the CLI subprocess (captured at spawn time).
    pub(super) pid: Option<u32>,
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

    /// Get the current turn state.
    pub async fn turn_state(&self) -> TurnState {
        self.turn_state.lock().await.clone()
    }

    /// Interrupt the agent (SIGINT). The CLI will finish its current turn
    /// and emit a `Result` message. The session can be resumed later.
    ///
    /// The signal is routed through a channel to the background reader task,
    /// which owns the `CliProcess` and calls its `interrupt()` method.
    /// This avoids caching a stale PID (the process could have exited and
    /// the PID could have been reused by the OS).
    pub async fn interrupt(&self) -> Result<(), SdkError> {
        self.interrupt_tx
            .send(())
            .await
            .map_err(|_| SdkError::InputClosed)?;
        Ok(())
    }

    /// Get the PID of the CLI subprocess (captured at spawn time).
    /// Returns `None` for test stubs or if the process had no PID.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Gracefully kill the child process (SIGTERM → wait 5s → SIGKILL) and
    /// stop the background reader task.
    ///
    /// After this call the stream will end.
    pub async fn close(&mut self) {
        // Signal the reader loop to kill the child process.
        let _ = self.kill_tx.send(()).await;

        // Wait for the reader task to finish (it will break after killing).
        if let Some(task) = self.reader_task.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), task).await;
        }

        // Drop stdin for good measure.
        self.process_stdin.lock().await.take();
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
        let (interrupt_tx, _interrupt_rx) = mpsc::channel(1);
        let (kill_tx, _kill_rx) = mpsc::channel(1);
        Self {
            message_rx,
            process_stdin: Arc::new(Mutex::new(None)),
            session_id: Arc::new(Mutex::new(session_id)),
            turn_state: Arc::new(Mutex::new(TurnState::AgentWorking)),
            pending_control: Arc::new(Mutex::new(HashMap::new())),
            control_request_counter: Arc::new(AtomicU64::new(0)),
            reader_task: None,
            interrupt_tx,
            kill_tx,
            _cancel_token: None,
            pid: None,
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

    use super::super::test_support::write_mock_cli;

    #[tokio::test]
    async fn query_stream_from_mock_cli() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: drain the SDK init handshake and initial user prompt,
        // then emit a system init, a stream event, and a result.
        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_123","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"stream_event","uuid":"u2","session_id":"sess_123","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}'
echo '{"type":"result","subtype":"success","uuid":"u3","session_id":"sess_123","duration_ms":100,"duration_api_ms":80,"is_error":false,"num_turns":1,"result":"Hello","errors":null,"stop_reason":"end_turn","total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
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
    async fn take_message_rx_drains_stream_and_receiver_works() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: drain the SDK init handshake and initial user prompt,
        // then emit system init and a result.
        let script = r#"#!/bin/sh
read -r INIT_REQ
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_take","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_take","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let options = Options {
            path_to_cli: Some(script_path),
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
