//! Closing a Codex session: unsubscribe its thread, stop the app-server and
//! end the runtime's message stream.

use std::sync::atomic::Ordering;

use tokio::sync::mpsc;

use super::super::timeouts::with_control_timeout;
use super::CodexSession;
use crate::domain::agents::adapter::RuntimeError;

impl CodexSession {
    pub(super) async fn close_session(&mut self) -> Result<(), RuntimeError> {
        // Only the first close unsubscribes. A later one (an idle reader
        // retiring the runtime the shutdown already closed) would send
        // `thread/unsubscribe` to the app-server the first close stopped and
        // report that failure. The rest is safe to repeat, and is repeated:
        // a first close cancelled midway still left it to do.
        let unsubscribe = if self.closing.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(
                with_control_timeout(
                    "Codex thread/unsubscribe",
                    self.client.thread_unsubscribe(&self.thread_id),
                )
                .await,
            )
        };
        self.temp_files.lock().await.clear();
        self.pending_prompt_receipts.clear();
        self.async_questions.lock().await.clear();
        self.client.shutdown().await;
        // The local forwarder holds the stream open while this sender lives:
        // drop it so the stream ends with the app-server, and its reader with
        // it, instead of outliving the close.
        self.local_tx = mpsc::unbounded_channel().0;
        match unsubscribe {
            Some(Err(error)) => Err(RuntimeError::new(format!(
                "Codex session closed, but thread/unsubscribe failed: {error}"
            ))),
            Some(Ok(_)) | None => Ok(()),
        }
    }
}
