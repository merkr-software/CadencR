//! Shared PTY-streaming machinery for `commit` and `push`.
//!
//! Both operations follow the same pipeline:
//!   1. Snapshot WS subscribers for the feature once up front.
//!   2. Spin up an mpsc channel that the PTY reader writes chunks into.
//!   3. Fanout task drains that channel and broadcasts each chunk as a
//!      `<op>.output` envelope to the snapshotted senders.
//!   4. Emit a `<op>.start` envelope, push a synthetic header line into
//!      the channel so the dialog has something to render immediately,
//!      run the operation, then emit a `<op>.complete` envelope.
//!
//! This module owns steps (1)–(4) generically; callers supply only:
//!   - the operation name (used as the WS `action` prefix),
//!   - the synthetic header line,
//!   - the closure that actually runs the PTY-backed git command.
//!
//! The pre-extraction `commit_push.rs` / `push.rs` versions of this logic
//! were byte-for-byte equivalent except for the action string and header
//! text — keep them in lock-step here so a change to the envelope shape
//! (e.g. adding a field) lands on both surfaces simultaneously.

use crate::shared::discard::{cleanup, IgnoreClosed};
use std::future::Future;

use axum::extract::ws::Message;
use tokio::sync::mpsc;

use crate::app_state::AppState;
use crate::domain::git::watcher::GitWatcherRegistry;
use crate::domain::ws_session::protocol::WsEnvelope;
use crate::error::AppError;

/// Outcome of a streamed git operation. The caller turns this into the
/// HTTP response body and the `<op>.complete` envelope payload. The
/// snapshotted senders are returned so the caller can broadcast the
/// terminal envelope to the *same* subscriber set that received the
/// streaming output (no late-joiner re-snapshot).
pub(super) struct StreamedOperation {
    pub success: bool,
    pub error: Option<String>,
    pub senders: Vec<mpsc::UnboundedSender<Message>>,
}

/// Run a PTY-streamed git operation end-to-end with WS broadcasting.
///
/// `op` is the WS action prefix (`"commit"` → `commit.start`, `commit.output`,
/// later `commit.complete`). `header` is a synthetic stdout line broadcast
/// before the real PTY produces anything, so the dialog renders immediately.
/// `run` receives the chunk sender and returns the underlying git result —
/// it should call `commands::commit_streaming` / `push_streaming` (or any
/// future PTY-backed op).
///
/// Caller is responsible for broadcasting `<op>.complete` (often after
/// post-processing the error, e.g. appending an ssh diagnostic). Use
/// [`broadcast_complete`] with the returned `senders` to keep the
/// envelope shape consistent across callers.
pub(super) async fn stream_git_operation<F, Fut>(
    state: &AppState,
    feature_id: i64,
    op: GitStreamOp,
    header: String,
    run: F,
) -> StreamedOperation
where
    F: FnOnce(mpsc::UnboundedSender<(String, String)>) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    let senders = state.git_watcher.snapshot_subscribers(feature_id).await;
    let (output_tx, output_rx) = mpsc::unbounded_channel::<(String, String)>();
    let fanout = tokio::spawn(fanout_chunks(senders.clone(), feature_id, op, output_rx));

    let start_env = WsEnvelope::new(
        "git",
        op.start_action(),
        serde_json::json!({ "feature_id": feature_id }),
    );
    GitWatcherRegistry::broadcast_to_senders(&senders, &start_env);

    // Synthetic header so the dialog has a first line the moment the user
    // clicks Commit/Push, even if the real command takes a moment to emit
    // anything. Doubles as a smoke signal: missing header in the terminal
    // pane means the WS pipeline is broken, not the PTY reader.
    output_tx.send(("stdout".into(), header)).ignore_closed();

    let result = run(output_tx).await;
    // `run` owns the only sender clone we keep alive — once it returns,
    // dropping it makes the fanout receiver hit `None` and exit cleanly.
    cleanup(fanout.await, "wait for the output fan-out task");

    StreamedOperation {
        success: result.is_ok(),
        error: result.err().map(|e| e.to_string()),
        senders,
    }
}

/// Drain the chunk channel and broadcast each chunk as `<op>.output`.
async fn fanout_chunks(
    senders: Vec<mpsc::UnboundedSender<Message>>,
    feature_id: i64,
    op: GitStreamOp,
    mut rx: mpsc::UnboundedReceiver<(String, String)>,
) {
    let action = op.output_action();
    while let Some((stream, text)) = rx.recv().await {
        let env = WsEnvelope::new(
            "git",
            action,
            serde_json::json!({
                "feature_id": feature_id,
                "stream": stream,
                // Raw PTY chunk — `\n`, `\r`, partial lines, ANSI escapes.
                // Frontend appends verbatim to the per-feature buffer.
                "text": text,
            }),
        );
        GitWatcherRegistry::broadcast_to_senders(&senders, &env);
    }
}

/// Broadcast `<op>.complete` carrying success + optional error to the
/// senders the caller used for the run. Kept separate from
/// `stream_git_operation` because callers sometimes mutate the error
/// (push appends an ssh diagnostic) before broadcasting.
pub(super) fn broadcast_complete(
    senders: &[mpsc::UnboundedSender<Message>],
    feature_id: i64,
    op: GitStreamOp,
    success: bool,
    error: &Option<String>,
) {
    let env = WsEnvelope::new(
        "git",
        op.complete_action(),
        serde_json::json!({
            "feature_id": feature_id,
            "success": success,
            "error": error,
        }),
    );
    GitWatcherRegistry::broadcast_to_senders(senders, &env);
}

/// Operation tag — keeps action strings as `&'static str`s so the WS
/// payload allocates nothing extra and grep finds every site that emits
/// a given action.
#[derive(Clone, Copy)]
pub(super) enum GitStreamOp {
    Commit,
    Push,
}

impl GitStreamOp {
    fn start_action(self) -> &'static str {
        match self {
            Self::Commit => "commit.start",
            Self::Push => "push.start",
        }
    }
    fn output_action(self) -> &'static str {
        match self {
            Self::Commit => "commit.output",
            Self::Push => "push.output",
        }
    }
    fn complete_action(self) -> &'static str {
        match self {
            Self::Commit => "commit.complete",
            Self::Push => "push.complete",
        }
    }
}
