//! `turn_checkpoints` persistence: a side table mapping a user message to the
//! pre-turn worktree snapshot's commit sha. Provider-neutral.

use sqlx::SqlitePool;

use crate::error::AppError;

/// Link `message_id` to its pre-turn snapshot commit. Idempotent: re-capturing
/// the same message (e.g. a respawn) overwrites the prior sha.
pub(super) async fn upsert_checkpoint(
    pool: &SqlitePool,
    message_id: i64,
    commit_sha: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO turn_checkpoints (message_id, commit_sha, kind)
         VALUES (?, ?, 'pre_turn')
         ON CONFLICT(message_id) DO UPDATE SET commit_sha = excluded.commit_sha",
    )
    .bind(message_id)
    .bind(commit_sha)
    .execute(pool)
    .await?;
    Ok(())
}

/// The snapshot commit sha for a message, or `None` when no checkpoint exists
/// (capture failed, or the message predates the feature).
#[allow(dead_code)]
pub async fn get_commit_sha(
    pool: &SqlitePool,
    message_id: i64,
) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT commit_sha FROM turn_checkpoints WHERE message_id = ?")
            .bind(message_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(sha,)| sha))
}
