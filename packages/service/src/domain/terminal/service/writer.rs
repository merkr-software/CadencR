use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use portable_pty::Child;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{broadcast, mpsc, watch};
use tracing::info;

use super::output::{publish_output, ScrollbackBuffer, Utf8Output};
use super::PtyHandle;

/// Maximum queued write chunks per PTY before returning explicit backpressure.
const WRITE_QUEUE_CHUNKS: usize = 256;
/// Maximum total queued bytes per PTY (512 KiB) so huge pastes cannot grow
/// memory without bound when a child stops reading stdin.
const WRITE_QUEUE_MAX_BYTES: usize = 512 * 1024;

/// Bounded, non-blocking handle to a PTY's dedicated writer OS thread.
///
/// Writes are strictly FIFO: one channel feeds one `std::thread` that owns the
/// blocking `MasterPty` writer exclusively. Calling [`Self::close`] (or dropping
/// the last `PtyHandle`) drops the shared sender, exits the OS thread
/// immediately, and closes the master writer off the Tokio runtime.
#[derive(Clone)]
pub struct PtyWriteQueue {
    tx: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    queued_bytes: Arc<AtomicUsize>,
    max_bytes: usize,
}

impl PtyWriteQueue {
    pub(super) fn spawn(pty_id: &str, writer: Box<dyn Write + Send>) -> anyhow::Result<Self> {
        Self::spawn_with_limits(pty_id, writer, WRITE_QUEUE_CHUNKS, WRITE_QUEUE_MAX_BYTES)
    }

    fn spawn_with_limits(
        pty_id: &str,
        mut writer: Box<dyn Write + Send>,
        max_chunks: usize,
        max_bytes: usize,
    ) -> anyhow::Result<Self> {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(max_chunks);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let queued_for_thread = Arc::clone(&queued_bytes);
        let thread_name = format!("pty-write-{pty_id}");

        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                while let Some(chunk) = rx.blocking_recv() {
                    let len = chunk.len();
                    let result = writer.write_all(&chunk);
                    queued_for_thread.fetch_sub(len, Ordering::AcqRel);
                    if result.is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| anyhow::anyhow!("Failed to spawn PTY writer thread: {error}"))?;

        Ok(Self {
            tx: Arc::new(Mutex::new(Some(tx))),
            queued_bytes,
            max_bytes,
        })
    }

    /// Drop the shared channel sender so the dedicated writer OS thread exits
    /// immediately rather than idling during the post-exit scrollback grace window.
    pub(super) fn close(&self) {
        let sender = self.tx.lock().unwrap_or_else(|e| e.into_inner()).take();
        drop(sender);
    }

    /// Enqueue `data` without blocking. Returns an explicit backpressure error
    /// if either the chunk limit or the byte budget is full, never silently
    /// dropping bytes mid-stream.
    pub(super) fn try_write(&self, data: &[u8]) -> anyhow::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let tx = {
            let guard = self.tx.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(tx) if !tx.is_closed() => tx.clone(),
                _ => anyhow::bail!("PTY writer closed"),
            }
        };
        let len = data.len();
        let max_bytes = self.max_bytes;
        let reserved =
            self.queued_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    let next = current.checked_add(len)?;
                    (next <= max_bytes).then_some(next)
                });
        if reserved.is_err() {
            anyhow::bail!("PTY input buffer full (backpressure)");
        }
        match tx.try_send(data.to_vec()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.queued_bytes.fetch_sub(len, Ordering::AcqRel);
                anyhow::bail!("PTY input buffer full (backpressure)");
            }
            Err(TrySendError::Closed(_)) => {
                self.queued_bytes.fetch_sub(len, Ordering::AcqRel);
                anyhow::bail!("PTY writer closed");
            }
        }
    }
}

