//! SQL for `feature_branches`. Every read here skips unlinked rows except
//! [`is_unlinked`], which exists so automatic discovery can respect them.

use sqlx::SqlitePool;

use super::{pr_state_to_db, BranchOrigin, BranchRef};
use crate::domain::git::forge::PrState;
use crate::error::AppError;

/// Same shape as the column defaults, so ordering by `last_seen_at` stays a
/// plain string comparison.
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LinkedBranchRow {
    pub branch: String,
    pub origin: String,
    pub target_branch: Option<String>,
    pub last_seen_at: String,
    pub pr_number: Option<i64>,
    pub pr_state: Option<String>,
}

/// Linked branches of `feature_id`, most recently seen first.
pub async fn list_linked(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Vec<LinkedBranchRow>, AppError> {
    Ok(sqlx::query_as(
        "SELECT branch, origin, target_branch, last_seen_at, pr_number, pr_state \
         FROM feature_branches \
         WHERE feature_id = ? AND unlinked_at IS NULL \
         ORDER BY last_seen_at DESC, id DESC",
    )
    .bind(feature_id)
    .fetch_all(pool)
    .await?)
}

pub async fn is_linked(pool: &SqlitePool, key: BranchRef<'_>) -> Result<bool, AppError> {
    let found = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM feature_branches \
         WHERE feature_id = ? AND branch = ? AND unlinked_at IS NULL",
    )
    .bind(key.feature_id)
    .bind(key.branch)
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

pub async fn is_unlinked(pool: &SqlitePool, key: BranchRef<'_>) -> Result<bool, AppError> {
    let found = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM feature_branches \
         WHERE feature_id = ? AND branch = ? AND unlinked_at IS NOT NULL",
    )
    .bind(key.feature_id)
    .bind(key.branch)
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

pub async fn stored_target(
    pool: &SqlitePool,
    key: BranchRef<'_>,
) -> Result<Option<String>, AppError> {
    let target = sqlx::query_scalar::<_, Option<String>>(
        "SELECT target_branch FROM feature_branches \
         WHERE feature_id = ? AND branch = ? AND unlinked_at IS NULL",
    )
    .bind(key.feature_id)
    .bind(key.branch)
    .fetch_optional(pool)
    .await?;
    Ok(target.flatten().filter(|value| !value.trim().is_empty()))
}

/// Record that `branch` was seen at `seen_at` (or now). Never resurrects an
/// unlinked row. Returns whether a row was inserted or moved.
pub async fn record_seen(
    pool: &SqlitePool,
    key: BranchRef<'_>,
    origin: BranchOrigin,
    seen_at: Option<&str>,
) -> Result<bool, AppError> {
    let sql = format!(
        "INSERT INTO feature_branches (feature_id, branch, origin, first_seen_at, last_seen_at) \
         VALUES (?, ?, ?, COALESCE(?, {NOW}), COALESCE(?, {NOW})) \
         ON CONFLICT(feature_id, branch) DO UPDATE SET last_seen_at = excluded.last_seen_at \
         WHERE unlinked_at IS NULL AND last_seen_at < excluded.last_seen_at"
    );
    let result = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(key.feature_id)
        .bind(key.branch)
        .bind(origin.as_db())
        .bind(seen_at)
        .bind(seen_at)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Link `branch` by hand, undoing an earlier unlink.
pub async fn link_manual(pool: &SqlitePool, key: BranchRef<'_>) -> Result<(), AppError> {
    let sql = format!(
        "INSERT INTO feature_branches (feature_id, branch, origin) VALUES (?, ?, 'manual') \
         ON CONFLICT(feature_id, branch) DO UPDATE SET unlinked_at = NULL, last_seen_at = {NOW}"
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(key.feature_id)
        .bind(key.branch)
        .execute(pool)
        .await?;
    Ok(())
}

/// Hide `branch` from the conversation. Inserts the row when the branch was
/// only ever followed (never stored), so discovery keeps away from it too.
pub async fn unlink(pool: &SqlitePool, key: BranchRef<'_>) -> Result<(), AppError> {
    let sql = format!(
        "INSERT INTO feature_branches (feature_id, branch, origin, unlinked_at) \
         VALUES (?, ?, 'manual', {NOW}) \
         ON CONFLICT(feature_id, branch) DO UPDATE SET unlinked_at = {NOW}"
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(key.feature_id)
        .bind(key.branch)
        .execute(pool)
        .await?;
    Ok(())
}

/// Store the compare target of `branch`, linking it with `origin` if it had
/// no row yet.
pub async fn set_target(
    pool: &SqlitePool,
    key: BranchRef<'_>,
    origin: BranchOrigin,
    target: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO feature_branches (feature_id, branch, origin, target_branch) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(feature_id, branch) DO UPDATE SET \
           target_branch = excluded.target_branch, unlinked_at = NULL",
    )
    .bind(key.feature_id)
    .bind(key.branch)
    .bind(origin.as_db())
    .bind(target)
    .execute(pool)
    .await?;
    Ok(())
}

/// Remember the pull / merge request last seen for `branch`, so a merged or
/// closed one is still known after a restart.
pub async fn save_pr(
    pool: &SqlitePool,
    key: BranchRef<'_>,
    origin: BranchOrigin,
    number: i64,
    state: PrState,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO feature_branches (feature_id, branch, origin, pr_number, pr_state) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(feature_id, branch) DO UPDATE SET \
           pr_number = excluded.pr_number, pr_state = excluded.pr_state",
    )
    .bind(key.feature_id)
    .bind(key.branch)
    .bind(origin.as_db())
    .bind(number)
    .bind(pr_state_to_db(state))
    .execute(pool)
    .await?;
    Ok(())
}

/// Schema for in-memory test pools that never run the real migrations.
#[cfg(test)]
pub const TEST_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS feature_branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL,
    branch TEXT NOT NULL,
    origin TEXT NOT NULL,
    target_branch TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    unlinked_at TEXT,
    pr_number INTEGER,
    pr_state TEXT,
    UNIQUE (feature_id, branch)
)";
