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
