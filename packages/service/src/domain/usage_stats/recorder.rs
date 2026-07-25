use sqlx::SqlitePool;
use tracing::{error, warn};

use super::health;
use super::models::UsageAttribution;
use super::repository;
use super::word_count::count_words;

const SESSION_ATTRIBUTION_SQL: &str =
    "SELECT runtime_provider, model, thinking_effort FROM agent_sessions WHERE id = ?";

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

/// Count a prompt that has just been confirmed delivered to the provider.
///
/// Called from the dispatch claim's success transition, which is the single
/// point where a prompt is known to have actually reached the agent, and which
/// succeeds exactly once per message. Counting at persist time instead would
/// score prompts that then failed to spawn a runtime, and — because the retry
/// re-uses the already-inserted row — the correction could never be made.
pub async fn record_dispatched_prompt(write_pool: &SqlitePool, message_id: i64) {
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
/// on purpose — see [`record_session_words`].
fn spawn_upsert(
    write_pool: &SqlitePool,
    attribution: UsageAttribution,
    input_words: u64,
    output_words: u64,
) {
    let pool = write_pool.clone();
    tokio::spawn(async move {
        if let Err(error) =
            repository::add_words(&pool, &attribution, input_words, output_words).await
        {
            report_failure(&error, "failed to record provider usage stats");
        }
    });
}

/// Log *and* remember the failure, so the next `/api/usage-stats` read can tell
/// the user their numbers are incomplete rather than silently under-reporting.
fn report_failure(error: &sqlx::Error, context: &str) {
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
    use sqlx::Row;

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

/// Resolve what a session's words should be attributed to. `None` when the row
/// is gone or has no provider yet — there is nothing meaningful to chart.
pub(super) async fn resolve_session_attribution(
    pool: &SqlitePool,
    session_id: i64,
) -> Option<UsageAttribution> {
    match session_attribution(pool, session_id).await {
        Ok(Some(attribution)) => Some(attribution),
        Ok(None) => {
            warn!(
                session_id,
                "skipped usage stats: session row is gone or has no runtime provider"
            );
            None
        }
        Err(error) => {
            report_failure(&error, "failed to resolve usage stats attribution");
            None
        }
    }
}

async fn session_attribution(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<Option<UsageAttribution>, sqlx::Error> {
    use sqlx::Row;

    let Some(row) = sqlx::query(SESSION_ATTRIBUTION_SQL)
        .bind(session_id)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };

    let provider_id: Option<String> = row.try_get("runtime_provider")?;
    let Some(provider_id) = provider_id.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    Ok(Some(UsageAttribution {
        provider_id,
        model_id: row
            .try_get::<Option<String>, _>("model")?
            .unwrap_or_default(),
        thinking_effort: row
            .try_get::<Option<String>, _>("thinking_effort")?
            .unwrap_or_default(),
    }))
}

#[cfg(test)]
mod tests {
    use super::{record_dispatched_prompt, record_session_words, resolve_session_attribution};
    use crate::domain::usage_stats::repository::list_window;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn pool_with_session(
        provider: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> (SqlitePool, i64) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        sqlx::query("INSERT INTO projects (name, path) VALUES ('p', '/tmp/p')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (project_id, title) VALUES (1, 'test feature')")
            .execute(&pool)
            .await
            .unwrap();
        let session_id: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions
                 (feature_id, agent_type, runtime_provider, model, thinking_effort)
             VALUES (1, 'session', ?, ?, ?) RETURNING id",
        )
        .bind(provider)
        .bind(model)
        .bind(effort)
        .fetch_one(&pool)
        .await
        .unwrap();

        (pool, session_id)
    }

    /// `record_session_words` spawns the write, so tests must let it land.
    async fn settle() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }

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
    async fn missing_model_and_effort_become_empty_strings() {
        let (pool, session_id) = pool_with_session(Some("codex"), None, None).await;

        record_session_words(&pool, session_id, 0, 7).await;
        settle().await;

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].model_id, "");
        assert_eq!(entries[0].thinking_effort, "");
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
        settle().await;

        assert!(list_window(&pool, 30).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_deleted_session_records_nothing_but_does_not_error() {
        let (pool, session_id) = pool_with_session(Some("cursor"), Some("auto"), None).await;
        sqlx::query("DELETE FROM agent_sessions WHERE id = ?")
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();

        assert!(resolve_session_attribution(&pool, session_id)
            .await
            .is_none());
        record_session_words(&pool, session_id, 1, 1).await;
        settle().await;
        assert!(list_window(&pool, 30).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_dispatched_prompt_counts_its_own_words() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("opus"), Some("high")).await;
        let message_id: i64 = sqlx::query_scalar(
            "INSERT INTO agent_messages (session_id, role, content, message_type)
             VALUES (?, 'user', 'one two three four', 'user_message') RETURNING id",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        record_dispatched_prompt(&pool, message_id).await;
        settle().await;

        let entries = list_window(&pool, 30).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].input_words, 4);
        assert_eq!(entries[0].output_words, 0, "a prompt is input only");
    }

    #[tokio::test]
    async fn a_missing_dispatched_message_records_nothing() {
        let (pool, _session_id) = pool_with_session(Some("claude_code"), None, None).await;

        record_dispatched_prompt(&pool, 999_999).await;
        settle().await;

        assert!(list_window(&pool, 30).await.unwrap().is_empty());
    }
}
