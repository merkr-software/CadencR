//! One-time import of usage stats from conversations that predate the table.
//!
//! Live recording only sees turns taken from now on, so without this an
//! existing install opens the Stats tab on an empty chart with months of
//! history sitting unread in `agent_messages`. This walks those messages once,
//! counts them with the same counter the live path uses, and folds them into
//! the same per-day buckets.
//!
//! Runs in the background: on a large database the scan reads hundreds of
//! megabytes of message text, which must not sit in front of the app starting.

use std::collections::HashMap;

use sqlx::{Row, SqlitePool};
use tracing::{info, warn};

use super::health;
use super::models::UsageAttribution;
use super::repository;
use super::word_count::count_words;

/// Raising this re-runs the import — see the migration for what else that needs.
const VERSION: i64 = 1;

/// Rows per scan query. Message text can be tens of kilobytes each, so this
/// trades a few hundred queries against holding the whole history in memory.
const BATCH_SIZE: i64 = 500;

const CLAIM_SQL: &str = "
    INSERT INTO provider_usage_backfill (id, version, cutoff_message_id)
    VALUES (1, 0, (SELECT COALESCE(MAX(id), 0) FROM agent_messages))
    ON CONFLICT(id) DO NOTHING
";

const MARKER_SQL: &str =
    "SELECT version, cutoff_message_id FROM provider_usage_backfill WHERE id = 1";

const FINISH_SQL: &str = "
    UPDATE provider_usage_backfill
    SET version = ?, messages_scanned = ?, completed_at = datetime('now')
    WHERE id = 1
";

/// Every message that carries countable prose, joined to what it should be
/// attributed to. `date()` normalizes the two timestamp shapes the column has
/// picked up over time, and returns NULL for anything unparseable.
///
/// `message_model` is the model that produced the message — finer-grained than
/// the session's current model, so a session whose model was switched mid-way
/// splits across both. User prompts carry no model of their own, so they borrow
/// the one from the reply they drew: without that, every prompt would pile into
/// a separate bucket (usually the session's `default`) and the model chart would
/// show replies with no prompts beside them.
const SCAN_SQL: &str = "
    SELECT m.id AS message_id,
           date(m.created_at) AS day,
           m.role AS role,
           m.content AS content,
           COALESCE(
               NULLIF(m.model, ''),
               (SELECT NULLIF(reply.model, '')
                  FROM agent_messages reply
                 WHERE reply.session_id = m.session_id
                   AND reply.id > m.id
                   AND reply.model IS NOT NULL
                   AND reply.model <> ''
                 ORDER BY reply.id ASC
                 LIMIT 1)
           ) AS message_model,
           s.runtime_provider AS provider_id,
           s.model AS session_model,
           s.thinking_effort AS thinking_effort
    FROM agent_messages m
    JOIN agent_sessions s ON s.id = m.session_id
    WHERE m.id > ?
      AND m.id <= ?
      AND m.message_type IN ('user_message', 'text', 'thinking')
      AND s.runtime_provider IS NOT NULL
      AND s.runtime_provider <> ''
    ORDER BY m.id ASC
    LIMIT ?
";

/// Bucket key: UTC day, provider, model, thinking effort.
type BucketKey = (String, String, String, String);

#[derive(Default)]
struct Bucket {
    input_words: u64,
    output_words: u64,
}

/// Import historical usage unless it has already been imported.
///
/// Fire-and-forget: a failure leaves the marker unfinished so the next start
/// retries, and is surfaced through [`health`] so the Stats tab can say the
/// numbers are incomplete rather than quietly showing a short history.
pub fn spawn(write_pool: &SqlitePool) {
    let pool = write_pool.clone();
    tokio::spawn(async move {
        if let Err(error) = run(&pool).await {
            health::record_failure(&error.to_string());
            warn!(%error, "failed to import historical provider usage stats");
        }
    });
}

async fn run(write_pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let Some(cutoff_message_id) = claim(write_pool).await? else {
        return Ok(());
    };

    let (buckets, messages_scanned) = collect(write_pool, cutoff_message_id).await?;
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

/// Claim the import, returning the message id to scan up to, or `None` when a
/// previous run already finished.
///
/// The cutoff is fixed on the *first* attempt and reused by every retry, so
/// turns taken while an attempt was failing stay outside the import and are
/// only ever counted by the live recorder.
async fn claim(write_pool: &SqlitePool) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query(CLAIM_SQL).execute(write_pool).await?;

    let row = sqlx::query(MARKER_SQL).fetch_one(write_pool).await?;
    let version: i64 = row.try_get("version")?;
    if version >= VERSION {
        return Ok(None);
    }
    Ok(Some(row.try_get("cutoff_message_id")?))
}

