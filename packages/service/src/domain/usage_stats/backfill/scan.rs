//! Walking the history and folding it into per-day buckets.

use std::collections::HashMap;
use std::sync::LazyLock;

use sqlx::{Row, SqlitePool};

use super::ownership::delivered_before_claim;
use super::{Bucket, BucketKey, Claim};
use crate::domain::usage_stats::word_count::count_words;

/// Rows per scan query. Message text can be tens of kilobytes each, so this
/// trades a few hundred queries against holding the whole history in memory.
const BATCH_SIZE: i64 = 500;

/// Every message that carries countable prose, joined to what it should be
/// attributed to. `date()` normalizes the two timestamp shapes the column has
/// picked up over time, and returns NULL for anything unparseable.
///
/// `message_model` is the model that produced the message — finer-grained than
/// the session's current model, so a session whose model was switched mid-way
/// splits across both. User prompts carry no model of their own, so they borrow
/// the one from the reply they drew: without that, every prompt would pile into
/// a separate bucket (usually the session's `default`) and the model chart would
/// show replies with no prompts beside them. That lookup is bounded by the same
/// cutoff as the outer scan: the import runs alongside live traffic, and a
/// session whose last message is still unanswered would otherwise attribute a
/// historical prompt to whatever model the *next*, live turn happens to use.
///
/// Prompts are counted only if they were delivered before the claim — see
/// [`super::ownership`] for why, and for the matching check on the live side.
static SCAN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "
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
                   AND reply.id <= ?
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
      AND (m.role <> 'user' OR ({delivered}))
    ORDER BY m.id ASC
    LIMIT ?
",
        delivered = delivered_before_claim("m.id", "?")
    )
});

/// Walk the history in id order, folding every message into its day bucket.
pub(super) async fn collect(
    write_pool: &SqlitePool,
    claim: &Claim,
) -> Result<(HashMap<BucketKey, Bucket>, i64), sqlx::Error> {
    let mut buckets: HashMap<BucketKey, Bucket> = HashMap::new();
    let mut messages_scanned = 0_i64;
    let mut last_id = 0_i64;

    loop {
        let rows = sqlx::query(SCAN_SQL.as_str())
            .bind(claim.cutoff_message_id)
            .bind(last_id)
            .bind(claim.cutoff_message_id)
            // Twice for the delivery predicate: it tests the claim instant for
            // NULL and then compares against it.
            .bind(&claim.claimed_at)
            .bind(&claim.claimed_at)
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

    // See `scan_sql` for how a message's model is resolved; the session's own
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

#[cfg(test)]
mod tests {
    use super::super::run;
    use super::super::test_fixtures::{message, pool, session, today, with_model};
    use crate::domain::usage_stats::repository::list_window;
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

    /// A prompt that never reached a provider is not usage. Counting it here
    /// would also make it uncorrectable: the live recorder scores delivery, so
    /// a later retry would add the same words again.
    #[tokio::test]
    async fn skips_a_prompt_that_was_never_delivered() {
        let pool = pool().await;
        let now = today(&pool).await;
        session(&pool, 1, "claude_code", "opus", "high").await;
        message(&pool, 1, "user", "user_message", "one two three", &now).await;
        message(&pool, 1, "user", "user_message", "four five", &now).await;
        dispatch(&pool, 1, "dispatched", Some("2000-01-01 00:00:00")).await;
        dispatch(&pool, 2, "error", None).await;

        run(&pool).await.unwrap();

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(
            entries[0].input_words, 3,
            "only the delivered prompt is imported"
        );
    }

    /// The scan runs alongside live traffic: a prompt delivered *after* the
    /// claim belongs to the live recorder, which has already counted it.
    #[tokio::test]
    async fn skips_a_prompt_delivered_after_the_claim() {
        let pool = pool().await;
        let now = today(&pool).await;
        session(&pool, 1, "claude_code", "opus", "high").await;
        message(&pool, 1, "user", "user_message", "one two three", &now).await;
        dispatch(&pool, 1, "dispatched", Some("2099-01-01 00:00:00")).await;

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

    async fn dispatch(
        pool: &sqlx::SqlitePool,
        message_id: i64,
        status: &str,
        dispatched_at: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO agent_message_dispatches (message_id, status, dispatched_at)
             VALUES (?, ?, ?)",
        )
        .bind(message_id)
        .bind(status)
        .bind(dispatched_at)
        .execute(pool)
        .await
        .unwrap();
    }
}
