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

/// How long each "we lost writes" marker gets to land. The write pool has a
/// busy timeout of its own and no acquire timeout, so an unbounded await here
/// could blow through the shutdown budget the drain respects — and the marker
/// is only a warning, worth far less than a prompt quit.
const MARKER_TIMEOUT: Duration = Duration::from_secs(1);

/// Recorded when the writes are claimed, before it is known whether they land.
/// The count is what says how many; this only has to say what happened.
const AT_RISK_REASON: &str = "the service exited before every usage write finished";

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
    flush_within(pool, DRAIN_TIMEOUT).await
}

/// [`flush`] with the drain budget spelled out, so a test can reach the
/// timeout path without waiting the real one out.
async fn flush_within(pool: &sqlx::SqlitePool, drain_timeout: Duration) {
    let at_risk = IN_FLIGHT.load(Ordering::SeqCst);
    if at_risk == 0 {
        return;
    }

    // Claim the writes as lost *before* waiting for them, and give back what
    // lands. Marking them afterwards asks a database busy enough to have just
    // blocked the drain for one more write, against what is left of the
    // shutdown budget — and if that write loses too, the process exits with
    // words missing and nothing anywhere to say so, which is the one outcome
    // this whole path exists to prevent. Claiming first inverts the failure:
    // the marker is written while there is still slack, and it also survives a
    // SIGKILL mid-drain. Being wrong then means warning about words that were
    // in fact recorded — visible, and dismissible.
    mark(pool, at_risk, AT_RISK_REASON).await;

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

    let lost = match tokio::time::timeout(drain_timeout, wait).await {
        Ok(()) => 0,
        Err(_) => IN_FLIGHT.load(Ordering::SeqCst),
    };
    settle(pool, at_risk, lost).await;
}

/// Reconcile the claim with what the drain actually delivered.
async fn settle(pool: &sqlx::SqlitePool, at_risk: u64, lost: u64) {
    if lost > 0 {
        warn!(lost, "usage writes were still in flight at shutdown");
    }
    match lost.cmp(&at_risk) {
        // Everything claimed landed, or some of it did.
        std::cmp::Ordering::Less => {
            let timeout = tokio::time::timeout(
                MARKER_TIMEOUT,
                health::retract_persisted_loss(pool, at_risk - lost),
            );
            if timeout.await.is_err() {
                warn!("timed out retracting the lost usage writes marker");
            }
        }
        std::cmp::Ordering::Equal => {}
        // More writes were handed off while the drain ran, and those went too.
        std::cmp::Ordering::Greater => mark(pool, lost - at_risk, AT_RISK_REASON).await,
    }
}

async fn mark(pool: &sqlx::SqlitePool, writes: u64, reason: &str) {
    let marker = health::record_persisted_loss(pool, writes, reason);
    if tokio::time::timeout(MARKER_TIMEOUT, marker).await.is_err() {
        // The database is the only place this warning could live, and it is the
        // thing that is stalling — there is nothing left to try.
        warn!(writes, "timed out recording the lost usage writes");
    }
}

#[cfg(test)]
mod tests {
    use super::{flush, flush_within, mark, settle, spawn_tracked, AT_RISK_REASON, IN_FLIGHT};
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    /// Read the marker straight out of this test's own database — `health`'s
    /// snapshot also consults process-global counters the rest of the suite
    /// writes to.
    async fn persisted(pool: &sqlx::SqlitePool) -> i64 {
        sqlx::query_scalar(
            "SELECT COALESCE((SELECT dropped_writes FROM usage_recording_losses), 0)",
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    // The marker is the only evidence that outlives this process, so it cannot
    // wait on the drain: by the time a drain has timed out, the database busy
    // enough to cause that is the same one being asked to take the marker, on
    // whatever is left of the shutdown budget. Written up front, it survives
    // that — and a SIGKILL mid-drain.
    #[tokio::test]
    async fn claims_the_writes_before_waiting_for_them() {
        let pool = pool().await;
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        spawn_tracked(async move {
            let _ = rx.await;
        });

        let flushing = tokio::spawn({
            let pool = pool.clone();
            async move { flush_within(&pool, Duration::from_millis(750)).await }
        });

        // Well inside the drain budget, with the write still parked.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            persisted(&pool).await >= 1,
            "the loss is on disk before the drain gives up"
        );

        let _ = tx.send(());
        flushing.await.unwrap();
    }

    #[tokio::test]
    async fn a_drain_that_delivers_gives_the_claim_back() {
        let pool = pool().await;
        mark(&pool, 4, AT_RISK_REASON).await;

        settle(&pool, 4, 0).await;

        assert_eq!(
            persisted(&pool).await,
            0,
            "writes that landed leave no warning behind"
        );
    }

    #[tokio::test]
    async fn a_partial_drain_keeps_only_what_was_lost() {
        let pool = pool().await;
        mark(&pool, 4, AT_RISK_REASON).await;

        settle(&pool, 4, 1).await;

        assert_eq!(persisted(&pool).await, 1);
    }

    #[tokio::test]
    async fn writes_handed_off_during_the_drain_are_counted_too() {
        let pool = pool().await;
        mark(&pool, 2, AT_RISK_REASON).await;

        // Recording never stops until the process does, so the count can grow
        // between the claim and the deadline.
        settle(&pool, 2, 5).await;

        assert_eq!(persisted(&pool).await, 5);
    }

    #[tokio::test]
    async fn an_earlier_runs_loss_survives_a_clean_drain() {
        let pool = pool().await;
        mark(&pool, 3, "3 usage writes did not finish before shutdown").await;

        // This run claims and gives back its own writes; the retraction must
        // not eat the loss the previous run really did suffer.
        mark(&pool, 2, AT_RISK_REASON).await;
        settle(&pool, 2, 0).await;

        assert_eq!(persisted(&pool).await, 3);
    }

    // Asserted on the counter rather than on elapsed time: `IN_FLIGHT` is
    // process-global, so the writes other tests hand off count here too and a
    // wall-clock bound would be at the mercy of the rest of the suite.
    #[tokio::test]
    async fn flush_waits_for_a_write_that_has_not_landed_yet() {
        let pool = pool().await;
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
