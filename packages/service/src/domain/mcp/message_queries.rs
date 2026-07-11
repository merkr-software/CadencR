pub(crate) async fn latest_assistant_text(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<Option<String>, sqlx::Error> {
    latest_assistant_text_after(pool, session_id, 0).await
}

pub(crate) async fn latest_assistant_text_after(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    after_message_id: i64,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT content FROM agent_messages
         WHERE session_id = ? AND id > ? AND role = 'assistant' AND message_type = 'text'
         ORDER BY id DESC LIMIT 1",
    )
    .bind(session_id)
    .bind(after_message_id)
    .fetch_optional(pool)
    .await
}
