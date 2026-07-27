use sqlx::SqlitePool;

use super::models::{UsageAttribution, UsageStatsEntry};

/// Add words to one day's bucket for a provider / model / effort combination.
///
/// Upsert rather than append: the table holds one row per bucket per UTC day,
/// so it stays bounded however heavily the app is used. A NULL `day` bind means
/// "today", computed in SQLite so it always matches the `date('now')` window the
/// read query uses; the backfill importer binds the message's own day instead.
const UPSERT_SQL: &str = "
    INSERT INTO provider_usage_stats
        (day, provider_id, model_id, thinking_effort, input_words, output_words, updated_at)
    VALUES (COALESCE(?, strftime('%Y-%m-%d', 'now')), ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(day, provider_id, model_id, thinking_effort) DO UPDATE SET
        input_words = input_words + excluded.input_words,
        output_words = output_words + excluded.output_words,
        updated_at = datetime('now')
";

/// Both bounds are derived from the caller's captured end day rather than from
/// `now`, so the rows can never describe a window other than the one the client
/// is told it is looking at — a request that straddles UTC midnight would
/// otherwise pair yesterday's `end_day` with a window shifted a day later.
const SELECT_WINDOW_SQL: &str = "
    SELECT day, provider_id, model_id, thinking_effort, input_words, output_words
    FROM provider_usage_stats
    WHERE day >= date(?, ?)
      AND day <= ?
      AND (input_words > 0 OR output_words > 0)
    ORDER BY day ASC, provider_id ASC, model_id ASC, thinking_effort ASC
";

pub async fn add_words(
    write_pool: &SqlitePool,
    attribution: &UsageAttribution,
    input_words: u64,
    output_words: u64,
) -> Result<(), sqlx::Error> {
    add_words_on_day(write_pool, None, attribution, input_words, output_words).await
}

/// [`add_words`] against an explicit day and any executor, so the backfill can
/// import historical days inside its own transaction.
pub(super) async fn add_words_on_day<'e, E>(
    executor: E,
    day: Option<&str>,
    attribution: &UsageAttribution,
    input_words: u64,
    output_words: u64,
) -> Result<(), sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(UPSERT_SQL)
        .bind(day)
        .bind(&attribution.provider_id)
        .bind(&attribution.model_id)
        .bind(&attribution.thinking_effort)
        .bind(input_words as i64)
        .bind(output_words as i64)
        .execute(executor)
        .await?;
    Ok(())
}

/// Every bucket from the `days`-day window ending on `end_day`, oldest first.
pub async fn list_window(
    read_pool: &SqlitePool,
    end_day: &str,
    days: i64,
) -> Result<Vec<UsageStatsEntry>, sqlx::Error> {
    // `days` counts the end day itself, so a 30-day window starts 29 days back.
    let offset = format!("-{} days", days.saturating_sub(1).max(0));
    sqlx::query_as::<_, UsageStatsEntry>(SELECT_WINDOW_SQL)
        .bind(end_day)
        .bind(offset)
        .bind(end_day)
        .fetch_all(read_pool)
        .await
}

/// The window's last day, as SQLite sees "today" in UTC.
///
/// Read from the same database that computed the `day` column on write, and
/// then used as the anchor for both ends of the read window, so the axis the
/// client draws can never drift off the rows it is drawing.
pub async fn end_day(read_pool: &SqlitePool) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT strftime('%Y-%m-%d', 'now')")
        .fetch_one(read_pool)
        .await
}

/// The trailing window ending today. Test-only sugar over [`list_window`],
/// which takes an explicit end day so the API read can anchor both of the
/// window's bounds to a single captured value.
#[cfg(test)]
pub(crate) async fn list_recent(
    read_pool: &SqlitePool,
    days: i64,
) -> Result<Vec<UsageStatsEntry>, sqlx::Error> {
    let end_day = end_day(read_pool).await?;
    list_window(read_pool, &end_day, days).await
}

#[cfg(test)]
mod tests {
    use super::{add_words, list_recent, list_window};
    use crate::domain::usage_stats::models::UsageAttribution;
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

    async fn window(pool: &SqlitePool, days: i64) -> Vec<super::UsageStatsEntry> {
        list_recent(pool, days).await.unwrap()
    }

    fn attribution(provider: &str, model: &str, effort: &str) -> UsageAttribution {
        UsageAttribution {
            provider_id: provider.into(),
            model_id: model.into(),
            thinking_effort: effort.into(),
        }
    }

    #[tokio::test]
    async fn accumulates_into_one_row_per_bucket_per_day() {
        let pool = pool().await;
        let bucket = attribution("claude_code", "claude-opus-5", "high");

        add_words(&pool, &bucket, 10, 100).await.unwrap();
        add_words(&pool, &bucket, 5, 50).await.unwrap();

        let entries = window(&pool, 30).await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].input_words, 15);
        assert_eq!(entries[0].output_words, 150);
        assert_eq!(entries[0].thinking_effort, "high");
    }

    #[tokio::test]
    async fn keeps_effort_levels_of_the_same_model_apart() {
        let pool = pool().await;
        add_words(&pool, &attribution("claude_code", "opus", "high"), 1, 2)
            .await
            .unwrap();
        add_words(&pool, &attribution("claude_code", "opus", "low"), 3, 4)
            .await
            .unwrap();

        let entries = window(&pool, 30).await;
        assert_eq!(entries.len(), 2);
        // Ordered by effort ascending: "high" before "low".
        assert_eq!(entries[0].thinking_effort, "high");
        assert_eq!(entries[1].output_words, 4);
    }

    #[tokio::test]
    async fn upserts_across_empty_model_and_effort() {
        let pool = pool().await;
        let unknown = attribution("codex", "", "");
        add_words(&pool, &unknown, 7, 0).await.unwrap();
        add_words(&pool, &unknown, 3, 0).await.unwrap();

        let entries = window(&pool, 30).await;
        assert_eq!(entries.len(), 1, "NULL-vs-empty must not split the bucket");
        assert_eq!(entries[0].input_words, 10);
    }

    #[tokio::test]
    async fn window_excludes_days_older_than_the_range() {
        let pool = pool().await;
        add_words(&pool, &attribution("cursor", "auto", ""), 1, 1)
            .await
            .unwrap();
        sqlx::query("UPDATE provider_usage_stats SET day = date('now', '-40 days')")
            .execute(&pool)
            .await
            .unwrap();

        assert!(window(&pool, 30).await.is_empty());
        assert_eq!(window(&pool, 90).await.len(), 1);
    }

    // The read hands the client an `end_day` and the rows behind it. A request
    // that straddles UTC midnight must not answer with rows the axis it also
    // returned has nowhere to draw.
    #[tokio::test]
    async fn window_stops_at_the_captured_end_day() {
        let pool = pool().await;
        let yesterday = sqlx::query_scalar::<_, String>("SELECT date('now', '-1 day')")
            .fetch_one(&pool)
            .await
            .unwrap();
        add_words(&pool, &attribution("opencode", "auto", ""), 1, 1)
            .await
            .unwrap();

        // Today's row is already past the window that ended yesterday.
        assert!(list_window(&pool, &yesterday, 30).await.unwrap().is_empty());
        assert_eq!(window(&pool, 30).await.len(), 1);
    }
}
