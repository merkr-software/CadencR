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

#[cfg(test)]
mod tests {
    use super::super::{claim, mark_error, update_content};
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
        let first = claim(&pool, session, None).await.unwrap().unwrap();
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
        assert!(serde_json::to_value(&edited)
            .unwrap()
            .get("message_uuid")
            .is_none());
    }
}
