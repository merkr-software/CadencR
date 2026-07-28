use chrono::{NaiveDate, Utc};
use sqlx::{Row, SqlitePool};

use super::types::ImportWindow;

pub(super) const IMPORT_VERSION: i64 = 1;

pub async fn begin(
    pool: &SqlitePool,
    provider_id: &str,
) -> Result<Option<ImportWindow>, sqlx::Error> {
    sqlx::query(
        "INSERT OR IGNORE INTO provider_usage_history_imports
             (provider_id, version, cutoff_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(provider_id)
    .bind(IMPORT_VERSION)
    .execute(pool)
    .await?;
    let row = sqlx::query(
        "SELECT cutoff_at, date(cutoff_at, '-29 days') AS start_day, completed_at
         FROM provider_usage_history_imports
         WHERE provider_id = ? AND version = ?",
    )
    .bind(provider_id)
    .bind(IMPORT_VERSION)
    .fetch_one(pool)
    .await?;
    if row.try_get::<Option<String>, _>("completed_at")?.is_some() {
        return Ok(None);
    }
    sqlx::query(
        "UPDATE provider_usage_history_imports
         SET started_at = datetime('now'), last_error = NULL
         WHERE provider_id = ? AND version = ?",
    )
    .bind(provider_id)
    .bind(IMPORT_VERSION)
    .execute(pool)
    .await?;
    let cutoff_at = row
        .try_get::<String, _>("cutoff_at")?
        .parse::<chrono::DateTime<Utc>>()
        .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
    let start_day = row
        .try_get::<String, _>("start_day")?
        .parse::<NaiveDate>()
        .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
    Ok(Some(ImportWindow {
        cutoff_at,
        start_day,
    }))
}

pub async fn mark_failed(
    pool: &SqlitePool,
    provider_id: &str,
    error: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE provider_usage_history_imports
         SET last_error = ?
         WHERE provider_id = ? AND version = ?",
    )
    .bind(error)
    .bind(provider_id)
    .bind(IMPORT_VERSION)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
pub async fn completed(pool: &SqlitePool, provider_id: &str) -> bool {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM provider_usage_history_imports
         WHERE provider_id = ? AND version = ? AND completed_at IS NOT NULL",
    )
    .bind(provider_id)
    .bind(IMPORT_VERSION)
    .fetch_one(pool)
    .await
    .unwrap_or(0)
        > 0
}
