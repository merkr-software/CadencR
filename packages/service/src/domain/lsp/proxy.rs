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
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::mpsc;
use tokio::sync::watch;
use tracing::{debug, info, warn};

use super::framing::{encode_frame, read_frame};
use super::lifecycle::{CrashKey, CrashTracker, CRASH_WINDOW, IDLE_TIMEOUT};

/// Drives the proxy until either side disconnects. Consumes both the
/// WebSocket and the [`Child`].
///
/// `crash_tracker` + `crash_key` participate in the per-`(workspace,
/// language)` backoff: a child that exits within
/// [`CRASH_WINDOW`](super::lifecycle::CRASH_WINDOW) of spawn is recorded
/// as a crash, ratcheting the cooldown. A session that lives longer
/// clears the failure history.
pub async fn run_proxy(
    ws: WebSocket,
    mut child: Child,
    display_name: &str,
    crash_tracker: Arc<CrashTracker>,
    crash_key: CrashKey,
) {
    let spawn_instant = Instant::now();
    let Some(stdin) = child.stdin.take() else {
        warn!("lsp child {display_name} has no stdin");
        let _ = child.kill().await;
        crash_tracker.record_crash(crash_key).await;
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        warn!("lsp child {display_name} has no stdout");
        let _ = child.kill().await;
        crash_tracker.record_crash(crash_key).await;
        return;
    };
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(drain_stderr(stderr, display_name.to_string()));
    }

    let (out_tx, out_rx) = mpsc::unbounded_channel::<Message>();
    let (sink, stream) = ws.split();

    // `activity_tx` is bumped every time either direction processes a
    // message; the idle-timeout task reads it to decide when to give up.
    let (activity_tx, activity_rx) = watch::channel(Instant::now());
    let activity_tx = Arc::new(activity_tx);

    let send_task = tokio::spawn(ws_sender(sink, out_rx));
    let stdout_task = tokio::spawn(stdout_to_ws(stdout, out_tx.clone(), activity_tx.clone()));
    let stdin_task = tokio::spawn(ws_to_stdin(stream, stdin, activity_tx.clone()));
    let idle_task = tokio::spawn(idle_watchdog(activity_rx, display_name.to_string()));

    // Exit as soon as any branch fires: a transport task ends, or the idle
    // timer trips. Whichever wins first, we tear down everyone else so the
    // child can't hang half-connected.
    //
    // `clean_close` distinguishes a client-initiated WS close (the renderer
    // tearing down its own transport — including the new auto-reconnect
    // cycle) from a server crash. A clean close must NOT trip the crash
    // backoff, or reconnecting would ratchet the cooldown against us.
    let clean_close = tokio::select! {
        _ = stdout_task => {
            debug!("lsp stdout closed; ending proxy for {display_name}");
            false
        }
        clean = stdin_task => {
            debug!("lsp ws-stream closed; ending proxy for {display_name}");
            // Task panics are rare; treat a join error as a non-clean exit.
            clean.unwrap_or(false)
        }
        _ = send_task => {
            debug!("lsp ws-sink closed; ending proxy for {display_name}");
            false
        }
        _ = idle_task => {
            info!("lsp {display_name} idle for {:?}; shutting down child", IDLE_TIMEOUT);
            // An idle teardown is our decision, not a crash.
            true
        }
    };
    let _ = child.kill().await;
    let _ = child.wait().await;

    // Backoff bookkeeping: only a child that *died on its own* within the
    // crash window counts as a crash. A clean client close (code 1000) or an
    // idle teardown clears the failure history instead.
    if !clean_close && spawn_instant.elapsed() < CRASH_WINDOW {
        crash_tracker.record_crash(crash_key).await;
    } else {
        crash_tracker.record_success(&crash_key).await;
    }
}

/// WebSocket "Normal Closure" status code (RFC 6455 §7.4.1). The renderer's
/// transport sends this on an intentional `close()`.
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
) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_frame(&mut reader).await {
            Ok(Some(bytes)) => match String::from_utf8(bytes) {
                Ok(text) => {
                    let _ = activity_tx.send(Instant::now());
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

/// WS → stdin. Stops when the WebSocket closes or stdin write fails. Bumps
/// the activity watch on every text message so the idle watchdog only
/// trips during a genuine quiet period (no requests, no notifications).
///
/// Returns `true` iff the stream ended via a client-initiated *normal* close
/// (WS code 1000) — i.e. the renderer tearing down its transport on purpose
/// (tab close, language switch, or the auto-reconnect cycle). The caller uses
/// that to avoid mis-attributing a clean close to the crash backoff. A write
/// failure, transport error, or any non-1000 close returns `false`.
async fn ws_to_stdin<S>(
    mut stream: S,
    mut stdin: ChildStdin,
    activity_tx: Arc<watch::Sender<Instant>>,
) -> bool
where
    S: StreamExt<Item = Result<Message, axum::Error>> + Unpin,
{
    while let Some(msg) = stream.next().await {
        let Ok(msg) = msg else {
            return false;
        };
        match msg {
            Message::Text(text) => {
                let _ = activity_tx.send(Instant::now());
                let frame = encode_frame(text.as_bytes());
                if stdin.write_all(&frame).await.is_err() {
                    return false;
                }
                if stdin.flush().await.is_err() {
                    return false;
                }
            }
            Message::Binary(_) => {
                // LSP is JSON text only. Ignore binary; matches existing /ws
                // handler's stance on unexpected frame types.
            }
            Message::Close(frame) => return is_normal_close(&frame),
            // Pings/pongs are handled by axum's built-in keepalive.
            _ => {}
        }
    }
    // Stream ended without an explicit Close frame (peer dropped) — not clean.
    false
}

/// Whether a WS close frame represents a normal (intentional) closure. A
/// missing frame means the peer closed without a status code, which we treat
/// as non-clean (could be a dropped connection).
fn is_normal_close(frame: &Option<axum::extract::ws::CloseFrame>) -> bool {
    frame.as_ref().is_some_and(|f| f.code == WS_CLOSE_NORMAL)
}

/// Outbound channel → WS sink. Splitting this out lets stdout_to_ws use a
/// cheap mpsc send instead of taking the WS sink lock.
async fn ws_sender<S>(mut sink: S, mut rx: mpsc::UnboundedReceiver<Message>)
where
    S: SinkExt<Message> + Unpin,
{
    while let Some(msg) = rx.recv().await {
        if sink.send(msg).await.is_err() {
            return;
        }
    }
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
