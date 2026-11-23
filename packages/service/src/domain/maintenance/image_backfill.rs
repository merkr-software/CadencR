//! Retroactively moves inline base64 images out of existing messages and into
//! the blob store.
//!
//! The historical counterpart to the `offload_content` call in `insert_message`,
//! which keeps new rows clean. This is deliberately limited to `user_message`:
//! those image blocks have a desktop consumer for blob references, while tool
//! data must remain byte-for-byte even when it contains image-looking strings.
//!
//! Unlike the tool-output backfill this can't be done in SQL: base64 has to be
//! decoded and hashed to find the blob's identity. Candidate ids are paged in
//! small batches, but payloads are fetched one at a time so peak memory is
//! bounded to one oversized message.

use sqlx::SqlitePool;

use super::state;
use crate::domain::blobs;

/// Rows pulled per batch. Small on purpose: every candidate is image-bearing and
/// therefore large.
const BATCH: i64 = 25;

/// Pause between batches, so a long backfill doesn't monopolize the writer.
const BATCH_PAUSE: std::time::Duration = std::time::Duration::from_millis(50);

/// Only rows that actually mention base64 are candidates; the `LIKE` runs on the
/// raw text and avoids parsing JSON for the ~99.6% of rows with no image.
const CANDIDATE_IDS_SQL: &str = r#"
SELECT id FROM agent_messages
WHERE id > ?
  AND message_type = 'user_message'
  AND (content LIKE '%data:image/%base64,%' OR content LIKE '%"base64"%')
ORDER BY id
LIMIT ?
"#;

/// Walk from the persisted cursor, off-loading every inline image found.
/// Returns the number of rows rewritten.
#[cfg(test)]
async fn run(pool: &SqlitePool) -> u64 {
    run_with_progress(pool, pool, |_| {}).await
}

