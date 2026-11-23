//! The two OS threads each PTY owns besides its writer: one reading output,
//! one waiting for the child to exit.

use std::io::Read;
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use portable_pty::Child;
use tokio::sync::{broadcast, watch};
use tracing::info;

use super::output::{publish_output, ScrollbackBuffer, Utf8Output};
use super::{PtyHandle, PtyWriteQueue};

pub(super) type PtyChild = Box<dyn Child + Send + Sync>;

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
            // EOF or EIO: on Unix the master reports EIO once the slave side
            // has hung up, which is this thread's normal end.
            while let Ok(n @ 1..) = reader.read(&mut buf) {
                publish_output(&scrollback, &data_tx, decoder.push(&buf[..n]));
            }
            publish_output(&scrollback, &data_tx, decoder.finish());
        })
        .map_err(|error| anyhow::anyhow!("Failed to spawn PTY reader thread: {error}"))?;
    Ok(())
}

pub(super) struct WaiterParts {
    pub pty_id: String,
    pub terminals: Arc<DashMap<String, Arc<PtyHandle>>>,
    pub alive_tx: Arc<watch::Sender<Option<i32>>>,
    pub write_queue: PtyWriteQueue,
    pub runtime: Option<tokio::runtime::Handle>,
}

/// Persistent OS child-waiter thread: closes the writer thread once the child
/// has exited, signals the `alive` channel, and schedules grace-period removal
/// on the captured Tokio runtime (if any).
///
/// The child reaches the thread through a channel only after the spawn
/// succeeded, so a failed spawn hands it back for the caller to reap.
pub(super) fn spawn_waiter_thread(
    parts: WaiterParts,
    child: PtyChild,
) -> Result<(), (anyhow::Error, PtyChild)> {
    let (child_tx, child_rx) = std::sync::mpsc::sync_channel::<PtyChild>(1);
    let thread_name = format!("pty-wait-{}", parts.pty_id);
    let spawned = std::thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            // The sender is only dropped unsent when the spawn below failed.
            if let Ok(child) = child_rx.recv() {
                wait_then_retire(parts, child);
            }
        });
    if let Err(error) = spawned {
        let error = anyhow::anyhow!("Failed to spawn PTY waiter thread: {error}");
        return Err((error, child));
    }
    child_tx
        .send(child)
        .map_err(|unsent| (anyhow::anyhow!("PTY waiter thread exited early"), unsent.0))
}

fn wait_then_retire(parts: WaiterParts, mut child: PtyChild) {
    let WaiterParts {
        pty_id,
        terminals,
        alive_tx,
        write_queue,
        runtime,
    } = parts;
    let exit_code = match child.wait() {
        Ok(status) => status.exit_code() as i32,
        Err(_) => -1,
    };
    info!(pty_id = %pty_id, exit_code, "PTY child exited");
    // Only now: closing drops the master writer, whose Drop types "\n" + VEOF.
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
}

/// Kill a child whose PTY could not be fully set up and reap it, so a failed
/// spawn leaves no zombie. `Child::kill` escalates from SIGHUP to SIGKILL, so
/// the wait cannot hang on a child that ignores hangups.
pub(super) fn kill_and_reap(mut child: PtyChild, reason: &str) {
    crate::shared::discard::cleanup(child.kill(), reason);
    crate::shared::discard::cleanup(child.wait(), reason);
}
