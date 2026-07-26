use sqlx::{Row, SqlitePool};
use tracing::error;

use super::backfill;
use super::health;
use super::models::UsageAttribution;
use super::pending;
use super::repository;
use super::word_count::count_words;

mod attribution;
#[cfg(test)]
mod test_fixtures;

use attribution::resolve_session_attribution;
pub use attribution::snapshot_attribution;

const DISPATCHED_MESSAGE_SQL: &str = "SELECT session_id, content FROM agent_messages WHERE id = ?";

/// Fold words into the usage stats for a session.
///
/// Attribution is resolved *here*, on the caller's awaited path, and only the
/// write is handed to a background task. Resolving it inside the spawned task
/// instead would race: the user can switch model or effort, or destroy the
/// conversation, in the window before the task runs — which would either
/// misattribute the words or drop them entirely.
///
/// The write itself stays fire-and-forget because it sits on the agent's
/// streaming path and must never delay a turn. Once the bucket is written it no
/// longer references the session, so deleting the conversation afterwards
/// leaves the stats intact.
pub async fn record_session_words(
    write_pool: &SqlitePool,
    session_id: i64,
    input_words: u64,
    output_words: u64,
) {
    if input_words == 0 && output_words == 0 {
        return;
    }
    let Some(attribution) = resolve_session_attribution(write_pool, session_id).await else {
        return;
    };
    spawn_upsert(write_pool, attribution, input_words, output_words);
}

/// Fold words into the stats under an attribution taken earlier in the turn.
///
/// A turn's output accumulates over its whole lifetime, and the session row is
/// mutable while it runs — so the model that a flush would read is not
/// necessarily the model that produced the words. Callers holding a snapshot
/// from [`snapshot_attribution`] use this instead.
pub fn record_words_attributed(
    write_pool: &SqlitePool,
    attribution: UsageAttribution,
    input_words: u64,
    output_words: u64,
) {
    if input_words == 0 && output_words == 0 {
        return;
    }
    spawn_upsert(write_pool, attribution, input_words, output_words);
}

/// Count a prompt that has just been confirmed delivered to the provider.
///
/// Called from the dispatch claim's success transition, which is the single
/// point where a prompt is known to have actually reached the agent, and which
/// succeeds exactly once per message. Counting at persist time instead would
/// score prompts that then failed to spawn a runtime, and — because the retry
/// re-uses the already-inserted row — the correction could never be made.
///
/// Prompts the historical import counted are left to it — see
/// [`backfill::owns_prompt`] for how the two counters divide the history
/// between them.
pub async fn record_dispatched_prompt(write_pool: &SqlitePool, message_id: i64) {
    match backfill::owns_prompt(write_pool, message_id).await {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            report_failure(&error, "failed to read the usage stats import boundary");
            return;
        }
    }
    let dispatched = match dispatched_prompt(write_pool, message_id).await {
        Ok(Some(dispatched)) => dispatched,
        Ok(None) => return,
        Err(error) => {
            report_failure(&error, "failed to read dispatched prompt for usage stats");
            return;
        }
    };
    record_session_words(
        write_pool,
        dispatched.session_id,
        count_words(&dispatched.content),
        0,
    )
    .await;
}

/// Hand the accumulated words to a background task. Separate from attribution
/// on purpose — see [`record_session_words`]. Tracked so shutdown can wait for
/// it instead of dropping the last turn's words — see [`pending`].
fn spawn_upsert(
    write_pool: &SqlitePool,
    attribution: UsageAttribution,
    input_words: u64,
    output_words: u64,
) {
    let pool = write_pool.clone();
    pending::spawn_tracked(async move {
        if let Err(error) =
            repository::add_words(&pool, &attribution, input_words, output_words).await
        {
            report_failure(&error, "failed to record provider usage stats");
        }
    });
}

/// Log *and* remember the failure, so the next `/api/usage-stats` read can tell
/// the user their numbers are incomplete rather than silently under-reporting.
pub(super) fn report_failure(error: &sqlx::Error, context: &str) {
    error!(%error, "{context}");
    health::record_failure(&error.to_string());
}

struct DispatchedPrompt {
    session_id: i64,
    content: String,
}

