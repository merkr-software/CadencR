//! Every prompt the user typed in one session, as a lean index for the agent
//! tab's message navigator. The transcript itself is paginated, so a rail
//! built from loaded blocks would grow as history loads; this answers "which
//! prompts exist" in one index-backed statement without shipping their bodies.
//!
//! Messages another session or the system wrote on the user's behalf are left
//! out: the navigator maps what *the user* asked.

use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use utoipa::ToSchema;

use crate::error::AppError;

use super::repository::preview_snippet;

const PREVIEW_MAX_CHARS: usize = 280;

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionPrompt {
    /// `agent_messages.id` — matches the transcript block's `messageDbId`.
    pub id: i64,
    pub created_at: Option<String>,
    /// Start of the prompt's text, whitespace-collapsed.
    pub preview: String,
    pub image_count: i64,
    pub attachment_count: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionPromptsResponse {
    /// Oldest first.
    pub prompts: Vec<SessionPrompt>,
}

#[derive(Debug, FromRow)]
struct PromptRow {
    id: i64,
    created_at: Option<String>,
    text: Option<String>,
    image_count: i64,
    attachment_count: i64,
}

/// A structured prompt is a JSON array of content parts (text, image,
/// attachment) — mirrored from `parseUserMessageContent` on the frontend.
/// Parts are read in SQL so image payloads never leave the database, and the
/// text is clipped before transfer since only a preview is shown.
const PROMPTS_SQL: &str = r#"
WITH prompts AS (
    SELECT m.id, m.content, m.created_at,
        substr(m.content, 1, 1) = '[' AND json_valid(m.content) AS structured
    FROM agent_messages m
    LEFT JOIN agent_message_origins o ON o.message_id = m.id
    WHERE m.session_id = ?1
      AND m.message_type = 'user_message'
      AND m.parent_tool_use_id IS NULL
      AND (o.origin_kind IS NULL OR o.origin_kind IN ('human', 'imported'))
)
SELECT id, created_at,
    substr(CASE WHEN structured THEN
        (SELECT group_concat(json_extract(j.value, '$.text'), char(10))
         FROM json_each(content) j WHERE json_extract(j.value, '$.type') = 'text')
    ELSE content END, 1, 2000) AS text,
    CASE WHEN structured THEN
        (SELECT count(*) FROM json_each(content) j
         WHERE json_extract(j.value, '$.type') = 'image')
    ELSE 0 END AS image_count,
    CASE WHEN structured THEN
        (SELECT count(*) FROM json_each(content) j
         WHERE json_extract(j.value, '$.type') = 'attachment')
    ELSE 0 END AS attachment_count
FROM prompts
ORDER BY id"#;

pub async fn list_session_prompts(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<SessionPromptsResponse, AppError> {
    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM agent_sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("Session {session_id}")));
    }
    let rows: Vec<PromptRow> = sqlx::query_as(PROMPTS_SQL)
        .bind(session_id)
        .fetch_all(pool)
        .await?;
    let prompts = rows
        .into_iter()
        .map(|row| SessionPrompt {
            id: row.id,
            created_at: row.created_at,
            preview: preview_snippet(row.text.as_deref().unwrap_or(""), PREVIEW_MAX_CHARS),
            image_count: row.image_count,
            attachment_count: row.attachment_count,
        })
        .collect();
    Ok(SessionPromptsResponse { prompts })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        for ddl in [
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY)",
            "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, \
             role TEXT NOT NULL, content TEXT NOT NULL, message_type TEXT NOT NULL, \
             parent_tool_use_id TEXT, message_uuid TEXT, created_at TEXT)",
            "CREATE TABLE agent_message_origins (message_id INTEGER PRIMARY KEY, \
             origin_kind TEXT NOT NULL)",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }
        pool
    }

    #[tokio::test]
    async fn lists_only_the_users_own_top_level_prompts() {
        let pool = setup_pool().await;
        let structured = serde_json::json!([
            { "type": "text", "text": "Look   at\nthis" },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "BBBB" } },
            { "type": "attachment", "fileName": "notes.md" },
        ])
        .to_string();
        sqlx::query("INSERT INTO agent_sessions VALUES (1), (2)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_messages VALUES \
             (1, 1, 'user', 'Fix the bug', 'user_message', NULL, 'u-1', '2026-10-11 10:00:00'), \
             (2, 1, 'assistant', 'Done', 'text', NULL, NULL, '2026-10-11 10:00:01'), \
             (3, 1, 'user', ?, 'user_message', NULL, 'u-3', '2026-10-11 10:00:02'), \
             (4, 1, 'user', 'subagent brief', 'user_message', 'toolu_1', NULL, NULL), \
             (5, 1, 'user', '<cadencr-reply>', 'user_message', NULL, NULL, NULL), \
             (6, 1, 'user', 'Imported prompt', 'user_message', NULL, NULL, NULL), \
             (7, 2, 'user', 'Other session', 'user_message', NULL, NULL, NULL), \
             (8, 1, 'user', '[not json', 'user_message', NULL, NULL, NULL)",
        )
        .bind(&structured)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_message_origins VALUES (5, 'session_generated'), (6, 'imported')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let prompts = list_session_prompts(&pool, 1).await.unwrap().prompts;
        let ids: Vec<i64> = prompts.iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![1, 3, 6, 8]);
        assert_eq!(prompts[0].preview, "Fix the bug");
        assert_eq!(prompts[1].preview, "Look at this");
        assert_eq!(prompts[1].image_count, 2);
        assert_eq!(prompts[1].attachment_count, 1);
        assert_eq!(prompts[3].preview, "[not json");
    }

    #[tokio::test]
    async fn unknown_session_is_not_found() {
        let pool = setup_pool().await;
        assert!(matches!(
            list_session_prompts(&pool, 404).await,
            Err(AppError::NotFound(_))
        ));
    }
}
