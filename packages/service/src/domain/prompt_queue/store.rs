//! SQL for `agent_session_prompt_queue`.

use serde::Serialize;

use crate::error::AppError;

mod identity;
pub(crate) use identity::{enqueue_deferred, has_source};

/// Where a queued prompt stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::Type, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum QueuedPromptStatus {
    /// Waiting, editable.
    Pending,
    /// Claimed for sending.
    Delivering,
    /// The last delivery attempt failed (see `error`); editing retries it.
    Error,
}

/// A prompt waiting for the end of the agent's turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow, utoipa::ToSchema)]
pub struct QueuedPrompt {
    pub id: i64,
    pub session_id: i64,
    pub content: String,
    pub status: QueuedPromptStatus,
    pub error: Option<String>,
    pub created_at: String,
    #[serde(skip)]
    #[schema(ignore)]
    pub(crate) message_uuid: Option<String>,
}

/// Column list shared by every `RETURNING` / `SELECT` (a macro so the SQL
/// stays a compile-time literal, as sqlx requires).
macro_rules! columns {
    () => {
        "id, session_id, content, status, error, created_at, message_uuid"
    };
}

/// Pending, delivering and failed prompts, in delivery order.
pub(crate) async fn list_open(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<Vec<QueuedPrompt>, AppError> {
    Ok(sqlx::query_as(concat!(
        "SELECT ",
        columns!(),
        " FROM agent_session_prompt_queue
         WHERE session_id = ? AND status IN ('pending', 'delivering', 'error')
         ORDER BY id ASC"
    ))
    .bind(session_id)
    .fetch_all(pool)
    .await?)
}

pub(crate) async fn enqueue(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    content: &str,
) -> Result<QueuedPrompt, AppError> {
    Ok(sqlx::query_as(concat!(
        "INSERT INTO agent_session_prompt_queue (session_id, content, message_uuid)
         VALUES (?, ?, ?) RETURNING ",
        columns!(),
        ""
    ))
    .bind(session_id)
    .bind(content)
    .bind(uuid::Uuid::new_v4().to_string())
    .fetch_one(pool)
    .await?)
}

/// Edit a prompt that has not been claimed for delivery yet. A failed prompt
/// becomes pending again, so editing is also how the user retries it.
pub(crate) async fn update_content(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    id: i64,
    content: &str,
) -> Result<QueuedPrompt, AppError> {
    sqlx::query_as(concat!(
        "UPDATE agent_session_prompt_queue
         SET message_uuid = CASE WHEN content = ? THEN message_uuid ELSE ? END,
             content = ?, status = 'pending', error = NULL, updated_at = datetime('now')
         WHERE id = ? AND session_id = ? AND status IN ('pending', 'error')
         RETURNING ",
        columns!(),
        ""
    ))
    .bind(content)
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(content)
    .bind(id)
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(not_editable)
}

pub(crate) async fn cancel(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    id: i64,
) -> Result<(), AppError> {
    let result = sqlx::query(
        "UPDATE agent_session_prompt_queue
         SET status = 'cancelled', updated_at = datetime('now')
         WHERE id = ? AND session_id = ? AND status IN ('pending', 'error')",
    )
    .bind(id)
    .bind(session_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(not_editable());
    }
    Ok(())
}

/// Whether the session has a prompt waiting for delivery. A plain read, so the
/// end of every turn can check it without taking SQLite's write lock.
pub(crate) async fn has_pending(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_session_prompt_queue
         WHERE session_id = ? AND status = 'pending')",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?)
}

