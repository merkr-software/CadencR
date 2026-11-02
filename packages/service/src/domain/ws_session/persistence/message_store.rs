//! Shared transcript row insertion for lifecycle markers and stream content.

use super::INSERT_MESSAGE_SQL;
use sqlx::SqlitePool;

#[bon::builder]
pub(super) async fn insert_message(
    pool: &SqlitePool,
    session_id: i64,
    role: &str,
    content: &str,
    message_type: &str,
    tool_name: Option<&str>,
    tool_use_id: Option<&str>,
    parent_tool_use_id: Option<&str>,
    model: Option<&str>,
) -> Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error> {
    // Only user-message image blocks have a desktop consumer that resolves
    // `cadencr-blob://`. Tool arguments/results may contain image-looking
    // strings as source code or protocol data and must remain byte-for-byte.
    let offloaded = if message_type == "user_message" {
        crate::domain::blobs::offload_content_async(content).await
    } else {
        None
    };
    let content = offloaded.as_deref().unwrap_or(content);

    sqlx::query(INSERT_MESSAGE_SQL)
        .bind(session_id)
        .bind(role)
        .bind(content)
        .bind(message_type)
        .bind(tool_name)
        .bind(tool_use_id)
        .bind(parent_tool_use_id)
        .bind(model)
        .execute(pool)
        .await
}
