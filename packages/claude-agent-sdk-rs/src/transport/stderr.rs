//! Capture stderr without waiting forever for descendants that inherit the pipe.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::task::JoinHandle;

const DRAIN_TIMEOUT: Duration = Duration::from_millis(250);

pub(super) struct StderrCapture {
    bytes: Arc<Mutex<Vec<u8>>>,
    task: JoinHandle<std::io::Result<()>>,
}

impl StderrCapture {
    pub(super) fn start(mut reader: impl AsyncRead + Unpin + Send + 'static) -> Self {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&bytes);
        let task = tokio::spawn(async move {
            let mut chunk = [0; 4096];
            loop {
                let count = reader.read(&mut chunk).await?;
                if count == 0 {
                    return Ok(());
                }
                captured
                    .lock()
                    .expect("stderr capture poisoned")
                    .extend_from_slice(&chunk[..count]);
            }
        });
        Self { bytes, task }
    }

    pub(super) async fn finish(&mut self) -> String {
        let diagnostic = match tokio::time::timeout(DRAIN_TIMEOUT, &mut self.task).await {
            Ok(Ok(Ok(()))) => None,
            Ok(Ok(Err(error))) => Some(format!("Failed to read Claude CLI stderr: {error}")),
            Ok(Err(error)) => Some(format!("Claude CLI stderr task failed: {error}")),
            Err(_) => {
                self.task.abort();
                Some("Claude CLI stderr remained open after process exit; stopped draining.".into())
            }
        };
        let mut stderr =
            String::from_utf8_lossy(&self.bytes.lock().expect("stderr capture poisoned"))
                .into_owned();
        if let Some(diagnostic) = diagnostic {
            stderr.push('\n');
            stderr.push_str(&diagnostic);
        }
        stderr
    }
}

impl Drop for StderrCapture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn open_stderr_is_bounded_and_preserves_captured_diagnostics() {
        let (mut writer, reader) = tokio::io::duplex(128);
        let mut capture = StderrCapture::start(reader);
        writer.write_all(b"original failure").await.unwrap();
        let stderr = tokio::time::timeout(Duration::from_secs(1), capture.finish())
            .await
            .unwrap();
        assert!(stderr.contains("original failure"));
        assert!(stderr.contains("remained open after process exit"));
    }

    #[tokio::test]
    async fn closed_stderr_is_returned_without_a_timeout_diagnostic() {
        let (mut writer, reader) = tokio::io::duplex(128);
        let mut capture = StderrCapture::start(reader);
        writer.write_all(b"original failure").await.unwrap();
        drop(writer);
        assert_eq!(capture.finish().await, "original failure");
    }
}