/// Persistent OS reader thread: reads PTY output, updates scrollback, and
/// broadcasts to all WS subscribers without occupying Tokio's blocking pool.
pub(super) fn spawn_reader_thread(
    pty_id: &str,
    mut reader: Box<dyn Read + Send>,
    scrollback: Arc<Mutex<ScrollbackBuffer>>,
    data_tx: broadcast::Sender<String>,
) -> anyhow::Result<()> {
    std::thread::Builder::new()
        .name(format!("pty-read-{pty_id}"))
        .spawn(move || {
            let mut buf = [0u8; 4096];
            let mut decoder = Utf8Output::default();
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                publish_output(&scrollback, &data_tx, decoder.push(&buf[..n]));
            }
            publish_output(&scrollback, &data_tx, decoder.finish());
        })
        .map_err(|error| anyhow::anyhow!("Failed to spawn PTY reader thread: {error}"))?;
    Ok(())
}

/// Persistent OS child-waiter thread: closes the writer thread immediately on
/// exit, signals the `alive` channel, and schedules grace-period removal on the
/// captured Tokio runtime (if any).
pub(super) fn spawn_waiter_thread(
    pty_id: String,
    mut child: Box<dyn Child + Send + Sync>,
    terminals: Arc<DashMap<String, Arc<PtyHandle>>>,
    alive_tx: Arc<watch::Sender<Option<i32>>>,
    write_queue: PtyWriteQueue,
    runtime: Option<tokio::runtime::Handle>,
) -> anyhow::Result<()> {
    let thread_name = format!("pty-wait-{pty_id}");
    std::thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            let exit_code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            info!(pty_id = %pty_id, exit_code, "PTY child exited");
            write_queue.close();
            alive_tx.send_replace(Some(exit_code));

            if let Some(handle) = runtime {
                handle.spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    terminals.remove(&pty_id);
                    info!(pty_id = %pty_id, "PTY handle removed after grace period");
                });
            } else {
                terminals.remove(&pty_id);
            }
        })
        .map_err(|error| anyhow::anyhow!("Failed to spawn PTY waiter thread: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;

    struct BlockingWriter {
        started: std_mpsc::Sender<()>,
        release: std_mpsc::Receiver<()>,
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.started.send(());
            let _ = self.release.recv();
            self.written.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn write_queue_enforces_byte_budget_and_recovers_after_drain() {
        let (started_tx, started_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let written = Arc::new(Mutex::new(Vec::new()));
        let writer = BlockingWriter {
            started: started_tx,
            release: release_rx,
            written: Arc::clone(&written),
        };
        let queue = PtyWriteQueue::spawn_with_limits("test-budget", Box::new(writer), 16, 16)
            .expect("spawn writer");

        // First write enters the writer thread and blocks inside `write()`.
        queue.try_write(b"12345678").unwrap();
        started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("writer thread should start first write");

        // Second 8 bytes fit within the 16-byte budget; third triggers backpressure.
        queue.try_write(b"abcdefgh").unwrap();
        let err = queue
            .try_write(b"Z")
            .expect_err("exceeding byte budget must return backpressure");
        assert!(err.to_string().contains("backpressure"), "{err}");

        // Release both writes and verify exact FIFO bytes without the rejected byte.
        release_tx.send(()).unwrap();
        release_tx.send(()).unwrap();
        drop(queue);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while written.lock().unwrap().len() < 16 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(*written.lock().unwrap(), b"12345678abcdefgh");
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
                let _ = tx.send(());
            }
        }
    }

    #[test]
    fn close_exits_writer_thread_immediately_while_queue_is_held() {
        let (dropped_tx, dropped_rx) = std_mpsc::channel();
        let writer = DropNotifyWriter {
            dropped: Some(dropped_tx),
        };
        let queue = PtyWriteQueue::spawn_with_limits("test-close", Box::new(writer), 16, 1024)
            .expect("spawn writer");
        let queue_clone = queue.clone();

        queue.close();

        dropped_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("writer thread must exit and drop writer immediately after close()");

        let err = queue_clone
            .try_write(b"after-close")
            .expect_err("writes after close must fail");
        assert!(err.to_string().contains("closed"), "{err}");
    }
}
