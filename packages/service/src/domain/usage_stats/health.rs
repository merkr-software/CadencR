use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use utoipa::ToSchema;

/// Provider usage operations that failed, surfaced to the user.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UsageRecordingIssue {
    /// Failures seen in this run plus durable losses from earlier runs.
    pub failures: i64,
    /// Message from the most recent failure.
    pub last_error: String,
}

const PERSISTED_SQL: &str =
    "SELECT dropped_writes, last_error FROM usage_recording_losses WHERE id = 1";
const RECORD_LOSS_SQL: &str = "
    INSERT INTO usage_recording_losses (id, dropped_writes, last_error, last_at)
    VALUES (1, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
        dropped_writes = dropped_writes + excluded.dropped_writes,
        last_error = excluded.last_error,
        last_at = excluded.last_at
";
const CLEAR_LOSSES_SQL: &str = "DELETE FROM usage_recording_losses";

static FAILURES: AtomicU64 = AtomicU64::new(0);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn record_failure(error: &str) {
    FAILURES.fetch_add(1, Ordering::Relaxed);
    *LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error.to_string());
}

/// Persist a permanent usage loss so its warning survives process exit.
pub async fn record_persisted_loss(
    pool: &SqlitePool,
    lost_operations: u64,
    error: &str,
) -> Result<(), sqlx::Error> {
    if lost_operations == 0 {
        return Ok(());
    }
    sqlx::query(RECORD_LOSS_SQL)
        .bind(i64::try_from(lost_operations).unwrap_or(i64::MAX))
        .bind(error)
        .execute(pool)
        .await?;
    Ok(())
}

/// Acknowledge every usage-data failure reported so far. A later failure warns
/// again.
pub async fn acknowledge(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Clear the fallback state before awaiting SQLite. A new failure recorded
    // while the DELETE is pending must remain visible after this acknowledgement.
    let previous_failures = FAILURES.swap(0, Ordering::Relaxed);
    let previous_error = LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    match sqlx::query(CLEAR_LOSSES_SQL).execute(pool).await {
        Ok(_) => Ok(()),
        Err(error) => {
            FAILURES.fetch_add(previous_failures, Ordering::Relaxed);
            let mut last_error = LAST_ERROR
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if last_error.is_none() {
                *last_error = previous_error;
            }
            Err(error)
        }
    }
}

/// `None` when every provider usage operation has succeeded across runs.
pub async fn snapshot(pool: &SqlitePool) -> Result<Option<UsageRecordingIssue>, sqlx::Error> {
    let (persisted_failures, persisted_error) = persisted(pool).await?;
    let failures = FAILURES
        .load(Ordering::Relaxed)
        .saturating_add(persisted_failures);
    if failures == 0 {
        return Ok(None);
    }
    let last_error = LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .or(persisted_error)
        .unwrap_or_else(|| "unknown error".to_string());
    Ok(Some(UsageRecordingIssue {
        failures: i64::try_from(failures).unwrap_or(i64::MAX),
        last_error,
    }))
}

async fn persisted(pool: &SqlitePool) -> Result<(u64, Option<String>), sqlx::Error> {
    let Some(row) = sqlx::query(PERSISTED_SQL).fetch_optional(pool).await? else {
        return Ok((0, None));
    };
    let count = row
        .try_get::<i64, _>("dropped_writes")
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(0);
    let error = row
        .try_get::<String, _>("last_error")
        .ok()
        .filter(|error| !error.is_empty());
    Ok((count, error))
}

#[cfg(test)]
fn reset_for_test() {
    FAILURES.store(0, Ordering::Relaxed);
    *LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // Process globals make one serialized scenario safer than several tests
    // racing resets against one another.
    #[tokio::test]
    async fn reports_runtime_and_persisted_failures_until_acknowledged() {
        let pool = pool().await;
        reset_for_test();
        assert!(snapshot(&pool).await.unwrap().is_none());

        record_failure("database is locked");
        assert_eq!(snapshot(&pool).await.unwrap().unwrap().failures, 1);
        reset_for_test();

        record_persisted_loss(&pool, 2, "writes cancelled at shutdown")
            .await
            .unwrap();
        assert_eq!(
            snapshot(&pool).await.unwrap().unwrap().failures,
            2,
            "a durable loss is not also counted as a volatile failure"
        );
        reset_for_test();
        let issue = snapshot(&pool)
            .await
            .unwrap()
            .expect("loss survives a restart");
        assert_eq!(issue.failures, 2);
        assert_eq!(issue.last_error, "writes cancelled at shutdown");

        acknowledge(&pool).await.unwrap();
        assert!(snapshot(&pool).await.unwrap().is_none());
    }
}
