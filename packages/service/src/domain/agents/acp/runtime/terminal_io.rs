//! IO plumbing for ACP terminals: ring-buffered stdout/stderr capture
//! and the small helper that builds the wire payload returned by
//! `terminal/output`.
//!
//! Split out of `terminal_registry.rs` so the registry stays focused on
//! lifecycle / state management. No protocol parsing happens here.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

pub(super) const DEFAULT_TERMINAL_OUTPUT_LIMIT: usize = 1024 * 1024; // 1 MiB

#[derive(Clone, Debug)]
pub(super) struct ExitInfo {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Default)]
pub(super) struct TerminalOutput {
    buffer: Vec<u8>,
    truncated: bool,
    limit: usize,
}

impl TerminalOutput {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            buffer: Vec::new(),
            truncated: false,
            limit,
        }
    }

    pub(super) fn append(&mut self, chunk: &[u8]) {
        let remaining = self.limit.saturating_sub(self.buffer.len());
        if remaining == 0 {
            self.truncated = true;
            return;
        }
        let take = chunk.len().min(remaining);
        self.buffer.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            self.truncated = true;
        }
    }

    pub(super) fn snapshot(&self) -> (String, bool) {
        (
            String::from_utf8_lossy(&self.buffer).to_string(),
            self.truncated,
        )
    }
}

pub(super) fn spawn_pumps(
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    output: Arc<Mutex<TerminalOutput>>,
) -> Vec<JoinHandle<()>> {
    let mut handles = Vec::new();
    if let Some(stdout) = stdout {
        let output = Arc::clone(&output);
        handles.push(tokio::spawn(
            async move { pump_stream(stdout, output).await },
        ));
    }
    if let Some(stderr) = stderr {
        handles.push(tokio::spawn(
            async move { pump_stream(stderr, output).await },
        ));
    }
    handles
}

async fn pump_stream<R>(mut reader: R, output: Arc<Mutex<TerminalOutput>>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let mut guard = output.lock().await;
                guard.append(&buf[..n]);
            }
            Err(_) => break,
        }
    }
}

pub(super) fn build_output_payload(text: String, truncated: bool, exit: Option<ExitInfo>) -> Value {
    let mut payload = json!({
        "output": text,
        "truncated": truncated,
    });
    if let Some(exit) = exit {
        payload["exitStatus"] = json!({
            "exitCode": exit.exit_code,
            "signal": exit.signal,
        });
    }
    payload
}

#[cfg(unix)]
pub(super) fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
pub(super) fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(test)]
mod tests {
    use super::{build_output_payload, ExitInfo, TerminalOutput};

    #[test]
    fn output_appends_until_limit_then_truncates() {
        let mut output = TerminalOutput::new(8);
        output.append(b"abcd");
        output.append(b"efghij"); // total 10 -> last 2 dropped
        let (text, truncated) = output.snapshot();
        assert_eq!(text.len(), 8);
        assert!(truncated);
    }

    #[test]
    fn build_output_payload_omits_exit_when_running() {
        let payload = build_output_payload("hello".into(), false, None);
        assert_eq!(payload["output"], "hello");
        assert_eq!(payload["truncated"], false);
        assert!(payload.get("exitStatus").is_none());
    }

    #[test]
    fn build_output_payload_includes_exit_when_known() {
        let payload = build_output_payload(
            String::new(),
            false,
            Some(ExitInfo {
                exit_code: Some(42),
                signal: None,
            }),
        );
        assert_eq!(payload["exitStatus"]["exitCode"], 42);
    }
}