/// Claim one prompt for delivery: the given pending or failed one, or the oldest pending. At
/// most one prompt per session is in flight, so two finished turns (or a turn
/// end racing "send now") never deliver two prompts at once.
pub(crate) async fn claim(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    id: Option<i64>,
) -> Result<Option<QueuedPrompt>, AppError> {
    Ok(sqlx::query_as(concat!(
        "UPDATE agent_session_prompt_queue
         SET status = 'delivering', error = NULL, updated_at = datetime('now')
         WHERE id = (
             SELECT id FROM agent_session_prompt_queue
             WHERE session_id = ?
               AND (status = 'pending' OR (? IS NOT NULL AND status = 'error'))
               AND (? IS NULL OR id = ?)
               AND NOT EXISTS (
                   SELECT 1 FROM agent_session_prompt_queue
                   WHERE session_id = ? AND status = 'delivering'
               )
             ORDER BY id ASC LIMIT 1
         )
         RETURNING ",
        columns!(),
        ""
    ))
    .bind(session_id)
    .bind(id)
    .bind(id)
    .bind(id)
    .bind(session_id)
    .fetch_optional(pool)
    .await?)
}

pub(crate) async fn mark_delivered(pool: &sqlx::SqlitePool, id: i64) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE agent_session_prompt_queue
         SET status = 'delivered', delivered_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn mark_error(
    pool: &sqlx::SqlitePool,
    id: i64,
    error: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE agent_session_prompt_queue
         SET status = 'error', error = ?, updated_at = datetime('now')
         WHERE id = ?",
    )
    .bind(error)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// At startup: a prompt claimed by a process that died mid-delivery may or may
/// not have reached the agent. Surface it as failed (editing retries it)
/// rather than leaving it stuck in flight, unremovable.
pub async fn recover_interrupted_deliveries(pool: &sqlx::SqlitePool) -> Result<u64, AppError> {
    Ok(sqlx::query(
        "UPDATE agent_session_prompt_queue
         SET status = 'error', error = 'Cadencr restarted while sending this message.',
             updated_at = datetime('now')
         WHERE status = 'delivering'",
    )
    .execute(pool)
    .await?
    .rows_affected())
}

