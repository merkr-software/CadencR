//! Retroactively drops command output from `tool_call` rows whose `tool_result`
//! already holds the same bytes.
//!
//! This is the historical counterpart to `session_tool_output_dedup`, which
//! keeps new rows clean at write time, and it shares that module's predicate
//! rather than reimplementing it. It is **lossless**: a copy is removed only
//! when the `tool_result` row is carrying the same bytes, so nothing the UI can
//! render is lost. On a real 4.8 GB database it took `tool_call` content from
//! 865 MB to 208 MB.
//!
//! It walks id windows rather than filtering the whole table at once. The full
//! predicate has to JSON-parse every tool_call payload — 23s in one pass on that
//! same database — which would stall the write pool and, in a migration, the
//! app's startup. Windowing bounds each statement's work and lets the cursor
//! survive a restart mid-walk.

use sqlx::SqlitePool;

use super::state;
use crate::domain::ws_session::persistence::{result_output_text, strip_duplicated_bash_output};

mod store;
use store::store_cleaned_if_unchanged;

/// Id range scanned before persisting the resume cursor. Candidate payloads
/// inside the range are still loaded one at a time, so a dense run of multi-MB
/// outputs cannot create a window-sized allocation.
const WINDOW: i64 = 20_000;

/// Pause between windows, so a long backfill never monopolizes the single
/// SQLite writer while the user is actively driving an agent.
const WINDOW_PAUSE: std::time::Duration = std::time::Duration::from_millis(50);

/// Candidate `tool_call` rows in `(after, upto]`, paired with their result.
///
/// The SQL only narrows: it finds rows that carry an output key and have a
/// result row to compare against. Whether the copy is actually a duplicate is
/// decided in Rust by [`strip_duplicated_bash_output`] — the same predicate the
/// live path uses, rather than a second implementation of it in SQL that could
/// drift. That matters because the test is not "a result exists" but "the result
/// actually carries these bytes": a result row that landed without its output
/// (an interrupted turn) leaves the tool_call holding the only copy, and an
/// `output` *argument* on an unrelated tool is not command output at all.
///
/// The correlated subquery rather than a join keeps this one row per tool_call
/// even if a call somehow has two result rows.
const CANDIDATE_WINDOW_SQL: &str = r#"
SELECT c.id, c.content, c.tool_name, (
    SELECT r.content FROM agent_messages r
    WHERE r.session_id = c.session_id
      AND r.tool_use_id = c.tool_use_id
      AND r.message_type IN ('tool_result', 'tool_error')
    LIMIT 1
  ) AS result_content
FROM agent_messages c
WHERE c.message_type = 'tool_call'
  AND c.tool_name = 'Bash'
  AND c.tool_use_id IS NOT NULL
  AND c.id > ? AND c.id <= ?
  AND json_valid(c.content)
  AND json_type(c.content) = 'object'
  AND (json_type(c.content, '$.output') IS NOT NULL
       OR json_type(c.content, '$.aggregatedOutput') IS NOT NULL
       OR json_type(c.content, '$.stdout') IS NOT NULL)
  AND result_content IS NOT NULL
ORDER BY c.id
LIMIT 1
"#;

enum StripWindow {
    Complete(u64),
    Retry(u64),
}

struct StrippedCandidate {
    content: String,
    result_content: String,
    cleaned: String,
}

async fn strip_candidate_async(
    content: String,
    result_content: String,
    tool_name: Option<String>,
) -> Option<StrippedCandidate> {
    match tokio::task::spawn_blocking(move || {
        let result_output = result_output_text(&result_content)?;
        let cleaned = strip_duplicated_bash_output(&content, &result_output, tool_name.as_deref())?;
        Some(StrippedCandidate {
            content,
            result_content,
            cleaned,
        })
    })
    .await
    {
        Ok(stripped) => stripped,
        Err(error) => {
            tracing::warn!("tool-output backfill strip task failed: {error}");
            None
        }
    }
}

/// Strip every genuinely duplicated copy in `(after, upto]`. Returns the number
/// of rows rewritten.
async fn strip_window(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    after: i64,
    upto: i64,
) -> Result<StripWindow, sqlx::Error> {
    let mut cursor = after;
    let mut stripped = 0u64;
    loop {
        // Fetch one call/result pair at a time on the read pool so scanning
        // large JSON rows never stalls the single SQLite writer.
        let candidate =
            sqlx::query_as::<_, (i64, String, Option<String>, String)>(CANDIDATE_WINDOW_SQL)
                .bind(cursor)
                .bind(upto)
                .fetch_optional(read_pool)
                .await?;
        let Some((id, content, tool_name, result_content)) = candidate else {
            break;
        };
        cursor = id;
        let Some(stripped_candidate) =
            strip_candidate_async(content, result_content, tool_name).await
        else {
            continue;
        };
        if !store_cleaned_if_unchanged(
            write_pool,
            id,
            &stripped_candidate.cleaned,
            &stripped_candidate.content,
            &stripped_candidate.result_content,
        )
        .await?
        {
            return Ok(StripWindow::Retry(stripped));
        }
        stripped += 1;
    }
    Ok(StripWindow::Complete(stripped))
}

