//! Tracks provider-usage writes across task cancellation so shutdown can wait
//! for the final database transaction to land.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::Notify;
use tracing::warn;

use super::health;

const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);
static DRAINED: Notify = Notify::const_new();

struct InFlightWrite;

impl Drop for InFlightWrite {
    fn drop(&mut self) {
        if IN_FLIGHT.fetch_sub(1, Ordering::SeqCst) == 1 {
            DRAINED.notify_waiters();
        }
    }
}

/// Run an awaited write on its own tracked task.
///
/// The caller still awaits completion, preserving cumulative-counter ordering.
/// If its stream task is cancelled during shutdown, dropping the join handle
/// detaches this write rather than cancelling it; [`flush`] then waits for it.
pub(super) async fn run_tracked<F>(write: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
    let task = tokio::spawn(async move {
        let _in_flight = InFlightWrite;
        write.await;
    });
    if let Err(error) = task.await {
        let message = format!("provider usage write task failed: {error}");
        warn!("{message}");
        health::record_failure(&message);
    }
}

/// Wait for every usage write accepted before shutdown, with a bounded delay.
pub async fn flush() {
    if tokio::time::timeout(FLUSH_TIMEOUT, wait_until_drained())
        .await
        .is_err()
    {
        let pending = IN_FLIGHT.load(Ordering::SeqCst);
        let message = format!("{pending} provider usage writes did not finish before shutdown");
        warn!("{message}");
        health::record_failure(&message);
    }
}

async fn wait_until_drained() {
    loop {
        // Register before checking so the last writer cannot notify between the
        // check and the await and leave shutdown sleeping until the timeout.
        let drained = DRAINED.notified();
        if IN_FLIGHT.load(Ordering::SeqCst) == 0 {
            return;
        }
        drained.await;
    }
}

#[cfg(test)]
mod tests {
    use super::{flush, run_tracked};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn flush_waits_for_a_detached_write() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let landed = Arc::new(AtomicBool::new(false));
        let landed_by_write = Arc::clone(&landed);
        let caller = tokio::spawn(run_tracked(async move {
            started_tx.send(()).unwrap();
            let _ = release_rx.await;
            landed_by_write.store(true, Ordering::SeqCst);
        }));
        started_rx.await.unwrap();
        caller.abort();
        release_tx.send(()).unwrap();

        flush().await;

        assert!(landed.load(Ordering::SeqCst));
    }
}