pub(crate) fn not_editable() -> AppError {
    AppError::Conflict("This queued message was already sent or removed.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    /// Migrated in-memory DB with two sessions (ids 1 and 2).
    pub(super) async fn pool_with_session() -> (sqlx::SqlitePool, i64) {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        for statement in [
            "INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/proj')",
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (1, 1, 'A', 'active', 'ws-session'), (2, 1, 'B', 'active', 'ws-session')",
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status)
             VALUES (1, 1, 'session', 'completed'), (2, 2, 'session', 'completed')",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        (pool, 1)
    }

    #[tokio::test]
    async fn enqueue_list_and_claim_in_order() {
        let (pool, session) = pool_with_session().await;
        let first = enqueue(&pool, session, "first").await.unwrap();
        enqueue(&pool, session, "second").await.unwrap();
        let open = list_open(&pool, session).await.unwrap();
        assert_eq!(
            open.iter().map(|p| p.content.as_str()).collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert!(has_pending(&pool, session).await.unwrap());
        let claimed = claim(&pool, session, None).await.unwrap().unwrap();
        assert_eq!(claimed.id, first.id);
        assert_eq!(claimed.status, QueuedPromptStatus::Delivering);
        mark_delivered(&pool, claimed.id).await.unwrap();
        let open = list_open(&pool, session).await.unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].content, "second");
        claim(&pool, session, None).await.unwrap().unwrap();
        assert!(!has_pending(&pool, session).await.unwrap());
    }

    #[tokio::test]
    async fn edit_and_cancel_only_before_delivery() {
        let (pool, session) = pool_with_session().await;
        let prompt = enqueue(&pool, session, "draft").await.unwrap();
        let edited = update_content(&pool, session, prompt.id, "final")
            .await
            .unwrap();
        assert_eq!(edited.content, "final");
        claim(&pool, session, Some(prompt.id))
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            update_content(&pool, session, prompt.id, "late").await,
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            cancel(&pool, session, prompt.id).await,
            Err(AppError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn failed_prompt_is_retried_by_editing() {
        let (pool, session) = pool_with_session().await;
        let prompt = enqueue(&pool, session, "x").await.unwrap();
        claim(&pool, session, None).await.unwrap().unwrap();
        mark_error(&pool, prompt.id, "agent offline").await.unwrap();
        let open = list_open(&pool, session).await.unwrap();
        assert_eq!(open[0].status, QueuedPromptStatus::Error);
        assert_eq!(open[0].error.as_deref(), Some("agent offline"));
        let retried = update_content(&pool, session, prompt.id, "x")
            .await
            .unwrap();
        assert_eq!(retried.status, QueuedPromptStatus::Pending);
        assert!(retried.error.is_none());
    }

    #[tokio::test]
    async fn failed_prompt_can_be_retried_manually_without_editing() {
        let (pool, session) = pool_with_session().await;
        let prompt = enqueue(&pool, session, "retry me").await.unwrap();
        claim(&pool, session, Some(prompt.id))
            .await
            .unwrap()
            .unwrap();
        mark_error(&pool, prompt.id, "agent offline").await.unwrap();

        assert!(claim(&pool, session, None).await.unwrap().is_none());
        let retried = claim(&pool, session, Some(prompt.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retried.id, prompt.id);
        assert_eq!(retried.content, "retry me");
        assert_eq!(retried.status, QueuedPromptStatus::Delivering);
        assert!(retried.error.is_none());
        mark_delivered(&pool, prompt.id).await.unwrap();
        assert!(claim(&pool, session, Some(prompt.id))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn automatic_delivery_skips_errors_and_blocks_concurrent_manual_retries() {
        let (pool, session) = pool_with_session().await;
        let failed = enqueue(&pool, session, "failed").await.unwrap();
        claim(&pool, session, Some(failed.id))
            .await
            .unwrap()
            .unwrap();
        mark_error(&pool, failed.id, "agent offline").await.unwrap();
        let pending = enqueue(&pool, session, "pending").await.unwrap();

        let automatic = claim(&pool, session, None).await.unwrap().unwrap();
        assert_eq!(automatic.id, pending.id);
        assert!(claim(&pool, session, Some(failed.id))
            .await
            .unwrap()
            .is_none());
        mark_delivered(&pool, pending.id).await.unwrap();
        assert!(claim(&pool, session, None).await.unwrap().is_none());
        let manual = claim(&pool, session, Some(failed.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(manual.id, failed.id);
    }

    #[tokio::test]
    async fn prompts_are_scoped_to_their_session() {
        let (pool, session) = pool_with_session().await;
        let other = 2;
        let prompt = enqueue(&pool, session, "mine").await.unwrap();
        assert!(claim(&pool, other, Some(prompt.id))
            .await
            .unwrap()
            .is_none());
        assert!(cancel(&pool, other, prompt.id).await.is_err());
        assert!(list_open(&pool, other).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn one_delivery_in_flight_per_session() {
        let (pool, session) = pool_with_session().await;
        enqueue(&pool, session, "first").await.unwrap();
        let second = enqueue(&pool, session, "second").await.unwrap();
        claim(&pool, session, None).await.unwrap().unwrap();
        assert!(claim(&pool, session, None).await.unwrap().is_none());
        assert!(claim(&pool, session, Some(second.id))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn restart_fails_interrupted_deliveries() {
        let (pool, session) = pool_with_session().await;
        let prompt = enqueue(&pool, session, "x").await.unwrap();
        enqueue(&pool, session, "y").await.unwrap();
        claim(&pool, session, None).await.unwrap().unwrap();
        assert_eq!(recover_interrupted_deliveries(&pool).await.unwrap(), 1);
        let open = list_open(&pool, session).await.unwrap();
        assert_eq!(open[0].id, prompt.id);
        assert_eq!(open[0].status, QueuedPromptStatus::Error);
        assert_eq!(open[1].status, QueuedPromptStatus::Pending);
        // The next prompt is deliverable again.
        assert!(claim(&pool, session, None).await.unwrap().is_some());
    }
}