/// Walk from the persisted cursor to the current max id, stripping as we go.
/// Returns the number of rows rewritten. Errors are logged and end the pass:
/// the cursor stays put, so the next launch resumes from the same place.
#[cfg(test)]
async fn run(pool: &SqlitePool) -> u64 {
    run_with_progress(pool, pool, |_| {}).await
}

pub(super) async fn run_with_progress(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    progress: impl Fn(i64),
) -> u64 {
    let max_id = match sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(id) FROM agent_messages")
        .fetch_one(read_pool)
        .await
    {
        Ok(max_id) => max_id.unwrap_or(0),
        Err(error) => {
            tracing::warn!("tool-output backfill max-id query failed: {error}");
            return 0;
        }
    };

    let mut cursor = state::get_i64(read_pool, state::TOOL_OUTPUT_BACKFILL_CURSOR, 0).await;
    if cursor >= max_id {
        return 0;
    }

    let mut stripped = 0u64;
    while cursor < max_id {
        let upto = (cursor + WINDOW).min(max_id);
        match strip_window(read_pool, write_pool, cursor, upto).await {
            Ok(StripWindow::Complete(rows)) => stripped += rows,
            Ok(StripWindow::Retry(rows)) => {
                stripped += rows;
                tracing::info!(
                    cursor,
                    upto,
                    "tool-output backfill observed a concurrent update; retrying next sweep"
                );
                return stripped;
            }
            Err(e) => {
                tracing::warn!(cursor, upto, "tool-output backfill window failed: {e}");
                return stripped;
            }
        }
        cursor = upto;
        state::set_i64(write_pool, state::TOOL_OUTPUT_BACKFILL_CURSOR, cursor).await;
        progress(cursor);
        tokio::time::sleep(WINDOW_PAUSE).await;
    }

    if stripped > 0 {
        tracing::info!(
            rows = stripped,
            "dropped duplicated tool_call output; run VACUUM to reclaim the file space"
        );
    }
    stripped
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, \
             updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
            "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, \
             role TEXT NOT NULL DEFAULT 'assistant', content TEXT NOT NULL, \
             message_type TEXT NOT NULL, tool_name TEXT, tool_use_id TEXT)",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn insert(pool: &SqlitePool, id: i64, kind: &str, tool_use_id: &str, content: &str) {
        sqlx::query(
            "INSERT INTO agent_messages \
             (id, session_id, content, message_type, tool_name, tool_use_id) \
             VALUES (?, 1, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(content)
        .bind(kind)
        .bind((kind == "tool_call").then_some("Bash"))
        .bind(tool_use_id)
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

    const WITH_OUTPUT: &str =
        r#"{"command":"pnpm test","status":"completed","output":"ok","aggregatedOutput":"ok"}"#;

    #[tokio::test]
    async fn strips_output_when_the_result_row_exists() {
        let pool = test_pool().await;
        insert(&pool, 1, "tool_call", "tu-1", WITH_OUTPUT).await;
        insert(&pool, 2, "tool_result", "tu-1", "ok").await;

        assert_eq!(run(&pool).await, 1);

        let parsed: serde_json::Value =
            serde_json::from_str(&content_of(&pool, 1).await).expect("valid json");
        assert!(parsed.get("output").is_none());
        assert!(parsed.get("aggregatedOutput").is_none());
        assert_eq!(parsed["command"], serde_json::json!("pnpm test"));
    }

    /// The OpenCode case: no result row anywhere, so the tool_call holds the
    /// only copy of the output and must be left completely alone.
    #[tokio::test]
    async fn preserves_output_when_no_result_row_exists() {
        let pool = test_pool().await;
        insert(&pool, 1, "tool_call", "tu-1", WITH_OUTPUT).await;

        assert_eq!(run(&pool).await, 0);
        assert_eq!(content_of(&pool, 1).await, WITH_OUTPUT);
    }

    #[tokio::test]
    async fn strips_when_the_result_is_an_error_row() {
        let pool = test_pool().await;
        insert(&pool, 1, "tool_call", "tu-1", WITH_OUTPUT).await;
        // The error row still carries the output, so the copy is redundant.
        insert(&pool, 2, "tool_error", "tu-1", "ok").await;

        assert_eq!(run(&pool).await, 1);
        let parsed: serde_json::Value =
            serde_json::from_str(&content_of(&pool, 1).await).expect("valid json");
        assert!(parsed.get("output").is_none());
    }

    /// A command that printed output and *then* failed leaves the log on the
    /// tool_call and an unrelated message on the error row. Existence of the
    /// error row is not evidence the output was preserved anywhere else.
    #[tokio::test]
    async fn preserves_output_when_the_error_row_does_not_carry_it() {
        let pool = test_pool().await;
        insert(&pool, 1, "tool_call", "tu-1", WITH_OUTPUT).await;
        insert(&pool, 2, "tool_error", "tu-1", "boom").await;

        assert_eq!(run(&pool).await, 0);
        assert_eq!(content_of(&pool, 1).await, WITH_OUTPUT);
    }

    /// The interrupted-turn case: a result row landed with metadata only.
    #[tokio::test]
    async fn preserves_output_when_the_result_carries_none() {
        let pool = test_pool().await;
        insert(&pool, 1, "tool_call", "tu-1", WITH_OUTPUT).await;
        insert(
            &pool,
            2,
            "tool_result",
            "tu-1",
            r#"{"command":"pnpm test","status":"completed","exitCode":0}"#,
        )
        .await;

        assert_eq!(run(&pool).await, 0);
        assert_eq!(content_of(&pool, 1).await, WITH_OUTPUT);
    }

    /// A result under a *different* tool_use_id must not authorize the strip.
    #[tokio::test]
    async fn preserves_output_when_the_result_belongs_to_another_call() {
        let pool = test_pool().await;
        insert(&pool, 1, "tool_call", "tu-1", WITH_OUTPUT).await;
        insert(&pool, 2, "tool_result", "tu-other", "ok").await;

        assert_eq!(run(&pool).await, 0);
        assert_eq!(content_of(&pool, 1).await, WITH_OUTPUT);
    }

    #[tokio::test]
    async fn leaves_non_json_and_output_free_payloads_untouched() {
        let pool = test_pool().await;
        insert(&pool, 1, "tool_call", "tu-1", "not json at all").await;
        insert(&pool, 2, "tool_result", "tu-1", "ok").await;
        insert(&pool, 3, "tool_call", "tu-2", r#"{"command":"ls"}"#).await;
        insert(&pool, 4, "tool_result", "tu-2", "ok").await;

        assert_eq!(run(&pool).await, 0);
        assert_eq!(content_of(&pool, 1).await, "not json at all");
        assert_eq!(content_of(&pool, 3).await, r#"{"command":"ls"}"#);
    }

    #[tokio::test]
    async fn stale_snapshot_cannot_overwrite_live_tool_call_content() {
        let pool = test_pool().await;
        insert(&pool, 1, "tool_call", "tu-1", WITH_OUTPUT).await;
        insert(&pool, 2, "tool_result", "tu-1", "ok").await;
        let cleaned = strip_duplicated_bash_output(WITH_OUTPUT, "ok", Some("Bash")).unwrap();
        let live = r#"{"command":"pnpm test","status":"running","output":"new"}"#;
        sqlx::query("UPDATE agent_messages SET content = ? WHERE id = 1")
            .bind(live)
            .execute(&pool)
            .await
            .unwrap();

        assert!(
            !store_cleaned_if_unchanged(&pool, 1, &cleaned, WITH_OUTPUT, "ok")
                .await
                .unwrap()
        );
        assert_eq!(content_of(&pool, 1).await, live);
    }

    #[tokio::test]
    async fn never_strips_output_arguments_from_non_bash_tools() {
        let pool = test_pool().await;
        let call = r#"{"output":"report","path":"findings.json"}"#;
        insert(&pool, 1, "tool_call", "tu-1", call).await;
        sqlx::query("UPDATE agent_messages SET tool_name = 'Write' WHERE id = 1")
            .execute(&pool)
            .await
            .unwrap();
        insert(
            &pool,
            2,
            "tool_result",
            "tu-1",
            "report created successfully",
        )
        .await;

        assert_eq!(run(&pool).await, 0);
        assert_eq!(content_of(&pool, 1).await, call);
    }

    #[tokio::test]
    async fn resumes_from_the_cursor_and_is_idempotent() {
        let pool = test_pool().await;
        insert(&pool, 1, "tool_call", "tu-1", WITH_OUTPUT).await;
        insert(&pool, 2, "tool_result", "tu-1", "ok").await;

        assert_eq!(run(&pool).await, 1);
        // Cursor is parked at the end, so a second pass does no work at all.
        assert_eq!(run(&pool).await, 0);

        // A row arriving after the cursor is still picked up on the next pass.
        insert(&pool, 100, "tool_call", "tu-2", WITH_OUTPUT).await;
        insert(&pool, 101, "tool_result", "tu-2", "ok").await;
        assert_eq!(run(&pool).await, 1);
    }

    #[tokio::test]
    async fn walks_ids_spanning_multiple_windows() {
        let pool = test_pool().await;
        // Straddle a window boundary so the loop has to take more than one step.
        for (index, id) in [1i64, WINDOW - 1, WINDOW + 5, WINDOW * 2 + 3]
            .into_iter()
            .enumerate()
        {
            let tool_use_id = format!("tu-{index}");
            insert(&pool, id, "tool_call", &tool_use_id, WITH_OUTPUT).await;
            insert(&pool, id + 1, "tool_result", &tool_use_id, "ok").await;
        }

        assert_eq!(run(&pool).await, 4);
    }
}
