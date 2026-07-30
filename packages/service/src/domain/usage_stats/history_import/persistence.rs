use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::domain::usage_stats::models::UsageAttribution;
use crate::domain::usage_stats::repository;

use super::types::ImportBatch;

type BucketKey = (String, String, String);
type TokenPair = (u64, u64);

pub async fn persist(
    pool: &SqlitePool,
    provider_id: &str,
    batch: ImportBatch,
) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let mut buckets: HashMap<BucketKey, TokenPair> = HashMap::new();
    let mut imported = 0u64;
    for event in batch.events {
        if repository::claim_event(&mut *tx, event.session_id, provider_id, &event.event_id).await?
        {
            imported = imported.saturating_add(1);
            let key = (event.day, event.model_id, event.thinking_effort);
            let tokens = buckets.entry(key).or_default();
            tokens.0 = tokens.0.saturating_add(event.input_tokens);
            tokens.1 = tokens.1.saturating_add(event.output_tokens);
        }
    }
    for ((day, model_id, thinking_effort), (input_tokens, output_tokens)) in buckets {
        repository::add_tokens_on_day(
            &mut *tx,
            Some(&day),
            &UsageAttribution {
                provider_id: provider_id.to_string(),
                model_id,
                thinking_effort,
            },
            input_tokens,
            output_tokens,
        )
        .await?;
    }
    for checkpoint in batch.checkpoints {
        sqlx::query(
            "INSERT INTO provider_usage_checkpoints
                 (session_id, provider_id, input_tokens, output_tokens)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id, provider_id) DO UPDATE SET
                 input_tokens = MAX(provider_usage_checkpoints.input_tokens, excluded.input_tokens),
                 output_tokens = MAX(provider_usage_checkpoints.output_tokens, excluded.output_tokens)",
        )
        .bind(checkpoint.session_id)
        .bind(provider_id)
        .bind(repository::as_i64(checkpoint.input_tokens))
        .bind(repository::as_i64(checkpoint.output_tokens))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE provider_usage_history_imports
         SET completed_at = datetime('now'), events_imported = ?, last_error = NULL
         WHERE provider_id = ? AND version = ?",
    )
    .bind(repository::as_i64(imported))
    .bind(provider_id)
    .bind(super::state::IMPORT_VERSION)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{RuntimeTokenUsage, RuntimeTokenUsageEntry};
    use crate::domain::usage_stats::history_import::types::HistoryEvent;
    use crate::domain::usage_stats::{record_runtime_usage, repository};

    async fn pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p');
             INSERT INTO features (id, project_id, title) VALUES (1, 1, 'f');
             INSERT INTO agent_sessions
                 (id, feature_id, agent_type, runtime_provider, runtime_session_id, model)
             VALUES (1, 1, 'session', 'opencode', 'ses-1', 'model');
             INSERT INTO provider_usage_history_imports
                 (provider_id, version, cutoff_at)
             VALUES ('opencode', 1, datetime('now'));",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn provider_message_identity_closes_history_live_overlap() {
        let pool = pool().await;
        let attribution = UsageAttribution {
            provider_id: "opencode".into(),
            model_id: "model".into(),
            thinking_effort: String::new(),
        };
        let mut live_usage = RuntimeTokenUsage::delta(
            Some("result-1".into()),
            vec![RuntimeTokenUsageEntry {
                model_id: None,
                input_tokens: 10,
                output_tokens: 2,
            }],
        );
        live_usage.correlate_event_id(
            Some(crate::domain::usage_stats::provider_message_event_id(
                "msg-1",
            )),
            None,
        );
        record_runtime_usage(&pool, 1, Some(attribution), live_usage).await;
        let day = repository::end_day(&pool).await.unwrap();
        let batch = ImportBatch {
            events: vec![HistoryEvent {
                session_id: 1,
                event_id: "provider-message:msg-1".into(),
                day,
                model_id: "model".into(),
                thinking_effort: String::new(),
                input_tokens: 10,
                output_tokens: 2,
            }],
            checkpoints: Vec::new(),
        };

        assert_eq!(persist(&pool, "opencode", batch).await.unwrap(), 0);
        let rows = repository::list_recent(&pool, 30).await.unwrap();
        assert_eq!((rows[0].input_tokens, rows[0].output_tokens), (10, 2));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM provider_usage_events")
                .fetch_one(&pool)
                .await
                .unwrap(),
            2,
            "live usage preserves its provider result id and claims the history correlation id"
        );
    }

    #[tokio::test]
    async fn imported_provider_message_identity_suppresses_later_live_replay() {
        let pool = pool().await;
        let day = repository::end_day(&pool).await.unwrap();
        let batch = ImportBatch {
            events: vec![HistoryEvent {
                session_id: 1,
                event_id: crate::domain::usage_stats::provider_message_event_id("msg-1"),
                day,
                model_id: "model".into(),
                thinking_effort: String::new(),
                input_tokens: 10,
                output_tokens: 2,
            }],
            checkpoints: Vec::new(),
        };
        assert_eq!(persist(&pool, "opencode", batch).await.unwrap(), 1);

        let mut replay = RuntimeTokenUsage::delta(
            Some("result-1".into()),
            vec![RuntimeTokenUsageEntry {
                model_id: None,
                input_tokens: 10,
                output_tokens: 2,
            }],
        );
        replay.correlate_event_id(
            Some(crate::domain::usage_stats::provider_message_event_id(
                "msg-1",
            )),
            None,
        );
        record_runtime_usage(
            &pool,
            1,
            Some(UsageAttribution {
                provider_id: "opencode".into(),
                model_id: "model".into(),
                thinking_effort: String::new(),
            }),
            replay,
        )
        .await;

        let rows = repository::list_recent(&pool, 30).await.unwrap();
        assert_eq!((rows[0].input_tokens, rows[0].output_tokens), (10, 2));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM provider_usage_events")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1,
            "the rolled-back provider result claim does not leave an orphan alias"
        );
    }
}
