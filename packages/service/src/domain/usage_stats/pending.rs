//! Keeps track of usage writes that have been handed to a background task but
//! have not landed yet, so shutdown can wait for them.
//!
//! Recording is fire-and-forget on purpose — a word counter must never delay or
//! fail an agent turn — but "detached" must not mean "lost at quit". The words
//! are already gone from the caller by the time the task runs: the dispatch is
//! marked succeeded, the stream accumulator is drained, and nothing revisits
//! them. Draining here at shutdown is what makes the last turn of a session
//! count like every other one.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::Notify;
use tracing::warn;

use super::health;

/// How long shutdown waits for in-flight writes. Long enough for a queued
/// SQLite write behind a busy writer, short enough never to hold up quit.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// How long the "we lost writes" marker gets to land. The write pool has a
/// busy timeout of its own and no acquire timeout, so an unbounded await here
/// could blow through the shutdown budget the drain just respected — and the
/// marker is only a warning, worth far less than a prompt quit.
const MARKER_TIMEOUT: Duration = Duration::from_secs(1);

static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);
static DRAINED: Notify = Notify::const_new();

/// Run `write` on a background task, counted so [`flush`] can wait for it.
pub(super) fn spawn_tracked<F>(write: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
    tokio::spawn(async move {
        write.await;
        if IN_FLIGHT.fetch_sub(1, Ordering::SeqCst) == 1 {
            DRAINED.notify_waiters();
        }
    });
}

/// Wait for every in-flight usage write, bounded by [`DRAIN_TIMEOUT`].
///
/// A drain that times out is reported rather than swallowed: the words really
/// are lost, and the count is persisted — this process is about to exit, so an
/// in-memory counter would take the evidence with it — for the next start's
/// `/api/usage-stats` read to warn that the numbers are incomplete.
pub async fn flush(pool: &sqlx::SqlitePool) {
    let wait = async {
        loop {
            // Registered before the check, so a write that finishes in between
            // still wakes this up rather than parking until the timeout.
            let drained = DRAINED.notified();
            if IN_FLIGHT.load(Ordering::SeqCst) == 0 {
                return;
            }
            drained.await;
        }
    };

    if tokio::time::timeout(DRAIN_TIMEOUT, wait).await.is_err() {
        let lost = IN_FLIGHT.load(Ordering::SeqCst);
        warn!(lost, "usage writes were still in flight at shutdown");
        let reason = format!("{lost} usage writes did not finish before shutdown");
        let marker = health::record_persisted_loss(pool, lost, &reason);
        if tokio::time::timeout(MARKER_TIMEOUT, marker).await.is_err() {
            // The database is the only place this warning could live, and it
            // is the thing that is stalling — there is nothing left to try.
            warn!(lost, "timed out recording the lost usage writes");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{flush, spawn_tracked, IN_FLIGHT};
    use std::sync::atomic::Ordering;

    // Asserted on the counter rather than on elapsed time: `IN_FLIGHT` is
    // process-global, so the writes other tests hand off count here too and a
    // wall-clock bound would be at the mercy of the rest of the suite.
    #[tokio::test]
    async fn flush_waits_for_a_write_that_has_not_landed_yet() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let landed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = landed.clone();

        spawn_tracked(async move {
            let _ = rx.await;
            flag.store(true, Ordering::SeqCst);
        });
        // Let the write park, then release it and drain.
        tokio::task::yield_now().await;
        assert!(!landed.load(Ordering::SeqCst));
        let _ = tx.send(());

        flush(&pool).await;

        assert!(
            landed.load(Ordering::SeqCst),
            "shutdown waited for the write"
        );
        assert_eq!(IN_FLIGHT.load(Ordering::SeqCst), 0);
    }
}