async fn dispatched_prompt(
    pool: &SqlitePool,
    message_id: i64,
) -> Result<Option<DispatchedPrompt>, sqlx::Error> {
    let Some(row) = sqlx::query(DISPATCHED_MESSAGE_SQL)
        .bind(message_id)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(DispatchedPrompt {
        session_id: row.try_get("session_id")?,
        content: row.try_get("content")?,
    }))
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::{pool_with_session, settle};
    use super::{record_dispatched_prompt, record_session_words, record_words_attributed};
    use crate::domain::usage_stats::models::UsageAttribution;
    use crate::domain::usage_stats::repository::list_window;
    use sqlx::SqlitePool;

    #[tokio::test]
    async fn attributes_words_to_the_sessions_provider_model_and_effort() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("claude-opus-5"), Some("high")).await;

        record_session_words(&pool, session_id, 12, 340).await;
        settle().await;

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].provider_id, "claude_code");
        assert_eq!(entries[0].model_id, "claude-opus-5");
        assert_eq!(entries[0].thinking_effort, "high");
        assert_eq!(entries[0].input_words, 12);
        assert_eq!(entries[0].output_words, 340);
    }

    #[tokio::test]
    async fn attribution_is_taken_before_the_write_is_handed_off() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("opus"), Some("high")).await;

        record_session_words(&pool, session_id, 5, 5).await;
        // The user switches model in the window before the spawned write lands.
        sqlx::query(
            "UPDATE agent_sessions SET model = 'sonnet', thinking_effort = 'low' WHERE id = ?",
        )
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();
        settle().await;

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            (
                entries[0].model_id.as_str(),
                entries[0].thinking_effort.as_str()
            ),
            ("opus", "high"),
            "words must be attributed to the model that produced them"
        );
    }

    /// A turn's output is filed under the model that produced it even when the
    /// user switches model before the turn ends.
    #[tokio::test]
    async fn a_snapshot_survives_a_model_switch_mid_turn() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("opus"), Some("high")).await;
        let snapshot = super::snapshot_attribution(&pool, session_id)
            .await
            .unwrap();

        sqlx::query(
            "UPDATE agent_sessions SET model = 'haiku', thinking_effort = 'low' WHERE id = ?",
        )
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();
        record_words_attributed(&pool, snapshot, 0, 40);
        settle().await;

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            (
                entries[0].model_id.as_str(),
                entries[0].thinking_effort.as_str()
            ),
            ("opus", "high")
        );
        assert_eq!(entries[0].output_words, 40);
    }

    #[tokio::test]
    async fn deleting_the_session_after_recording_does_not_drop_the_words() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("opus"), Some("high")).await;

        record_session_words(&pool, session_id, 10, 20).await;
        sqlx::query("DELETE FROM agent_sessions WHERE id = ?")
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();
        settle().await;

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(
            entries.len(),
            1,
            "the bucket no longer needs the session row"
        );
        assert_eq!(entries[0].output_words, 20);
    }

    #[tokio::test]
    async fn a_session_without_a_provider_records_nothing() {
        let (pool, session_id) = pool_with_session(None, None, None).await;

        record_session_words(&pool, session_id, 5, 5).await;
        settle().await;

        assert!(list_window(&pool, 30).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn zero_words_never_touches_the_database() {
        let (pool, session_id) = pool_with_session(Some("claude_code"), None, None).await;

        record_session_words(&pool, session_id, 0, 0).await;
        record_words_attributed(
            &pool,
            UsageAttribution {
                provider_id: "claude_code".into(),
                model_id: String::new(),
                thinking_effort: String::new(),
            },
            0,
            0,
        );
        let _ = session_id;
        settle().await;

        assert!(list_window(&pool, 30).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_dispatched_prompt_counts_its_own_words() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("opus"), Some("high")).await;
        let message_id = prompt(&pool, session_id, "one two three four").await;

        record_dispatched_prompt(&pool, message_id).await;
        settle().await;

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].input_words, 4);
        assert_eq!(entries[0].output_words, 0, "a prompt is input only");
    }

    /// A prompt the import already counted: persisted before its boundary and
    /// delivered before it too.
    #[tokio::test]
    async fn a_prompt_the_import_counted_is_left_to_the_import() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("opus"), Some("high")).await;
        let message_id = prompt(&pool, session_id, "one two three four").await;
        dispatch(&pool, message_id, "dispatched", Some("2000-01-01 00:00:00")).await;
        claim(&pool, message_id, "2026-07-25 12:00:00").await;

        record_dispatched_prompt(&pool, message_id).await;
        settle().await;

        assert!(list_window(&pool, 30).await.unwrap().is_empty());
    }

    /// The counterpart the import deliberately skipped: persisted before the
    /// boundary, but only delivered now, so the live path owns it.
    #[tokio::test]
    async fn a_prompt_the_import_skipped_is_counted_on_delivery() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("opus"), Some("high")).await;
        let message_id = prompt(&pool, session_id, "one two").await;
        claim(&pool, message_id, "2026-07-25 12:00:00").await;
        // Delivered after the claim, as a retry of a failed send would be.
        dispatch(&pool, message_id, "dispatched", Some("2026-07-25 13:00:00")).await;

        record_dispatched_prompt(&pool, message_id).await;
        settle().await;

        assert_eq!(list_window(&pool, 30).await.unwrap()[0].input_words, 2);
    }

    #[tokio::test]
    async fn a_missing_dispatched_message_records_nothing() {
        let (pool, _session_id) = pool_with_session(Some("claude_code"), None, None).await;

        record_dispatched_prompt(&pool, 999_999).await;
        settle().await;

        assert!(list_window(&pool, 30).await.unwrap().is_empty());
    }

    async fn prompt(pool: &SqlitePool, session_id: i64, content: &str) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO agent_messages (session_id, role, content, message_type)
             VALUES (?, 'user', ?, 'user_message') RETURNING id",
        )
        .bind(session_id)
        .bind(content)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn dispatch(
        pool: &SqlitePool,
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

    async fn claim(pool: &SqlitePool, cutoff: i64, claimed_at: &str) {
        sqlx::query(
            "INSERT INTO provider_usage_backfill (id, version, cutoff_message_id, claimed_at)
             VALUES (1, 0, ?, ?)",
        )
        .bind(cutoff)
        .bind(claimed_at)
        .execute(pool)
        .await
        .unwrap();
    }
}
