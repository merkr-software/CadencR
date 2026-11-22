use super::QueueOrigin;
use crate::error::AppError;

pub(crate) async fn has_source(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    message_uuid: &str,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_session_prompt_queue
         WHERE session_id = ? AND source_message_uuid = ?)",
    )
    .bind(session_id)
    .bind(message_uuid)
    .fetch_one(pool)
    .await?)
}

/// Keep the original request identity even after editing or cancelling the row.
pub(crate) async fn enqueue_deferred(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    content: &str,
    message_uuid: &str,
) -> Result<bool, AppError> {
    Ok(sqlx::query(
        "INSERT INTO agent_session_prompt_queue
            (session_id, content, source_message_uuid, message_uuid)
         SELECT ?, ?, ?, ? WHERE NOT EXISTS (
             SELECT 1 FROM agent_messages WHERE session_id = ? AND message_uuid = ?
         ) ON CONFLICT(session_id, source_message_uuid) DO NOTHING",
    )
    .bind(session_id)
    .bind(content)
    .bind(message_uuid)
    .bind(message_uuid)
    .bind(session_id)
    .bind(message_uuid)
    .execute(pool)
    .await?
    .rows_affected()
        != 0)
}

/// Outcome of queuing an agent message: its row, and whether this request
/// created it (false for a retransmission).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct EnqueuedMessage {
    pub id: i64,
    pub inserted: bool,
}

/// Queue a message another session's agent sent with `delivery=next_turn`.
/// `message_uuid` is the sender's request identity: a retransmission finds
/// the same row, retries it if its delivery failed, and is refused when it no
/// longer matches what is queued, telling the sender why.
pub(crate) async fn enqueue_agent_message(
    pool: &sqlx::SqlitePool,
    target_session_id: i64,
    source_session_id: i64,
    content: &str,
    message_uuid: uuid::Uuid,
) -> Result<EnqueuedMessage, AppError> {
    let message_uuid = message_uuid.to_string();
    let inserted: Option<i64> = sqlx::query_scalar(
        "INSERT INTO agent_session_prompt_queue
            (session_id, content, source_message_uuid, message_uuid, origin_kind,
             source_session_id, original_content)
         VALUES (?, ?, ?, ?, 'session', ?, ?)
         ON CONFLICT(session_id, source_message_uuid) DO NOTHING
         RETURNING id",
    )
    .bind(target_session_id)
    .bind(content)
    .bind(&message_uuid)
    .bind(&message_uuid)
    .bind(source_session_id)
    .bind(content)
    .fetch_optional(pool)
    .await?;
    if let Some(id) = inserted {
        return Ok(EnqueuedMessage { id, inserted: true });
    }
    let existing: ExistingRow = sqlx::query_as(
        "SELECT id, content, status, origin_kind, source_session_id, original_content
         FROM agent_session_prompt_queue
         WHERE session_id = ? AND source_message_uuid = ?",
    )
    .bind(target_session_id)
    .bind(&message_uuid)
    .fetch_one(pool)
    .await?;
    existing.accept_retransmission(target_session_id, source_session_id, content, &message_uuid)?;
    if existing.status == "error" {
        sqlx::query(
            "UPDATE agent_session_prompt_queue
             SET status = 'pending', error = NULL, updated_at = datetime('now')
             WHERE id = ? AND status = 'error'",
        )
        .bind(existing.id)
        .execute(pool)
        .await?;
    }
    Ok(EnqueuedMessage {
        id: existing.id,
        inserted: false,
    })
}

#[derive(sqlx::FromRow)]
struct ExistingRow {
    id: i64,
    content: String,
    status: String,
    origin_kind: QueueOrigin,
    source_session_id: Option<i64>,
    original_content: Option<String>,
}