/// Walk the history in id order, folding every message into its day bucket.
async fn collect(
    write_pool: &SqlitePool,
    cutoff_message_id: i64,
) -> Result<(HashMap<BucketKey, Bucket>, i64), sqlx::Error> {
    let mut buckets: HashMap<BucketKey, Bucket> = HashMap::new();
    let mut messages_scanned = 0_i64;
    let mut last_id = 0_i64;

    loop {
        let rows = sqlx::query(SCAN_SQL)
            .bind(last_id)
            .bind(cutoff_message_id)
            .bind(BATCH_SIZE)
            .fetch_all(write_pool)
            .await?;
        if rows.is_empty() {
            return Ok((buckets, messages_scanned));
        }

        for row in &rows {
            last_id = row.try_get("message_id")?;
            messages_scanned += 1;
            absorb(&mut buckets, row)?;
        }
    }
}

/// Fold one message into its bucket. Rows we cannot place — an unparseable
/// timestamp — are skipped rather than lumped onto an arbitrary day.
fn absorb(
    buckets: &mut HashMap<BucketKey, Bucket>,
    row: &sqlx::sqlite::SqliteRow,
) -> Result<(), sqlx::Error> {
    let Some(day) = row.try_get::<Option<String>, _>("day")? else {
        return Ok(());
    };
    let words = count_words(&row.try_get::<String, _>("content")?);
    if words == 0 {
        return Ok(());
    }

    // See `SCAN_SQL` for how a message's model is resolved; the session's own
    // model is the last resort, for history written before the column existed.
    let model_id = match non_empty(row.try_get("message_model")?) {
        Some(model_id) => Some(model_id),
        None => non_empty(row.try_get("session_model")?),
    }
    .unwrap_or_default();
    // Thinking effort has no per-message record, so historical rows inherit the
    // session's current effort. It is the one field the import can only
    // approximate.
    let thinking_effort = non_empty(row.try_get("thinking_effort")?).unwrap_or_default();
    let key = (day, row.try_get("provider_id")?, model_id, thinking_effort);

    let bucket = buckets.entry(key).or_default();
    if row.try_get::<String, _>("role")? == "user" {
        bucket.input_words += words;
    } else {
        bucket.output_words += words;
    }
    Ok(())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
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
mod tests {
    use super::{run, VERSION};
    use crate::domain::usage_stats::repository::list_window;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Row, SqlitePool};

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p');
             INSERT INTO features (id, project_id, title) VALUES (1, 1, 'f');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn session(pool: &SqlitePool, id: i64, provider: &str, model: &str, effort: &str) {
        sqlx::query(
            "INSERT INTO agent_sessions
                 (id, feature_id, agent_type, runtime_provider, model, thinking_effort)
             VALUES (?, 1, 'session', ?, ?, ?)",
        )
        .bind(id)
        .bind(provider)
        .bind(model)
        .bind(effort)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn message(
        pool: &SqlitePool,
        session_id: i64,
        role: &str,
        message_type: &str,
        content: &str,
        created_at: &str,
    ) {
        insert_message(
            pool,
            session_id,
            role,
            message_type,
            content,
            created_at,
            None,
        )
        .await;
    }

    /// A message stamped with the model that produced it, as assistant rows are.
    async fn with_model(
        pool: &SqlitePool,
        session_id: i64,
        role: &str,
        message_type: &str,
        content: &str,
        created_at: &str,
        model: &str,
    ) {
        insert_message(
            pool,
            session_id,
            role,
            message_type,
            content,
            created_at,
            Some(model),
        )
        .await;
    }

    async fn insert_message(
        pool: &SqlitePool,
        session_id: i64,
        role: &str,
        message_type: &str,
        content: &str,
        created_at: &str,
        model: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO agent_messages
                 (session_id, role, message_type, content, created_at, model)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(role)
        .bind(message_type)
        .bind(content)
        .bind(created_at)
        .bind(model)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Today, in the same shape SQLite writes it, so imported rows land inside
    /// the window `list_window` reads.
    async fn today(pool: &SqlitePool) -> String {
        sqlx::query_scalar("SELECT strftime('%Y-%m-%d %H:%M:%S', 'now')")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn imports_prompts_and_replies_of_an_existing_conversation() {
        let pool = pool().await;
        let now = today(&pool).await;
        session(&pool, 1, "claude_code", "opus", "high").await;
        message(&pool, 1, "user", "user_message", "one two three", &now).await;
        message(&pool, 1, "assistant", "text", "four five", &now).await;
        message(&pool, 1, "assistant", "thinking", "six", &now).await;

        run(&pool).await.unwrap();

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].input_words, 3);
        assert_eq!(entries[0].output_words, 3, "text and thinking both count");
        assert_eq!(entries[0].model_id, "opus");
        assert_eq!(entries[0].thinking_effort, "high");
    }

    /// A prompt has no model of its own; charting it apart from the reply it
    /// drew would show every model with replies but no prompts.
    #[tokio::test]
    async fn a_prompt_is_attributed_to_the_model_that_answered_it() {
        let pool = pool().await;
        let now = today(&pool).await;
        // The session's *current* model is not what answered these prompts.
        session(&pool, 1, "claude_code", "default", "high").await;
        message(&pool, 1, "user", "user_message", "one two", &now).await;
        with_model(&pool, 1, "assistant", "text", "three", &now, "opus").await;
        message(&pool, 1, "user", "user_message", "four", &now).await;
        with_model(&pool, 1, "assistant", "text", "five six", &now, "haiku").await;

        run(&pool).await.unwrap();

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(entries.len(), 2, "one bucket per answering model");
        let haiku = entries.iter().find(|e| e.model_id == "haiku").unwrap();
        assert_eq!((haiku.input_words, haiku.output_words), (1, 2));
        let opus = entries.iter().find(|e| e.model_id == "opus").unwrap();
        assert_eq!((opus.input_words, opus.output_words), (2, 1));
        assert!(
            !entries.iter().any(|e| e.model_id == "default"),
            "the session's fallback model must not collect the prompts"
        );
    }

    #[tokio::test]
    async fn skips_tool_traffic_and_sessions_without_a_provider() {
        let pool = pool().await;
        let now = today(&pool).await;
        session(&pool, 1, "claude_code", "opus", "").await;
        session(&pool, 2, "", "opus", "").await;
        message(&pool, 1, "assistant", "tool_call", "a b c d e", &now).await;
        message(&pool, 1, "tool", "tool_result", "f g h i j", &now).await;
        message(&pool, 2, "user", "user_message", "k l m", &now).await;

        run(&pool).await.unwrap();

        assert!(list_window(&pool, 30).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn splits_history_across_days_and_models() {
        let pool = pool().await;
        session(&pool, 1, "claude_code", "opus", "high").await;
        // The ISO-8601 shape older rows carry, which `date()` must still parse.
        message(
            &pool,
            1,
            "user",
            "user_message",
            "one two",
            "2026-07-20T10:00:00Z",
        )
        .await;
        message(
            &pool,
            1,
            "user",
            "user_message",
            "three",
            "2026-07-21 10:00:00",
        )
        .await;

        run(&pool).await.unwrap();

        let entries = list_window(&pool, 3650).await.unwrap();
        assert_eq!(entries.len(), 2, "one bucket per day");
        assert_eq!(entries[0].day, "2026-07-20");
        assert_eq!(entries[0].input_words, 2);
        assert_eq!(entries[1].input_words, 1);
    }

    #[tokio::test]
    async fn running_twice_does_not_double_count() {
        let pool = pool().await;
        let now = today(&pool).await;
        session(&pool, 1, "claude_code", "opus", "").await;
        message(&pool, 1, "user", "user_message", "one two three", &now).await;

        run(&pool).await.unwrap();
        run(&pool).await.unwrap();

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(entries[0].input_words, 3);
        let version: i64 =
            sqlx::query_scalar("SELECT version FROM provider_usage_backfill WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(version, VERSION);
    }

    #[tokio::test]
    async fn a_retry_keeps_the_cutoff_claimed_by_the_first_attempt() {
        let pool = pool().await;
        let now = today(&pool).await;
        session(&pool, 1, "claude_code", "opus", "").await;
        message(&pool, 1, "user", "user_message", "one two three", &now).await;

        // Stand in for an attempt that claimed the cutoff and then died before
        // writing anything.
        super::claim(&pool).await.unwrap();

        // A turn taken before the retry: the live recorder owns these words, so
        // the import must leave them alone.
        message(&pool, 1, "user", "user_message", "four five", &now).await;

        run(&pool).await.unwrap();

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(
            entries[0].input_words, 3,
            "only messages that predate the claim are imported"
        );
    }

    #[tokio::test]
    async fn a_fresh_install_records_the_marker_without_importing_anything() {
        let pool = pool().await;

        run(&pool).await.unwrap();

        assert!(list_window(&pool, 30).await.unwrap().is_empty());
        let row = sqlx::query("SELECT version, messages_scanned FROM provider_usage_backfill")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.try_get::<i64, _>("version").unwrap(), VERSION);
        assert_eq!(row.try_get::<i64, _>("messages_scanned").unwrap(), 0);
    }
}
