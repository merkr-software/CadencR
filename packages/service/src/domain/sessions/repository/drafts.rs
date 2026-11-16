//! Small per-session draft / message-content queries.

use sqlx::SqlitePool;

use crate::error::AppError;

pub async fn get_draft(pool: &SqlitePool, session_id: i64) -> Result<Option<String>, AppError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT draft_prompt FROM agent_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(v,)| v))
}

/// `(session_id, content, message_type, tool_use_id, tool_name)` of a message.
type MessageContentRow = (i64, String, String, Option<String>, Option<String>);

/// Fetch the full, untruncated `content` for a single `agent_messages` row.
/// Used by explicit expansion of any oversized payload preview in agent state.
pub async fn get_message_content(
    pool: &SqlitePool,
    message_id: i64,
) -> Result<Option<String>, AppError> {
    let row: Option<MessageContentRow> = sqlx::query_as(
        "SELECT session_id, content, message_type, tool_use_id, tool_name FROM agent_messages WHERE id = ?",
    )
        .bind(message_id)
        .fetch_optional(pool)
        .await?;
    let Some((session_id, mut content, message_type, tool_use_id, tool_name)) = row else {
        return Ok(None);
    };
    if message_type == "tool_call"
        && super::truncation::is_file_change_tool_name(tool_name.as_deref())
    {
        if let Some(tool_use_id) = tool_use_id {
            let result: Option<(String,)> = sqlx::query_as(
                "SELECT content FROM agent_messages
                 WHERE session_id = ? AND tool_use_id = ?
                   AND message_type IN ('tool_result', 'tool_error')
                 ORDER BY id DESC LIMIT 1",
            )
            .bind(session_id)
            .bind(tool_use_id)
            .fetch_optional(pool)
            .await?;
            if let Some((result_content,)) = result {
                super::tool_blocks::merge_tool_result_patch(&mut content, &result_content);
            }
        }
    }
    Ok(Some(content))
}

pub async fn save_draft(
    pool: &SqlitePool,
    session_id: i64,
    draft: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query("UPDATE agent_sessions SET draft_prompt = ? WHERE id = ?")
        .bind(draft)
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    #[tokio::test]
    async fn test_get_draft() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let session_id = insert_session(&pool, fid.0, "paused").await;

        save_draft(&pool, session_id, Some("my draft"))
            .await
            .unwrap();
        let draft = get_draft(&pool, session_id).await.unwrap();
        assert_eq!(draft.as_deref(), Some("my draft"));
    }

    #[tokio::test]
    async fn test_get_draft_empty() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let session_id = insert_session(&pool, fid.0, "paused").await;

        let draft = get_draft(&pool, session_id).await.unwrap();
        assert!(draft.is_none());
    }

    #[tokio::test]
    async fn test_save_draft_upsert() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let session_id = insert_session(&pool, fid.0, "paused").await;

        save_draft(&pool, session_id, Some("first draft"))
            .await
            .unwrap();
        save_draft(&pool, session_id, Some("updated draft"))
            .await
            .unwrap();

        let draft = get_draft(&pool, session_id).await.unwrap();
        assert_eq!(draft.as_deref(), Some("updated draft"));
    }

    #[tokio::test]
    async fn test_get_message_content_returns_row() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let sid = insert_session(&pool, fid.0, "completed").await;
        let mid = insert_message(
            &pool,
            sid,
            "tool_result",
            "the full bash output",
            None,
            Some("tu-1"),
            None,
        )
        .await;

        let content = get_message_content(&pool, mid).await.unwrap();
        assert_eq!(content.as_deref(), Some("the full bash output"));
    }

    #[tokio::test]
    async fn test_get_message_content_missing_returns_none() {
        let pool = setup_test_db().await;
        let res = get_message_content(&pool, 999_999).await.unwrap();
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn full_file_change_content_includes_patch_recovered_from_result() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 1, "completed").await;
        let call_id = insert_message(
            &pool,
            session_id,
            "tool_call",
            r#"{"file_path":"src/main.rs"}"#,
            Some("Write"),
            Some("write-1"),
            None,
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "tool_result",
            r#"{"patch_text":"*** Begin Patch\\n+new\\n*** End Patch"}"#,
            None,
            Some("write-1"),
            None,
        )
        .await;

        let full = get_message_content(&pool, call_id).await.unwrap().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&full).unwrap();
        assert_eq!(parsed["file_path"], "src/main.rs");
        assert!(parsed["patch_text"].as_str().unwrap().contains("+new"));
    }
}
