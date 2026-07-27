//! One-time import of usage stats from conversations that predate the table.
//!
//! Live recording only sees turns taken from now on, so without this an
//! existing install opens the Stats tab on an empty chart with months of
//! history sitting unread in `agent_messages`. This walks those messages once,
//! counts them with the same counter the live path uses, and folds them into
//! the same per-day buckets.
//!
//! The cutoff is claimed on the caller's path at startup; the scan itself runs
//! in the background, because on a large database it reads hundreds of
//! megabytes of message text, which must not sit in front of the app starting.
//! Claiming first means the boundary between "history" and "live" is fixed
//! before the service accepts its first prompt.

use std::collections::HashMap;

use sqlx::{Row, SqlitePool};
use tracing::{info, warn};

use super::health;
use super::models::UsageAttribution;
use super::repository;

pub mod ownership;
mod scan;
#[cfg(test)]
pub(crate) mod test_fixtures;

pub use ownership::owns_prompt;

/// Raising this re-runs the import — see the migration for what else that needs.
const VERSION: i64 = 1;

const CLAIM_SQL: &str = "
    INSERT INTO provider_usage_backfill (id, version, cutoff_message_id, claimed_at)
    VALUES (1, 0, (SELECT COALESCE(MAX(id), 0) FROM agent_messages), datetime('now'))
    ON CONFLICT(id) DO NOTHING
";

const MARKER_SQL: &str =
    "SELECT version, cutoff_message_id, claimed_at FROM provider_usage_backfill WHERE id = 1";

const FINISH_SQL: &str = "
    UPDATE provider_usage_backfill
    SET version = ?, messages_scanned = ?, completed_at = datetime('now')
    WHERE id = 1
";

/// Bucket key: UTC day, provider, model, thinking effort.
type BucketKey = (String, String, String, String);

#[derive(Default)]
struct Bucket {
    input_words: u64,
    output_words: u64,
}

/// What the import covers: everything up to `cutoff_message_id` that had
/// already been delivered at `claimed_at`.
struct Claim {
    cutoff_message_id: i64,
    /// `None` only for a claim made before the column existed.
    claimed_at: Option<String>,
}

/// Claim the import's boundary, then import the history behind it.
///
/// The claim is awaited so that no prompt can be dispatched before the boundary
/// exists; the scan is spawned, because nothing waits on it. A failure leaves
/// the marker unfinished so the next start retries, and is surfaced through
/// [`health`] so the Stats tab can say the numbers are incomplete rather than
/// quietly showing a short history.
pub async fn start(write_pool: &SqlitePool) {
    let claim = match claim(write_pool).await {
        Ok(Some(claim)) => claim,
        Ok(None) => return,
        Err(error) => {
            health::record_failure(&error.to_string());
            warn!(%error, "failed to claim the historical usage stats import");
            return;
        }
    };

    let pool = write_pool.clone();
    tokio::spawn(async move {
        if let Err(error) = import(&pool, &claim).await {
            health::record_failure(&error.to_string());
            warn!(%error, "failed to import historical provider usage stats");
        }
    });
}

/// Is an import claimed but not yet finished?
///
/// The buckets are published in one final transaction, so until this turns
/// false the Stats tab is looking at a partial — usually empty — history and
/// should keep asking.
pub async fn in_progress(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    let version: Option<i64> =
        sqlx::query_scalar("SELECT version FROM provider_usage_backfill WHERE id = 1")
            .fetch_optional(pool)
            .await?;
    Ok(version.is_some_and(|version| version < VERSION))
}

async fn import(write_pool: &SqlitePool, claim: &Claim) -> Result<(), sqlx::Error> {
    let (buckets, messages_scanned) = scan::collect(write_pool, claim).await?;
    let bucket_count = buckets.len();
    commit(write_pool, buckets, messages_scanned).await?;

    if messages_scanned > 0 {
        info!(
            messages_scanned,
            bucket_count, "imported historical provider usage stats"
        );
    }
    Ok(())
}