impl ExistingRow {
    fn accept_retransmission(
        &self,
        target_session_id: i64,
        source_session_id: i64,
        content: &str,
        message_uuid: &str,
    ) -> Result<(), AppError> {
        if self.origin_kind != QueueOrigin::Session
            || self.source_session_id != Some(source_session_id)
            || self.original_content.as_deref() != Some(content)
        {
            return Err(AppError::Conflict(format!(
                "queued message UUID {message_uuid} already has different content or provenance in session {target_session_id}"
            )));
        }
        if self.status == "cancelled" {
            return Err(AppError::Conflict(format!(
                "queued message UUID {message_uuid} was cancelled; submit a new message identity to enqueue it again"
            )));
        }
        if self.content != content {
            return Err(AppError::Conflict(format!(
                "queued message UUID {message_uuid} was edited by the user of session {target_session_id} before delivery; the queued version is now:\n{}",
                self.content
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{claim, mark_error, update_content, Pick};
    use super::*;

    #[tokio::test]
    async fn deferred_identity_survives_retries_and_edits() {
        let (pool, session) = super::super::tests::pool_with_session().await;
        let original = uuid::Uuid::new_v4().to_string();
        assert!(enqueue_deferred(&pool, session, "first", &original)
            .await
            .unwrap());
        assert!(!enqueue_deferred(&pool, session, "first", &original)
            .await
            .unwrap());
        let first = claim(&pool, session, Pick::Next).await.unwrap().unwrap();
        assert_eq!(first.message_uuid.as_deref(), Some(original.as_str()));
        mark_error(&pool, first.id, "refused").await.unwrap();
        let retry = update_content(&pool, session, first.id, "first")
            .await
            .unwrap();
        assert_eq!(retry.message_uuid, first.message_uuid);
        let edited = update_content(&pool, session, first.id, "edited")
            .await
            .unwrap();
        assert_ne!(edited.message_uuid, first.message_uuid);
        assert!(has_source(&pool, session, &original).await.unwrap());
        assert!(!enqueue_deferred(&pool, session, "first", &original)
            .await
            .unwrap());
        assert!(
            serde_json::to_value(super::super::QueuedPrompt::from(edited))
                .unwrap()
                .get("message_uuid")
                .is_none()
        );
    }

    /// Session 2's agent queues for session 1 (see `pool_with_session`).
    async fn agent_message(
        pool: &sqlx::SqlitePool,
        content: &str,
        uuid: uuid::Uuid,
    ) -> EnqueuedMessage {
        enqueue_agent_message(pool, 1, 2, content, uuid)
            .await
            .unwrap()
    }

    fn conflict(result: Result<EnqueuedMessage, AppError>) -> String {
        match result {
            Err(AppError::Conflict(message)) => message,
            other => panic!("expected a conflict, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_retransmitted_agent_message_finds_its_row_and_retries_a_failure() {
        let (pool, session) = super::super::tests::pool_with_session().await;
        let uuid = uuid::Uuid::new_v4();
        let first = agent_message(&pool, "review it", uuid).await;
        let retry = agent_message(&pool, "review it", uuid).await;
        assert!(first.inserted);
        assert_eq!(
            retry,
            EnqueuedMessage {
                id: first.id,
                inserted: false
            }
        );

        let claimed = claim(&pool, session, Pick::Next).await.unwrap().unwrap();
        mark_error(&pool, claimed.id, "agent offline")
            .await
            .unwrap();
        agent_message(&pool, "review it", uuid).await;
        let status: String =
            sqlx::query_scalar("SELECT status FROM agent_session_prompt_queue WHERE id = ?")
                .bind(first.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "pending");
    }

    #[tokio::test]
    async fn a_retransmission_after_the_user_edited_it_returns_the_edited_version() {
        let (pool, session) = super::super::tests::pool_with_session().await;
        let uuid = uuid::Uuid::new_v4();
        let queued = agent_message(&pool, "review it", uuid).await;
        update_content(&pool, session, queued.id, "review it, then merge")
            .await
            .unwrap();

        let refusal = conflict(enqueue_agent_message(&pool, 1, 2, "review it", uuid).await);

        assert!(refusal.contains("edited by the user"), "{refusal}");
        assert!(refusal.ends_with("review it, then merge"), "{refusal}");
    }

    #[tokio::test]
    async fn a_reused_identity_or_a_cancelled_message_is_refused() {
        let (pool, session) = super::super::tests::pool_with_session().await;
        let uuid = uuid::Uuid::new_v4();
        let queued = agent_message(&pool, "review it", uuid).await;

        let other_content = conflict(enqueue_agent_message(&pool, 1, 2, "other", uuid).await);
        let other_sender = conflict(enqueue_agent_message(&pool, 1, 1, "review it", uuid).await);
        assert!(other_content.contains("different content or provenance"));
        assert!(other_sender.contains("different content or provenance"));

        super::super::cancel(&pool, session, queued.id)
            .await
            .unwrap();
        let cancelled = conflict(enqueue_agent_message(&pool, 1, 2, "review it", uuid).await);
        assert!(cancelled.contains("was cancelled"), "{cancelled}");
    }
}
