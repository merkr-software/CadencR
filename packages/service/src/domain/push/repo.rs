//! SQLite access for `push_subscriptions`. Writes use the write pool, reads the
//! read pool, mirroring the other domain repos.

use sqlx::SqlitePool;

use crate::error::AppError;

/// One stored browser push subscription, joined to its owning device.
#[derive(Debug, Clone)]
pub struct PushSubscriptionRecord {
    pub device_id: i64,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

/// Insert or update a subscription, keyed by its unique `endpoint`. A browser
/// that re-subscribes (same endpoint, possibly new keys) updates in place and
/// is re-homed to the current device, so a re-paired phone doesn't leave a
/// dangling row pointing at the old device id.
pub async fn upsert_subscription(
    pool: &SqlitePool,
    device_id: i64,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(endpoint) DO UPDATE SET \
           device_id = excluded.device_id, \
           p256dh = excluded.p256dh, \
           auth = excluded.auth",
    )
    .bind(device_id)
    .bind(endpoint)
    .bind(p256dh)
    .bind(auth)
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove a subscription by endpoint, scoped to the owning device so one device
/// can't unsubscribe another's endpoint. Returns true if a row was removed.
pub async fn delete_subscription(
    pool: &SqlitePool,
    device_id: i64,
    endpoint: &str,
) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?")
        .bind(device_id)
        .bind(endpoint)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Remove a subscription by endpoint regardless of owner. Used by the dispatcher
/// to prune a subscription the push service reported as gone (404/410).
pub async fn delete_subscription_by_endpoint(
    pool: &SqlitePool,
    endpoint: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ?")
        .bind(endpoint)
        .execute(pool)
        .await?;
    Ok(())
}

/// All subscriptions belonging to active (non-revoked) devices. The join drops
/// rows for revoked devices so a revoked phone stops receiving push even before
/// its rows are cascade-deleted.
pub async fn list_active_subscriptions(
    pool: &SqlitePool,
) -> Result<Vec<PushSubscriptionRecord>, AppError> {
    let rows: Vec<(i64, String, String, String)> = sqlx::query_as(
        "SELECT s.device_id, s.endpoint, s.p256dh, s.auth \
         FROM push_subscriptions s \
         JOIN remote_devices d ON d.id = s.device_id \
         WHERE d.revoked_at IS NULL",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(device_id, endpoint, p256dh, auth)| PushSubscriptionRecord {
                device_id,
                endpoint,
                p256dh,
                auth,
            },
        )
        .collect())
}