pub(super) async fn run_with_progress(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    progress: impl Fn(i64),
) -> u64 {
    let mut cursor = state::get_i64(read_pool, state::IMAGE_BACKFILL_CURSOR, 0).await;
    let mut rewritten = 0u64;

    loop {
        let ids = match sqlx::query_scalar::<_, i64>(CANDIDATE_IDS_SQL)
            .bind(cursor)
            .bind(BATCH)
            .fetch_all(read_pool)
            .await
        {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!(cursor, "image backfill batch failed: {e}");
                return rewritten;
            }
        };
        if ids.is_empty() {
            // Candidate filtering can return no rows while newer image-free
            // messages exist. Park the cursor at the table high-water mark so
            // the next six-hour sweep starts after them instead of rescanning
            // the same historical range forever.
            match sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(id) FROM agent_messages")
                .fetch_one(read_pool)
                .await
            {
                Ok(Some(high_water)) if high_water > cursor => {
                    cursor = high_water;
                    state::set_i64(write_pool, state::IMAGE_BACKFILL_CURSOR, cursor).await;
                    progress(cursor);
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(cursor, "image backfill high-water query failed: {e}"),
            }
            break;
        }

        for id in ids {
            let content = match sqlx::query_scalar::<_, String>(
                "SELECT content FROM agent_messages WHERE id = ? AND message_type = 'user_message'",
            )
            .bind(id)
            .fetch_optional(read_pool)
            .await
            {
                Ok(Some(content)) => content,
                Ok(None) => {
                    cursor = id;
                    continue;
                }
                Err(e) => {
                    tracing::warn!(
                        message_id = id,
                        "failed to load image backfill candidate: {e}"
                    );
                    return rewritten;
                }
            };
            let offloaded = match blobs::try_offload_content_async(&content).await {
                Ok(Some(offloaded)) => offloaded,
                Ok(None) => {
                    cursor = id;
                    continue;
                }
                Err(e) => {
                    tracing::warn!(message_id = id, "failed to off-load image candidate: {e}");
                    return rewritten;
                }
            };
            match sqlx::query("UPDATE agent_messages SET content = ? WHERE id = ? AND content = ?")
                .bind(&offloaded)
                .bind(id)
                .bind(&content)
                .execute(write_pool)
                .await
            {
                Ok(result) if result.rows_affected() == 1 => {
                    rewritten += 1;
                    cursor = id;
                }
                Ok(_) => {
                    tracing::info!(
                        message_id = id,
                        "image backfill candidate changed before storage; retrying next sweep"
                    );
                    return rewritten;
                }
                Err(e) => {
                    tracing::warn!(message_id = id, "failed to store off-loaded images: {e}");
                    return rewritten;
                }
            }
        }

        state::set_i64(write_pool, state::IMAGE_BACKFILL_CURSOR, cursor).await;
        progress(cursor);
        tokio::time::sleep(BATCH_PAUSE).await;
    }

    if rewritten > 0 {
        tracing::info!(
            rows = rewritten,
            "moved inline images to the blob store; run VACUUM to reclaim the file space"
        );
    }
    rewritten
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, \
             updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
            "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL \
             DEFAULT 1, content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text')",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn insert(pool: &SqlitePool, id: i64, message_type: &str, content: &str) {
        sqlx::query("INSERT INTO agent_messages (id, message_type, content) VALUES (?, ?, ?)")
            .bind(id)
            .bind(message_type)
            .bind(content)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn content_of(pool: &SqlitePool, id: i64) -> String {
        sqlx::query_scalar::<_, String>("SELECT content FROM agent_messages WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    fn image_message() -> String {
        use base64::Engine as _;
        let mut bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend(std::iter::repeat_n(0xCD, 16_384));
        let payload = base64::engine::general_purpose::STANDARD.encode(bytes);
        serde_json::json!([{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": payload } }])
            .to_string()
    }

    #[tokio::test]
    async fn offloads_images_and_shrinks_the_row() {
        let pool = test_pool().await;
        let original = image_message();
        insert(&pool, 1, "user_message", &original).await;

        assert_eq!(run(&pool).await, 1);

        let stored = content_of(&pool, 1).await;
        assert!(stored.contains(blobs::extract::BLOB_REF_SCHEME));
        assert!(stored.len() < original.len() / 10);
    }

    #[tokio::test]
    async fn leaves_image_free_rows_untouched() {
        let pool = test_pool().await;
        let prose = serde_json::json!([{ "type": "text", "text": "no images" }]).to_string();
        insert(&pool, 1, "user_message", &prose).await;

        assert_eq!(run(&pool).await, 0);
        assert_eq!(content_of(&pool, 1).await, prose);
    }

    #[tokio::test]
    async fn walks_past_the_batch_size_and_is_idempotent() {
        let pool = test_pool().await;
        for id in 1..=(BATCH + 5) {
            insert(&pool, id, "user_message", &image_message()).await;
        }

        assert_eq!(run(&pool).await, (BATCH + 5) as u64);
        // Cursor parked at the end and every payload already a reference.
        assert_eq!(run(&pool).await, 0);
    }

    #[tokio::test]
    async fn never_rewrites_image_looking_tool_data() {
        let pool = test_pool().await;
        let original = image_message();
        insert(&pool, 1, "tool_result", &original).await;

        assert_eq!(run(&pool).await, 0);
        assert_eq!(content_of(&pool, 1).await, original);
    }

    #[tokio::test]
    async fn advances_past_image_free_rows_without_rescanning_them() {
        let pool = test_pool().await;
        let prose = serde_json::json!([{ "type": "text", "text": "nothing inline" }]).to_string();
        insert(&pool, 500, "user_message", &prose).await;

        assert_eq!(run(&pool).await, 0);
        assert_eq!(
            state::get_i64(&pool, state::IMAGE_BACKFILL_CURSOR, 0).await,
            500
        );
        assert_eq!(run(&pool).await, 0);
    }

    #[tokio::test]
    async fn retries_a_row_after_a_transient_update_failure() {
        let pool = test_pool().await;
        insert(&pool, 1, "user_message", &image_message()).await;
        sqlx::query(
            "CREATE TRIGGER reject_image_backfill BEFORE UPDATE ON agent_messages
             BEGIN SELECT RAISE(FAIL, 'transient write failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(run(&pool).await, 0);
        assert_eq!(
            state::get_i64(&pool, state::IMAGE_BACKFILL_CURSOR, 0).await,
            0,
            "a failed row must remain ahead of the persisted cursor"
        );

        sqlx::query("DROP TRIGGER reject_image_backfill")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(run(&pool).await, 1);
        assert!(content_of(&pool, 1)
            .await
            .contains(blobs::extract::BLOB_REF_SCHEME));
    }
}