/// Claim the import, returning what it covers, or `None` when a previous run
/// already finished.
///
/// The boundary is fixed on the *first* attempt and reused by every retry, so
/// turns taken while an attempt was failing stay outside the import and are
/// only ever counted by the live recorder.
async fn claim(write_pool: &SqlitePool) -> Result<Option<Claim>, sqlx::Error> {
    sqlx::query(CLAIM_SQL).execute(write_pool).await?;

    let row = sqlx::query(MARKER_SQL).fetch_one(write_pool).await?;
    let version: i64 = row.try_get("version")?;
    if version >= VERSION {
        return Ok(None);
    }
    Ok(Some(Claim {
        cutoff_message_id: row.try_get("cutoff_message_id")?,
        claimed_at: row.try_get("claimed_at")?,
    }))
}

/// Write every bucket and the finished marker in one transaction, so a crash
/// mid-import leaves no half-counted history behind.
async fn commit(
    write_pool: &SqlitePool,
    buckets: HashMap<BucketKey, Bucket>,
    messages_scanned: i64,
) -> Result<(), sqlx::Error> {
    let mut tx = write_pool.begin().await?;
    for ((day, provider_id, model_id, thinking_effort), bucket) in buckets {
        let attribution = UsageAttribution {
            provider_id,
            model_id,
            thinking_effort,
        };
        repository::add_words_on_day(
            &mut *tx,
            Some(&day),
            &attribution,
            bucket.input_words,
            bucket.output_words,
        )
        .await?;
    }
    sqlx::query(FINISH_SQL)
        .bind(VERSION)
        .bind(messages_scanned)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

#[cfg(test)]
/// Claim and import inline, for tests that want the whole thing to have
/// happened by the time they assert.
async fn run(write_pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let Some(claim) = claim(write_pool).await? else {
        return Ok(());
    };
    import(write_pool, &claim).await
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::{message, pool, session, today};
    use super::{in_progress, run, VERSION};
    use crate::domain::usage_stats::repository::list_recent;
    use sqlx::Row;

    #[tokio::test]
    async fn running_twice_does_not_double_count() {
        let pool = pool().await;
        let now = today(&pool).await;
        session(&pool, 1, "claude_code", "opus", "").await;
        message(&pool, 1, "user", "user_message", "one two three", &now).await;

        run(&pool).await.unwrap();
        run(&pool).await.unwrap();

        let entries = list_recent(&pool, 30).await.unwrap();
        assert_eq!(entries[0].input_words, 3);
        let version: i64 =
            sqlx::query_scalar("SELECT version FROM provider_usage_backfill WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(version, VERSION);
    }

    #[tokio::test]
    async fn a_retry_keeps_the_boundary_claimed_by_the_first_attempt() {
        let pool = pool().await;
        let now = today(&pool).await;
        session(&pool, 1, "claude_code", "opus", "").await;
        message(&pool, 1, "user", "user_message", "one two three", &now).await;

        // Stand in for an attempt that claimed the boundary and then died before
        // writing anything.
        super::claim(&pool).await.unwrap();

        // A turn taken before the retry: the live recorder owns these words, so
        // the import must leave them alone.
        message(&pool, 1, "user", "user_message", "four five", &now).await;

        run(&pool).await.unwrap();

        let entries = list_recent(&pool, 30).await.unwrap();
        assert_eq!(
            entries[0].input_words, 3,
            "only messages that predate the claim are imported"
        );
    }

    #[tokio::test]
    async fn a_fresh_install_records_the_marker_without_importing_anything() {
        let pool = pool().await;

        run(&pool).await.unwrap();

        assert!(list_recent(&pool, 30).await.unwrap().is_empty());
        let row = sqlx::query("SELECT version, messages_scanned FROM provider_usage_backfill")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.try_get::<i64, _>("version").unwrap(), VERSION);
        assert_eq!(row.try_get::<i64, _>("messages_scanned").unwrap(), 0);
    }

    #[tokio::test]
    async fn reports_progress_from_claim_until_the_buckets_are_published() {
        let pool = pool().await;
        assert!(
            !in_progress(&pool).await.unwrap(),
            "nothing is running before the first claim"
        );

        super::claim(&pool).await.unwrap();
        assert!(in_progress(&pool).await.unwrap());

        run(&pool).await.unwrap();
        assert!(!in_progress(&pool).await.unwrap());
    }
}
