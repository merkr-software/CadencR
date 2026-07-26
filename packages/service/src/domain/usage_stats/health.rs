use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use utoipa::ToSchema;

/// A usage write that failed, surfaced to the user.
///
/// Usage recording is deliberately fire-and-forget so a counter can never fail
/// an agent turn — but "cannot fail the turn" is not the same as "may be
/// swallowed". Failures are counted here and reported on the next
/// `/api/usage-stats` read, so the Stats tab can tell the user its numbers are
/// incomplete instead of quietly under-reporting.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UsageRecordingIssue {
    /// Failed usage writes: those seen since this start, plus any earlier run's
    /// writes that were lost at shutdown.
    pub failures: i64,
    /// Message from the most recent failure.
    pub last_error: String,
}

const PERSISTED_SQL: &str = "SELECT dropped_writes, last_error FROM usage_recording_losses";

const RECORD_LOSS_SQL: &str = "
    INSERT INTO usage_recording_losses (id, dropped_writes, last_error, last_at)
    VALUES (1, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
        dropped_writes = dropped_writes + excluded.dropped_writes,
        last_error = excluded.last_error,
        last_at = excluded.last_at
";

static FAILURES: AtomicU64 = AtomicU64::new(0);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn record_failure(error: &str) {
    FAILURES.fetch_add(1, Ordering::Relaxed);
    // A poisoned lock only means a previous writer panicked mid-update; the
    // stored message is still safe to replace, so recover rather than
    // propagate a panic out of a best-effort reporting path.
    let mut last = LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *last = Some(error.to_string());
}

/// Remember writes that were lost for good, across restarts.
///
/// Process-global counters die with the process, so a loss discovered *during*
/// shutdown could never reach the "next read" that is supposed to report it.
/// This is the one failure that has to outlive the run that caused it.
pub async fn record_persisted_loss(pool: &SqlitePool, dropped_writes: u64, error: &str) {
    let dropped = i64::try_from(dropped_writes).unwrap_or(i64::MAX);
    if let Err(error) = sqlx::query(RECORD_LOSS_SQL)
        .bind(dropped)
        .bind(error)
        .execute(pool)
        .await
    {
        // Nothing left to fall back on: the database is the thing that failed.
        tracing::error!(%error, "failed to persist the lost usage writes marker");
    }
}

/// `None` when every usage write so far has succeeded, in this run and in every
/// earlier one.
pub async fn snapshot(pool: &SqlitePool) -> Option<UsageRecordingIssue> {
    let (persisted_failures, persisted_error) = persisted(pool).await;
    let failures = FAILURES.load(Ordering::Relaxed) + persisted_failures;
    if failures == 0 {
        return None;
    }
    let last_error = LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .or(persisted_error)
        .unwrap_or_else(|| "unknown error".to_string());
    Some(UsageRecordingIssue {
        failures: i64::try_from(failures).unwrap_or(i64::MAX),
        last_error,
    })
}

/// Losses carried over from earlier runs. A read failure here must not hide the
/// in-process failures, so it degrades to "nothing persisted".
async fn persisted(pool: &SqlitePool) -> (u64, Option<String>) {
    let Ok(Some(row)) = sqlx::query(PERSISTED_SQL).fetch_optional(pool).await else {
        return (0, None);
    };
    let dropped = row.try_get::<i64, _>("dropped_writes").unwrap_or(0);
    let last_error = row.try_get::<String, _>("last_error").ok();
    (
        u64::try_from(dropped).unwrap_or(0),
        last_error.filter(|error| !error.is_empty()),
    )
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    FAILURES.store(0, Ordering::Relaxed);
    *LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::{record_failure, record_persisted_loss, reset_for_test, snapshot};
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // These tests share process-global state, so they are serialized behind one
    // test rather than racing each other across the harness threads.
    #[tokio::test]
    async fn counts_and_reports_failures() {
        let pool = pool().await;
        reset_for_test();
        assert!(
            snapshot(&pool).await.is_none(),
            "clean start reports no issue"
        );

        record_failure("disk full");
        let issue = snapshot(&pool).await.expect("a failure must be reported");
        assert_eq!(issue.failures, 1);
        assert_eq!(issue.last_error, "disk full");

        record_failure("database is locked");
        let issue = snapshot(&pool).await.expect("failures accumulate");
        assert_eq!(issue.failures, 2);
        assert_eq!(
            issue.last_error, "database is locked",
            "the most recent error wins"
        );

        reset_for_test();
        assert!(snapshot(&pool).await.is_none());
    }

    /// The point of persisting: the run that lost the writes is gone by the
    /// time anyone reads the stats.
    #[tokio::test]
    async fn a_loss_from_an_earlier_run_still_warns_after_a_restart() {
        let pool = pool().await;
        reset_for_test();

        record_persisted_loss(&pool, 3, "3 usage writes did not finish before shutdown").await;
        // A fresh process: the in-memory counters know nothing.
        reset_for_test();

        let issue = snapshot(&pool)
            .await
            .expect("the loss outlived the process");
        assert_eq!(issue.failures, 3);
        assert!(issue.last_error.contains("did not finish"));

        record_persisted_loss(&pool, 2, "2 usage writes did not finish before shutdown").await;
        assert_eq!(
            snapshot(&pool).await.unwrap().failures,
            5,
            "losses accumulate across runs"
        );
        reset_for_test();
    }
}
