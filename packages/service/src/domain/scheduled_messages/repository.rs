use sqlx::{AssertSqlSafe, SqlitePool};

use super::models::ScheduledMessage;
use crate::error::AppError;

/// Shared projection. `scheduled_at`/`created_at` are re-formatted to ISO-8601
/// UTC (trailing `Z`) so the frontend parses them unambiguously.
const SELECT: &str = "SELECT id, feature_id, text,
        strftime('%Y-%m-%dT%H:%M:%SZ', scheduled_at) AS scheduled_at,
        status,
        strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at
     FROM scheduled_messages";

/// The single pending scheduled message for a conversation, if any.
pub async fn get_pending(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<ScheduledMessage>, AppError> {
    let sql = format!("{SELECT} WHERE feature_id = ? AND status = 'pending' LIMIT 1");
    Ok(sqlx::query_as(AssertSqlSafe(sql))
        .bind(feature_id)
        .fetch_optional(pool)
        .await?)
}

/// Replace any pending scheduled message for the conversation with a new one.
/// `scheduled_at_iso` may be any ISO-8601 string; SQLite's `datetime()`
/// normalises it to UTC `YYYY-MM-DD HH:MM:SS` for storage and comparison.
pub async fn upsert(
    pool: &SqlitePool,
    feature_id: i64,
    text: &str,
    scheduled_at_iso: &str,
) -> Result<ScheduledMessage, AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM scheduled_messages WHERE feature_id = ? AND status = 'pending'")
        .bind(feature_id)
        .execute(&mut *tx)
        .await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO scheduled_messages (feature_id, text, scheduled_at)
         VALUES (?, ?, datetime(?))
         RETURNING id",
    )
    .bind(feature_id)
    .bind(text)
    .bind(scheduled_at_iso)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let sql = format!("{SELECT} WHERE id = ?");
    sqlx::query_as(AssertSqlSafe(sql))
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// Cancel (delete) the pending scheduled message for a conversation. Returns
/// whether a row was removed.
pub async fn cancel(pool: &SqlitePool, feature_id: i64) -> Result<bool, AppError> {
    let rows =
        sqlx::query("DELETE FROM scheduled_messages WHERE feature_id = ? AND status = 'pending'")
            .bind(feature_id)
            .execute(pool)
            .await?
            .rows_affected();
    Ok(rows > 0)
}

/// Every pending message whose target time has arrived, oldest first.
pub async fn list_due(pool: &SqlitePool) -> Result<Vec<ScheduledMessage>, AppError> {
    let sql = format!(
        "{SELECT} WHERE status = 'pending' AND scheduled_at <= datetime('now') ORDER BY scheduled_at ASC"
    );
    Ok(sqlx::query_as(AssertSqlSafe(sql)).fetch_all(pool).await?)
}

pub async fn mark_sent(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE scheduled_messages SET status = 'sent', updated_at = datetime('now') WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_failed(pool: &SqlitePool, id: i64, error: &str) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE scheduled_messages
         SET status = 'failed', error = ?, updated_at = datetime('now')
         WHERE id = ?",
    )
    .bind(error)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Resolve the session a due message should dispatch into, creating a bare one
/// if the conversation has never spawned a session (i.e. the schedule was set on
/// a brand-new conversation). Mirrors the session lookup used on the live prompt
/// path (latest `agent_type = 'session'` row) but, unlike `find_or_create_session`
/// on the prompt path, it never forces an existing session to `paused` — dispatch
/// drives the status itself, and we must not disturb a session that is mid-turn.
pub async fn resolve_or_create_session(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<i64, AppError> {
    if let Some((id,)) = sqlx::query_as::<_, (i64,)>(
        "SELECT id FROM agent_sessions WHERE feature_id = ? AND agent_type = 'session' ORDER BY id DESC LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    Ok(sqlx::query_scalar::<_, i64>(
        "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (?, 'session', 'paused') RETURNING id",
    )
    .bind(feature_id)
    .fetch_one(pool)
    .await?)
}

/// Whether a feature exists. Scheduling endpoints take the feature id from the
/// path, so we reject unknown features with a clear 404 rather than a raw FK
/// violation.
pub async fn feature_exists(pool: &SqlitePool, feature_id: i64) -> Result<bool, AppError> {
    let found: Option<(i64,)> = sqlx::query_as("SELECT id FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_optional(pool)
        .await?;
    Ok(found.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    /// Returns a pool with a feature but no session row, to exercise the
    /// new-conversation path.
    async fn fixture() -> (SqlitePool, i64) {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        let project_id: i64 =
            sqlx::query_scalar("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
                .bind("p")
                .bind("/tmp/p")
                .fetch_one(&pool)
                .await
                .unwrap();
        let feature_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, ?) RETURNING id",
        )
        .bind(project_id)
        .bind("f")
        .fetch_one(&pool)
        .await
        .unwrap();
        (pool, feature_id)
    }

    #[tokio::test]
    async fn upsert_replaces_existing_pending() {
        let (pool, feature_id) = fixture().await;

        let first = upsert(&pool, feature_id, "one", "2026-06-21T15:00:00Z")
            .await
            .unwrap();
        let second = upsert(&pool, feature_id, "two", "2026-06-21T16:00:00Z")
            .await
            .unwrap();
        assert_ne!(first.id, second.id);

        let pending = get_pending(&pool, feature_id).await.unwrap().unwrap();
        assert_eq!(pending.id, second.id);
        assert_eq!(pending.text, "two");
        assert_eq!(pending.scheduled_at, "2026-06-21T16:00:00Z");
    }

    #[tokio::test]
    async fn list_due_excludes_future_and_non_pending() {
        let (pool, feature_id) = fixture().await;

        // Past -> due.
        let due = upsert(&pool, feature_id, "past", "2000-01-01T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(list_due(&pool).await.unwrap().len(), 1);

        mark_sent(&pool, due.id).await.unwrap();
        assert!(list_due(&pool).await.unwrap().is_empty());
        assert!(get_pending(&pool, feature_id).await.unwrap().is_none());

        // Future -> not due.
        upsert(&pool, feature_id, "future", "2099-01-01T00:00:00Z")
            .await
            .unwrap();
        assert!(list_due(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancel_removes_pending() {
        let (pool, feature_id) = fixture().await;
        upsert(&pool, feature_id, "x", "2099-01-01T00:00:00Z")
            .await
            .unwrap();
        assert!(cancel(&pool, feature_id).await.unwrap());
        assert!(!cancel(&pool, feature_id).await.unwrap());
        assert!(get_pending(&pool, feature_id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn resolve_or_create_session_creates_then_reuses() {
        let (pool, feature_id) = fixture().await;

        // New conversation: no session yet -> one is created.
        let first = resolve_or_create_session(&pool, feature_id).await.unwrap();
        // Subsequent resolves reuse the same row rather than creating more.
        let second = resolve_or_create_session(&pool, feature_id).await.unwrap();
        assert_eq!(first, second);

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE feature_id = ?")
                .bind(feature_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }
}
