//! Bidirectional pump between a WebSocket and an LSP child's stdio.
//!
//! - WS text frames → `Content-Length`-prefixed bytes on child stdin
//! - `Content-Length`-prefixed bytes from child stdout → WS text frames
//! - child stderr → tracing (severity inferred from the line: ERROR-level
//!   gets `warn!`, everything else is `debug!` so chatty servers like
//!   rust-analyzer don't flood the terminal with their own WARN-level
//!   internal logs)
//!
//! Lifetime: the pump returns once any direction terminates. We then issue
//! `child.kill()` so the server cannot outlive the renderer. Crash-restart
//! and grace-period shutdown are step 5; this module deliberately knows
//! nothing about either, which keeps the wire-protocol logic isolated.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use tokio::io::BufReader;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::mpsc;
use tokio::sync::watch;
use tracing::{debug, info, warn};

use super::framing::read_frame;
use super::lifecycle::{CrashKey, CrashTracker, CRASH_WINDOW, IDLE_TIMEOUT};
use super::watchers::{bridge::StdinBridge, SessionWatchers};

mod websocket;
use websocket::ws_sender;

/// Drives the proxy until either side disconnects. Consumes both the
/// WebSocket and the [`Child`].
///
/// `crash_tracker` + `crash_key` participate in the per-`(workspace,
/// language)` backoff: a child that exits within
/// [`CRASH_WINDOW`](super::lifecycle::CRASH_WINDOW) of spawn is recorded
/// as a crash, ratcheting the cooldown. A session that lives longer
/// clears the failure history.
#[bon::builder]
pub async fn run_proxy(
    ws: WebSocket,
    mut child: Child,
    display_name: &str,
    crash_tracker: Arc<CrashTracker>,
    crash_key: CrashKey,
    runtime_root: Option<std::path::PathBuf>,
) {
    let spawn_instant = Instant::now();
    let (stdin, stdout) = match take_pipes(&mut child, display_name) {
        Ok(pipes) => pipes,
        Err(error) => {
            warn!("lsp child {display_name}: {error}");
            let _ = child.kill().await;
            crash_tracker.record_crash(crash_key).await;
            return;
        }
    };

    let (out_tx, out_rx) = mpsc::unbounded_channel::<Message>();
    let (mut sink, stream) = ws.split();

    // Either direction refreshes the idle deadline.
    let (activity_tx, activity_rx) = watch::channel(Instant::now());
    let activity_tx = Arc::new(activity_tx);

    let mut roots = vec![crash_key.workspace_root.clone()];
    roots.extend(runtime_root);
    let (watchers, events) = match SessionWatchers::new(roots) {
        Ok(watchers) => watchers,
        Err(error) => {
            warn!("{error}");
            let message = serde_json::json!({"jsonrpc":"2.0","method":"window/showMessage",
                "params":{"type":1,"message":error}});
            let _ = sink.send(Message::Text(message.to_string().into())).await;
            let _ = child.kill().await;
            return;
        }
    };
    let (reply_tx, reply_rx) = mpsc::channel(32);
    let mut send_task = Box::pin(ws_sender(&mut sink, out_rx));
    let stdout_task = tokio::spawn(stdout_to_ws(
        stdout,
        out_tx.clone(),
        activity_tx.clone(),
        watchers.clone(),
        reply_tx,
    ));
    let bridge = StdinBridge::builder()
        .stdin(stdin)
        .activity(activity_tx.clone())
        .watchers(watchers)
        .events(events)
        .replies(reply_rx)
        .out(out_tx.clone())
        .build();
    let stdin_task = tokio::spawn(bridge.run(stream));
    let idle_task = tokio::spawn(idle_watchdog(activity_rx, display_name.to_string()));
    let _tasks = ProxyTasks(vec![
        stdout_task.abort_handle(),
        stdin_task.abort_handle(),
        idle_task.abort_handle(),
    ]);

    // Prefer a received close over simultaneous outbound failure or child EOF.
    let clean_close = tokio::select! {
        biased;
        clean = stdin_task => {
            debug!("lsp ws-stream closed; ending proxy for {display_name}");
            clean.unwrap_or(false)
        }
        _ = stdout_task => {
            debug!("lsp stdout closed; ending proxy for {display_name}");
            false
        }
        _ = &mut send_task => {
            debug!("lsp ws-sink closed; ending proxy for {display_name}");
            false
        }
        _ = idle_task => {
            info!("lsp {display_name} idle for {:?}; shutting down child", IDLE_TIMEOUT);
            true
        }
    };
    let early_exit = spawn_instant.elapsed() < CRASH_WINDOW;
    drop(send_task);
    websocket::close(&mut sink, display_name).await;
    let _ = child.kill().await;
    let _ = child.wait().await;

    // Only an unexpected early exit counts as a crash.
    if !clean_close && early_exit {
        crash_tracker.record_crash(crash_key).await;
    } else {
        crash_tracker.record_success(&crash_key).await;
    }
}

