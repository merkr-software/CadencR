use std::future::Future;
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::shared::discard::KeepFirst;

/// Largest piece of one client write handed to the writer thread at a time.
const WRITE_CHUNK_BYTES: usize = 4 * 1024;
/// Queued pieces per PTY. With [`WRITE_CHUNK_BYTES`] this caps the bytes
/// waiting in memory at 512 KiB however much a child refuses to read.
const WRITE_QUEUE_CHUNKS: usize = 128;

/// Bounded handle to a PTY's dedicated writer OS thread.
///
/// Writes are strictly FIFO: one channel feeds one `std::thread` that owns the
/// blocking `MasterPty` writer exclusively, so a child that stops reading stdin
/// blocks that thread, never a Tokio worker. A full queue makes [`Self::write`]
/// wait asynchronously for room instead of refusing bytes; callers keep that
/// wait off their socket's read loop (see `terminal::input`).
#[derive(Clone)]
pub struct PtyWriteQueue {
    tx: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    /// Fired by [`Self::close`] or when the writer thread stops, so writes
    /// waiting for room fail at once instead of waiting forever.
    closed: CancellationToken,
    /// Why the writer thread stopped early (an `EIO` from the master, …).
    failure: Arc<OnceLock<String>>,
    /// Keeps each client write contiguous when two sockets share a PTY.
    order: Arc<tokio::sync::Mutex<()>>,
    chunk_bytes: usize,
}

impl PtyWriteQueue {
    pub(super) fn spawn(pty_id: &str, writer: Box<dyn Write + Send>) -> anyhow::Result<Self> {
        Self::spawn_with_limits(pty_id, writer, WRITE_CHUNK_BYTES, WRITE_QUEUE_CHUNKS)
    }

    fn spawn_with_limits(
        pty_id: &str,
        mut writer: Box<dyn Write + Send>,
        chunk_bytes: usize,
        max_chunks: usize,
    ) -> anyhow::Result<Self> {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(max_chunks);
        let closed = CancellationToken::new();
        let failure = Arc::new(OnceLock::new());
        let thread_closed = closed.clone();
        let thread_failure = Arc::clone(&failure);

        std::thread::Builder::new()
            .name(format!("pty-write-{pty_id}"))
            .spawn(move || {
                while let Some(chunk) = rx.blocking_recv() {
                    if thread_closed.is_cancelled() {
                        break;
                    }
                    if let Err(error) = writer.write_all(&chunk) {
                        thread_failure
                            .keep_first(format!("writing to the terminal failed: {error}"));
                        break;
                    }
                }
                thread_closed.cancel();
                // Dropping portable-pty's Unix writer sends "\n" + VEOF to the
                // PTY. Only `close()` (called once the child has exited) or a
                // failed write gets here, so no live shell can run that newline.
                drop(writer);
            })
            .map_err(|error| anyhow::anyhow!("Failed to spawn PTY writer thread: {error}"))?;

        Ok(Self {
            tx: Arc::new(Mutex::new(Some(tx))),
            closed,
            failure,
            order: Arc::new(tokio::sync::Mutex::new(())),
            chunk_bytes,
        })
    }

    /// Stop the writer thread once the child has exited: writes waiting for
    /// room fail, anything still queued is discarded (nothing reads it any
    /// more), and the thread exits after its in-flight write.
    ///
    /// Never call this on a live child: the thread then drops the master
    /// writer, which types "\n" + VEOF into the PTY.
    pub(super) fn close(&self) {
        self.closed.cancel();
        let sender = self.tx.lock().unwrap_or_else(|e| e.into_inner()).take();
        drop(sender);
    }

