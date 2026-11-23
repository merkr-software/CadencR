//! SQLite access for `remote_devices` and `remote_audit`. Writes use the
//! write pool, reads the read pool, mirroring the other domain repos.

use sqlx::SqlitePool;

use super::models::{RemoteAuditEntry, RemoteDevice};
use crate::error::AppError;

pub async fn insert_device(
    pool: &SqlitePool,
    token_hash: &str,
    label: &str,
) -> Result<i64, AppError> {
    let result = sqlx::query("INSERT INTO remote_devices (token_hash, label) VALUES (?, ?)")
        .bind(token_hash)
        .bind(label)
        .execute(pool)
        .await?;
    Ok(result.last_insert_rowid())
}

/// Active (non-revoked) device matching `token_hash`. The hash column is unique
/// and indexed, so this is a point lookup.
pub async fn find_active_device_hash(
    pool: &SqlitePool,
    token_hash: &str,
) -> Result<Option<(i64, String)>, AppError> {
    let row = sqlx::query_as(
        "SELECT id, token_hash FROM remote_devices WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Soft-delete a device. Returns true if a non-revoked row was revoked.
/// Only [`super::revocation::revoke_device`] calls it: a revocation must also
/// evict the device's cached token and close its live sockets.
pub(super) async fn mark_revoked(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE remote_devices SET revoked_at = datetime('now') \
         WHERE id = ? AND revoked_at IS NULL",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn touch_last_seen(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    sqlx::query("UPDATE remote_devices SET last_seen_at = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_active_devices(pool: &SqlitePool) -> Result<Vec<RemoteDevice>, AppError> {
    let rows: Vec<(i64, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT id, label, created_at, last_seen_at FROM remote_devices \
         WHERE revoked_at IS NULL ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, label, created_at, last_seen_at)| RemoteDevice {
            id,
            label,
            created_at,
            last_seen_at,
        })
        .collect())
}

pub async fn record_audit(
    pool: &SqlitePool,
    event: &str,
    device_id: Option<i64>,
    detail: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query("INSERT INTO remote_audit (event, device_id, detail) VALUES (?, ?, ?)")
        .bind(event)
        .bind(device_id)
        .bind(detail)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn recent_audit(
    pool: &SqlitePool,
    limit: i64,
) -> Result<Vec<RemoteAuditEntry>, AppError> {
    let rows: Vec<(String, Option<i64>, Option<String>, String)> = sqlx::query_as(
        "SELECT event, device_id, detail, created_at FROM remote_audit ORDER BY id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(event, device_id, detail, created_at)| RemoteAuditEntry {
            event,
            device_id,
            detail,
            created_at,
        })
        .collect())
}

/// A single-connection in-memory pool (so the schema is shared) holding only
/// `remote_devices`, for tests.
#[cfg(test)]
pub(crate) async fn remote_devices_test_pool() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory database");
    sqlx::query(
        "CREATE TABLE remote_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, \
         token_hash TEXT NOT NULL UNIQUE, label TEXT, \
         created_at TEXT NOT NULL DEFAULT (datetime('now')), \
         last_seen_at TEXT, revoked_at TEXT)",
    )
    .execute(&pool)
    .await
    .expect("create remote device table");
    pool
}