fn take_pipes(
    child: &mut Child,
    display_name: &str,
) -> Result<(ChildStdin, ChildStdout), &'static str> {
    let stdin = child.stdin.take().ok_or("missing stdin")?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(drain_stderr(stderr, display_name.to_string()));
    }
    Ok((stdin, stdout))
}

/// WebSocket "Normal Closure" status code (RFC 6455 §7.4.1). The renderer's
/// transport sends this on an intentional `close()`.
#[cfg(test)]
const WS_CLOSE_NORMAL: u16 = 1000;

/// Waits until [`IDLE_TIMEOUT`] has elapsed since the last observed activity
/// and then returns. The proxy's `select!` arm uses that to tear down the
/// child when nothing has crossed the WS for a while.
async fn idle_watchdog(mut activity_rx: watch::Receiver<Instant>, display_name: String) {
    loop {
        let last = *activity_rx.borrow();
        let elapsed = last.elapsed();
        if elapsed >= IDLE_TIMEOUT {
            return;
        }
        let remaining = IDLE_TIMEOUT - elapsed;
        tokio::select! {
            _ = tokio::time::sleep(remaining) => {
                debug!("lsp {display_name} idle deadline reached, exiting watchdog");
                return;
            }
            // `changed()` resolves whenever activity_tx updates. Loop and
            // re-check elapsed against the new instant.
            res = activity_rx.changed() => {
                if res.is_err() {
                    // All senders dropped — proxy is shutting down anyway.
                    return;
                }
            }
        }
    }
}

/// stdout → WS. Stops on EOF, malformed framing, or non-UTF8 bytes (LSP
/// mandates UTF-8 JSON-RPC, so the latter is unrecoverable). Bumps the
/// activity watch on every received frame so the idle watchdog stays
/// happy as long as the server is talking back.
async fn stdout_to_ws(
    stdout: ChildStdout,
    out_tx: mpsc::UnboundedSender<Message>,
    activity_tx: Arc<watch::Sender<Instant>>,
    watchers: SessionWatchers,
    replies: mpsc::Sender<serde_json::Value>,
) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_frame(&mut reader).await {
            Ok(Some(bytes)) => match String::from_utf8(bytes) {
                Ok(text) => {
                    let _ = activity_tx.send(Instant::now());
                    let handled = watchers.server_frame(&text);
                    if let Some(error) = handled.error {
                        warn!("LSP file watcher registration failed: {error}");
                        // Unsupported optional globs are truthfully rejected over JSON-RPC.
                        // Actual OS watcher setup failures additionally need a user-visible error.
                        if error.starts_with("Could not ") {
                            let message = serde_json::json!({"jsonrpc":"2.0","method":"window/showMessage",
                                "params":{"type":1,"message":error}});
                            let _ = out_tx.send(Message::Text(message.to_string().into()));
                        }
                    }
                    if let Some(response) = handled.response {
                        if replies.send(response).await.is_err() {
                            return;
                        }
                    }
                    let Some(text) = handled.forward else {
                        continue;
                    };
                    if out_tx.send(Message::Text(text.into())).is_err() {
                        return; // WS sink gone
                    }
                }
                Err(_) => {
                    warn!("lsp child emitted non-UTF8 frame; closing");
                    return;
                }
            },
            Ok(None) => return, // clean EOF
            Err(e) => {
                warn!("lsp framing error: {e}");
                return;
            }
        }
    }
}