    /// Queue `data` for the child, in order, waiting (asynchronously) for room
    /// while the child is not reading. Resolves once every byte is queued, or
    /// with the reason the PTY can no longer take input.
    pub(crate) fn write(
        &self,
        data: Vec<u8>,
    ) -> impl Future<Output = anyhow::Result<()>> + Send + 'static {
        let queue = self.clone();
        async move {
            if data.is_empty() {
                return Ok(());
            }
            let _turn = tokio::select! {
                biased;
                () = queue.closed.cancelled() => return Err(queue.stopped_error()),
                turn = Arc::clone(&queue.order).lock_owned() => turn,
            };
            let tx = queue.sender()?;
            if data.len() <= queue.chunk_bytes {
                // A keystroke fits in one piece: no copy.
                return queue.send_chunk(&tx, data).await;
            }
            for chunk in data.chunks(queue.chunk_bytes) {
                queue.send_chunk(&tx, chunk.to_vec()).await?;
            }
            Ok(())
        }
    }

    /// Queue one piece, waiting for room unless the PTY stops taking input.
    async fn send_chunk(&self, tx: &mpsc::Sender<Vec<u8>>, chunk: Vec<u8>) -> anyhow::Result<()> {
        tokio::select! {
            biased;
            () = self.closed.cancelled() => Err(self.stopped_error()),
            sent = tx.send(chunk) => sent.map_err(|_| self.stopped_error()),
        }
    }

    fn sender(&self) -> anyhow::Result<mpsc::Sender<Vec<u8>>> {
        let guard = self.tx.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(tx) if !self.closed.is_cancelled() => Ok(tx.clone()),
            _ => Err(self.stopped_error()),
        }
    }

    fn stopped_error(&self) -> anyhow::Error {
        match self.failure.get() {
            Some(cause) => anyhow::anyhow!("Terminal input stopped: {cause}"),
            None => anyhow::anyhow!("Terminal input closed: the process has exited"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;
    use std::time::Duration;

    struct GatedWriter {
        release: std_mpsc::Receiver<()>,
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for GatedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            // A test that drops its release sender is tearing down.
            if self.release.recv().is_err() {
                return Err(std::io::Error::other("test torn down"));
            }
            self.written.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_write_larger_than_the_queue_waits_for_room_and_loses_nothing() {
        let (release_tx, release_rx) = std_mpsc::channel();
        let written = Arc::new(Mutex::new(Vec::new()));
        let writer = GatedWriter {
            release: release_rx,
            written: Arc::clone(&written),
        };
        // 4-byte pieces, 2 queued: the 64-byte write is 8x the queue.
        let queue = PtyWriteQueue::spawn_with_limits("test-wait", Box::new(writer), 4, 2)
            .expect("spawn writer");
        let payload: Vec<u8> = (0..64u8).collect();
        let mut write = Box::pin(queue.write(payload.clone()));

        // The child is not reading: the write waits instead of failing.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut write)
                .await
                .is_err(),
            "a full queue must make the write wait, not reject bytes"
        );

        // The child starts reading: every byte arrives, in order.
        for _ in 0..16 {
            release_tx.send(()).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(2), write)
            .await
            .expect("write completes once the child drains")
            .expect("no error");
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while written.lock().unwrap().len() < payload.len() && std::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(*written.lock().unwrap(), payload);
    }

    #[tokio::test]
    async fn close_fails_a_write_that_is_waiting_for_room() {
        let (_release_tx, release_rx) = std_mpsc::channel();
        let writer = GatedWriter {
            release: release_rx,
            written: Arc::new(Mutex::new(Vec::new())),
        };
        let queue = PtyWriteQueue::spawn_with_limits("test-close-wait", Box::new(writer), 4, 1)
            .expect("spawn writer");
        let mut write = Box::pin(queue.write(vec![b'x'; 64]));
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut write)
            .await
            .is_err());

        queue.close();
        let error = tokio::time::timeout(Duration::from_secs(2), write)
            .await
            .expect("close wakes the waiting write")
            .expect_err("a closed PTY takes no input");
        assert!(error.to_string().contains("exited"), "{error}");
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::from_raw_os_error(libc::EIO))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_failed_write_keeps_its_cause_for_later_writes() {
        let queue = PtyWriteQueue::spawn_with_limits("test-eio", Box::new(FailingWriter), 4, 4)
            .expect("spawn writer");
        // One chunk can be queued before the writer reports the error. A
        // multi-chunk write can see the first chunk fail before queuing the next.
        queue.write(b"init".to_vec()).await.expect("queued");
        tokio::time::timeout(Duration::from_secs(2), queue.closed.cancelled())
            .await
            .expect("the writer thread must report its failure");
        let error = queue
            .write(b"next".to_vec())
            .await
            .expect_err("writes after a failure must fail");
        let message = error.to_string();
        assert!(
            message.contains("writing to the terminal failed"),
            "{message}"
        );
        assert!(
            message.contains(&std::io::Error::from_raw_os_error(libc::EIO).to_string()),
            "the original I/O error must be kept: {message}"
        );
    }

    struct DropNotifyWriter {
        dropped: Option<std_mpsc::Sender<()>>,
    }

    impl Write for DropNotifyWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Drop for DropNotifyWriter {
        fn drop(&mut self) {
            if let Some(tx) = self.dropped.take() {
                tx.send(()).expect("test still listening");
            }
        }
    }

    #[tokio::test]
    async fn close_exits_writer_thread_while_queue_clones_are_held() {
        let (dropped_tx, dropped_rx) = std_mpsc::channel();
        let writer = DropNotifyWriter {
            dropped: Some(dropped_tx),
        };
        let queue = PtyWriteQueue::spawn_with_limits("test-close", Box::new(writer), 16, 16)
            .expect("spawn writer");
        let queue_clone = queue.clone();

        queue.close();

        dropped_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("writer thread must exit and drop writer after close()");
        let err = queue_clone
            .write(b"after-close".to_vec())
            .await
            .expect_err("writes after close must fail");
        assert!(err.to_string().contains("closed"), "{err}");
    }
}
