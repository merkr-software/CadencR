//! The stdio protocol (`docs/CUSTOM_TABS.md` §4.7), one JSON object per line:
//! - host → backend, first line: `{"type":"hello", …}` with the conversation,
//!   its folder and the backend's own scoped Cadencr API token;
//! - backend → host, first stdout line: `{"type":"ready","protocol":1}`
//!   ([`super::handshake`]); nothing is requested before it;
//! - host → backend: `{"type":"request","id","method","params"}`;
//! - backend → host on stdout: `{"type":"response","id","result"}` or
//!   `{"type":"response","id","error":{"code","message"}}`;
//! - stderr is the backend's log; Cadencr keeps its tail.
//!
//! Closing stdin asks the backend to exit.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use cadencr_tab_backend::protocol::MAX_LINE_BYTES;
use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::handshake::{self, Handshake, HandshakeState};
use super::history::History;
use super::lines::{next_line, Line};
use super::models::{PluginBackendCallError, PluginBackendResponse};
use crate::domain::agents::providers::installed::managed::process_policy::MANAGED_MAX_STDERR_LINE_BYTES;

pub(super) enum Reply {
    Response(PluginBackendResponse),
    Exited(String),
}

/// The callers waiting for a response, by request id.
pub(super) type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Reply>>>>;

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) async fn write_stdin(
    mut stdin: ChildStdin,
    hello: String,
    mut lines: mpsc::Receiver<String>,
    stop: CancellationToken,
) {
    let mut next = Some(hello);
    while let Some(line) = next.take() {
        let written = async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        };
        if written.await.is_err() {
            return;
        }
        next = tokio::select! {
            line = lines.recv() => line,
            () = stop.cancelled() => None,
        };
    }
    // Dropping stdin is the backend's cue to exit.
}

/// The backend's stdout: its `ready` line, then responses.
pub(super) struct Stdout {
    pub stdout: ChildStdout,
    pub pending: Pending,
    pub history: Arc<History>,
    pub handshake: HandshakeState,
    /// The protocol its tab.json declares, which `ready` must name.
    pub protocol: u32,
}

pub(super) async fn read_stdout(
    Stdout {
        stdout,
        pending,
        history,
        handshake,
        protocol,
    }: Stdout,
) {
    let mut reader = BufReader::new(stdout);
    // A stream that ends first leaves the handshake to the supervisor, which
    // settles it with how the process exited.
    let outcome = match next_line(&mut reader, MAX_LINE_BYTES).await {
        Ok(Some(Line::Text(line))) => handshake::check_ready(&line, protocol),
        Ok(Some(Line::TooLong)) => handshake::check_ready(b"<a line over 4 MiB>", protocol),
        Ok(None) | Err(_) => return,
    };
    let ready = outcome == Handshake::Ready;
    handshake::settle(&handshake, outcome);
    if !ready {
        return;
    }
    while let Ok(Some(line)) = next_line(&mut reader, MAX_LINE_BYTES).await {
        let text = match line {
            Line::Text(bytes) => bytes,
            Line::TooLong => {
                history.push_stderr(format!(
                    "[cadencr] dropped a stdout line over {} MiB",
                    MAX_LINE_BYTES / (1024 * 1024)
                ));
                continue;
            }
        };
        match parse_response(&text) {
            Some((id, response)) => {
                if let Some(waiter) = lock(&pending).remove(&id) {
                    let _ = waiter.send(Reply::Response(response));
                }
            }
            None => history.push_stderr(format!(
                "[cadencr] ignored a stdout line that is not a response: {}",
                String::from_utf8_lossy(&text)
            )),
        }
    }
}

/// `(id, response)` for a well-formed `{"type":"response"}` line.
pub(super) fn parse_response(line: &[u8]) -> Option<(String, PluginBackendResponse)> {
    let Value::Object(mut value) = serde_json::from_slice(line).ok()? else {
        return None;
    };
    if value.get("type")?.as_str()? != "response" {
        return None;
    }
    let id = match value.remove("id")? {
        Value::String(id) => id,
        Value::Number(id) => id.to_string(),
        _ => return None,
    };
    let response = match value.get("error") {
        Some(error) if !error.is_null() => {
            let text = |key: &str, fallback: &str| {
                error
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or(fallback)
                    .to_string()
            };
            PluginBackendResponse {
                result: None,
                error: Some(PluginBackendCallError {
                    code: text("code", "BACKEND_ERROR"),
                    message: text("message", "the backend reported an error"),
                }),
            }
        }
        _ => PluginBackendResponse {
            result: Some(value.remove("result").unwrap_or(Value::Null)),
            error: None,
        },
    };
    Some((id, response))
}

pub(super) async fn read_stderr(stderr: ChildStderr, history: Arc<History>) {
    let mut reader = BufReader::new(stderr);
    while let Ok(Some(line)) = next_line(&mut reader, MANAGED_MAX_STDERR_LINE_BYTES).await {
        match line {
            Line::Text(bytes) => history.push_stderr(String::from_utf8_lossy(&bytes)),
            Line::TooLong => history.push_stderr("[cadencr] dropped an overlong stderr line"),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_results_errors_and_numeric_ids() {
        let (id, ok) = parse_response(br#"{"type":"response","id":"3","result":{"n":1}}"#).unwrap();
        assert_eq!(id, "3");
        assert_eq!(ok.result, Some(json!({"n": 1})));
        let (id, failed) =
            parse_response(br#"{"type":"response","id":4,"error":{"code":"NOPE","message":"m"}}"#)
                .unwrap();
        assert_eq!(id, "4");
        assert_eq!(
            failed.error,
            Some(PluginBackendCallError {
                code: "NOPE".into(),
                message: "m".into()
            })
        );
        let (_, empty) = parse_response(br#"{"type":"response","id":"5"}"#).unwrap();
        assert_eq!(empty.result, Some(Value::Null));
        for line in [
            &b"not json"[..],
            br#"{"type":"log","id":"1"}"#,
            br#"{"type":"response"}"#,
        ] {
            assert!(parse_response(line).is_none());
        }
    }
}