/// Whether a WS close frame represents a normal (intentional) closure. A
/// missing frame means the peer closed without a status code, which we treat
/// as non-clean (could be a dropped connection).
#[cfg(test)]
fn is_normal_close(frame: &Option<axum::extract::ws::CloseFrame>) -> bool {
    frame.as_ref().is_some_and(|f| f.code == WS_CLOSE_NORMAL)
}

/// Pipes stderr lines into the tracing subscriber. LSP servers (rust-analyzer
/// especially) log voluminously to stderr — their own INFO/WARN bookkeeping
/// (config file watchers, indexing progress, etc.) isn't actionable for us,
/// so we route everything to `debug!` by default. Lines that look like real
/// errors get bumped to `warn!` so a crash or misconfiguration still stands
/// out in the dev terminal without `RUST_LOG=debug`.
async fn drain_stderr(stderr: ChildStderr, display_name: String) {
    use tokio::io::AsyncBufReadExt;
    let mut reader = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if looks_like_error(&line) {
            warn!(server = %display_name, "lsp stderr: {line}");
        } else {
            debug!(server = %display_name, "lsp stderr: {line}");
        }
    }
}

/// Heuristic for "this stderr line is something the operator should see."
/// Covers the formats the LSP servers we ship use:
/// - rust-analyzer / gopls (`tracing`-style): ` ERROR ` mid-line.
/// - typescript-language-server / pyright / cargo / clang: `error:` prefix.
/// - generic panic / fatal markers from any tool.
fn looks_like_error(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains(" error ")
        || lower.starts_with("error:")
        || lower.contains("fatal:")
        || lower.contains("panic")
}

#[cfg(test)]
mod tests {
    use super::{is_normal_close, looks_like_error, WS_CLOSE_NORMAL};
    use axum::extract::ws::CloseFrame;

    #[test]
    fn normal_close_code_is_clean() {
        let frame = Some(CloseFrame {
            code: WS_CLOSE_NORMAL,
            reason: "client".into(),
        });
        assert!(is_normal_close(&frame));
    }

    #[test]
    fn abnormal_close_codes_are_not_clean() {
        // 1006 (abnormal closure) and a missing frame both mean "not a clean
        // client teardown" — they must NOT clear the crash backoff.
        let abnormal = Some(CloseFrame {
            code: 1006,
            reason: "".into(),
        });
        assert!(!is_normal_close(&abnormal));
        assert!(!is_normal_close(&None));
    }

    #[test]
    fn classifies_real_errors_as_errors() {
        // rust-analyzer / gopls / tracing-style.
        assert!(looks_like_error(
            "2026-05-23T09:59:24+02:00 ERROR rust_analyzer::diagnostics: bad ast"
        ));
        // typescript-language-server / cargo / clang.
        assert!(looks_like_error("error: failed to read tsconfig.json"));
        // Generic markers.
        assert!(looks_like_error("fatal: not a git repository"));
        assert!(looks_like_error("thread 'main' panicked at ..."));
    }

    #[test]
    fn classifies_benign_chatter_as_debug() {
        // The exact rust-analyzer notify-watcher warning the user saw —
        // not an error from our POV, must not bubble up as WARN.
        assert!(!looks_like_error(
            "2026-05-23T09:59:23+02:00  WARN notify error: No path was found. about [\"/x/rust-analyzer.toml\"]"
        ));
        // Routine progress lines.
        assert!(!looks_like_error("INFO indexing 23% complete"));
        assert!(!looks_like_error(""));
    }
}

struct ProxyTasks(Vec<tokio::task::AbortHandle>);
impl Drop for ProxyTasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

#[cfg(test)]
mod qualification;
