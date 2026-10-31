use super::TranscriptWriter;
use sqlx::SqlitePool;

// Drops streamed command output from a `tool_call` row once the matching
// `tool_result` has landed.
//
// While a command runs, providers stamp its output onto the tool_call's input
// JSON (via `ToolInputBuffer::apply_object_delta`) so the UI has something to
// render live. When the turn completes the same bytes arrive again as a
// `tool_result` row, and the UI renders *that* row in preference to the
// tool_call copy — `AgentBlock.tsx` does `resultOutput ?? extractBashOutput(
// block.toolArgs)`. The tool_call copy is dead weight from that point on: it
// accounted for 687 MB across `output` and `aggregatedOutput` in a production
// database.
//
// The safety property is that a copy is dropped only when the result row
// demonstrably *carries the same bytes* — not merely when a result row exists.
// Those are different tests, and the weaker one loses data: a turn interrupted
// mid-command, or a Codex restart that empties the in-process map
// `aggregatedOutput` is back-filled from, produces a result row with no output
// at all, and the tool_call is then the only copy. A provider that never emits
// result rows is covered by the same check, so this needs no provider branch —
// which the provider-boundary rule wants anyway.

/// Command-output keys a provider may stamp onto a `tool_call` row. Mirrors the
/// keys read by `truncate_bash_output` (backend) and `extractBashOutput`
/// (frontend); `command`, `status`, `exitCode` and friends are metadata the UI
/// still needs and are left in place.
const DUPLICATED_OUTPUT_KEYS: [&str; 3] = ["output", "aggregatedOutput", "stdout"];

/// The output text a `tool_result` row carries, if any. An envelope exposes it
/// under one of [`DUPLICATED_OUTPUT_KEYS`]; any other shape — a bare JSON string,
/// or content that isn't JSON at all — *is* the output.
pub(crate) fn result_output_text(content: &str) -> Option<String> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Object(map)) => {
            DUPLICATED_OUTPUT_KEYS
                .iter()
                .find_map(|key| match map.get(*key) {
                    Some(serde_json::Value::String(text)) if !text.is_empty() => Some(text.clone()),
                    _ => None,
                })
        }
        _ if content.trim().is_empty() => None,
        _ => Some(content.to_string()),
    }
}

/// Remove the duplicated output fields from a tool_call content envelope.
///
/// A key is dropped only when its value is actually present in `result_output`.
/// Existence of a result row is *not* enough on its own: a result can land
/// carrying only `{command, status, exitCode}` — a service restart mid-command
/// empties the in-process output map Codex back-fills `aggregatedOutput` from —
/// and stripping then would delete the only copy of the log, leaving the UI with
/// nothing to render. The same check keeps the pass off a tool's *arguments*: an
/// MCP tool invoked with an `output` parameter never matches its own result, so
/// the parameter survives.
///
/// Returns `None` when nothing matched, so callers can skip a pointless UPDATE
/// (each one re-indexes the row in FTS via the `agent_messages_au` trigger).
pub(crate) fn strip_duplicated_bash_output(
    content: &str,
    result_output: &str,
    tool_name: Option<&str>,
) -> Option<String> {
    // Other tools are allowed to have arguments named `output` or `stdout`.
    // Even a prefix match with their result is not evidence that such an
    // argument is streamed output, so tool identity is part of the predicate.
    if !crate::domain::sessions::repository::truncation::is_bash_tool_name(tool_name) {
        return None;
    }
    let mut value = serde_json::from_str::<serde_json::Value>(content).ok()?;
    let object = value.as_object_mut()?;

    let duplicated: Vec<&str> = DUPLICATED_OUTPUT_KEYS
        .iter()
        .copied()
        .filter(|key| match object.get(*key) {
            // `starts_with` rather than equality: while the command runs the
            // live copy is whatever had streamed in by then, so it is a prefix
            // of the final output rather than all of it. Prefix rather than
            // `contains`, because a short argument value ("report.md") can
            // appear anywhere in an unrelated result by coincidence, and
            // deleting it on that basis is exactly the bug this check exists to
            // prevent.
            Some(serde_json::Value::String(text)) => {
                !text.is_empty() && result_output.starts_with(text.as_str())
            }
            _ => false,
        })
        .collect();
    if duplicated.is_empty() {
        return None;
    }
    for key in duplicated {
        object.remove(key);
    }
    serde_json::to_string(&value).ok()
}

impl TranscriptWriter {
    /// Strip the now-redundant output copy from the tool_call paired with
    /// `tool_use_id`. Best-effort: a failure here costs disk space, never
    /// correctness, so it logs and moves on rather than failing the turn.
    pub(super) async fn drop_duplicated_tool_call_output(
        pool: &SqlitePool,
        session_id: i64,
        tool_use_id: &str,
        result_content: &str,
    ) {
        let existing = sqlx::query_as::<_, (i64, String)>(
            "SELECT id, content FROM agent_messages \
             WHERE session_id = ? AND tool_use_id = ? AND message_type = 'tool_call' \
               AND tool_name = 'Bash' \
             LIMIT 1",
        )
        .bind(session_id)
        .bind(tool_use_id)
        .fetch_optional(pool)
        .await;

        let existing = match existing {
            Ok(existing) => existing,
            Err(error) => {
                tracing::warn!(
                    session_id,
                    tool_use_id,
                    "failed to load Bash tool_call: {error}"
                );
                return;
            }
        };
        let Some((id, content)) = existing else {
            return;
        };
        // Parsing a potentially large result is only worthwhile for Bash.
        let Some(result_output) = result_output_text(result_content) else {
            return;
        };
        let Some(stripped) = strip_duplicated_bash_output(&content, &result_output, Some("Bash"))
        else {
            return;
        };
        match store_stripped_if_unchanged(pool, id, &stripped, &content, result_content).await {
            Ok(_) => {}
            Err(error) => tracing::warn!(
                message_id = id,
                "failed to drop duplicated tool_call output: {error}"
            ),
        }
    }
}

async fn store_stripped_if_unchanged(
    pool: &SqlitePool,
    id: i64,
    stripped: &str,
    expected_call: &str,
    expected_result: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE agent_messages SET content = ?
         WHERE id = ? AND content = ?
           AND message_type = 'tool_call' AND tool_name = 'Bash'
           AND EXISTS (
             SELECT 1 FROM agent_messages r
             WHERE r.session_id = agent_messages.session_id
               AND r.tool_use_id = agent_messages.tool_use_id
               AND r.message_type IN ('tool_result', 'tool_error')
               AND r.content = ?
           )",
    )
    .bind(stripped)
    .bind(id)
    .bind(expected_call)
    .bind(expected_result)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
mod session_tool_output_dedup_tests {
    use super::*;

    /// The output the result row carries in most of these cases.
    const RESULT: &str = "a\nb\nc";

    fn strip(content: &str, result: &str) -> Option<String> {
        strip_duplicated_bash_output(content, result, Some("Bash"))
    }

    #[test]
    fn strips_every_output_key_and_keeps_metadata() {
        let content = serde_json::json!({
            "command": "pnpm test",
            "status": "completed",
            "exitCode": 0,
            "output": "a\nb\nc",
            "aggregatedOutput": "a\nb\nc",
            "stdout": "a\nb\nc",
        })
        .to_string();

        let stripped = strip(&content, RESULT).expect("keys present");
        let parsed: serde_json::Value = serde_json::from_str(&stripped).expect("valid json");

        for key in DUPLICATED_OUTPUT_KEYS {
            assert!(parsed.get(key).is_none(), "{key} should be gone");
        }
        assert_eq!(parsed["command"], serde_json::json!("pnpm test"));
        assert_eq!(parsed["status"], serde_json::json!("completed"));
        assert_eq!(parsed["exitCode"], serde_json::json!(0));
    }

    #[test]
    fn returns_none_when_nothing_to_strip() {
        let content = serde_json::json!({ "command": "ls", "status": "completed" }).to_string();
        assert!(strip(&content, RESULT).is_none());
    }

    #[test]
    fn returns_none_for_non_object_content() {
        assert!(strip("plain text output", RESULT).is_none());
        assert!(strip("[1, 2, 3]", RESULT).is_none());
    }

    #[test]
    fn strips_partial_key_sets() {
        let content = serde_json::json!({ "command": "ls", "aggregatedOutput": "x" }).to_string();
        let stripped = strip(&content, "x").expect("one key present");
        let parsed: serde_json::Value = serde_json::from_str(&stripped).expect("valid json");
        assert!(parsed.get("aggregatedOutput").is_none());
        assert_eq!(parsed["command"], serde_json::json!("ls"));
    }

    /// The case that made the old "a result row exists" predicate destructive:
    /// the result landed without the output, so the tool_call held the only copy.
    #[test]
    fn keeps_the_output_when_the_result_does_not_carry_it() {
        let content = serde_json::json!({
            "command": "pnpm build",
            "aggregatedOutput": "1000 lines of build log",
        })
        .to_string();
        let result_without_output =
            serde_json::json!({ "command": "pnpm build", "status": "completed", "exitCode": 0 })
                .to_string();

        assert!(result_output_text(&result_without_output).is_none());
        assert!(strip(&content, "").is_none());
    }

    /// A tool's `output` *argument* is not command output. It never appears in
    /// the result, so it must survive — this used to be deleted outright.
    #[test]
    fn keeps_an_output_argument_that_is_not_in_the_result() {
        let content = serde_json::json!({
            "path": "src/main.rs",
            "output": "report.md",
        })
        .to_string();

        let result = "wrote 42 findings to report.md";
        assert!(
            strip(&content, result).is_none(),
            "an argument that merely shares a name with an output key is not a duplicate"
        );
    }

    /// While a command runs the live copy is whatever had streamed in so far, so
    /// the duplicate is usually a prefix of the final output rather than equal.
    #[test]
    fn strips_a_partially_streamed_copy() {
        let content = serde_json::json!({ "aggregatedOutput": "first half" }).to_string();
        let result = "first half and then the rest of it";

        assert!(strip(&content, result).is_some());
    }

    #[test]
    fn never_strips_a_non_bash_output_argument_even_when_it_prefixes_the_result() {
        let content = serde_json::json!({
            "output": "report",
            "path": "findings.json",
        })
        .to_string();

        assert!(
            strip_duplicated_bash_output(&content, "report created successfully", Some("Write"))
                .is_none(),
            "a result prefix is not proof that a non-Bash argument is duplicated output"
        );
    }

    #[test]
    fn reads_result_output_from_every_shape() {
        assert_eq!(
            result_output_text(&serde_json::json!({ "aggregatedOutput": "x" }).to_string()),
            Some("x".to_string())
        );
        // A bare string result is itself the output.
        assert_eq!(
            result_output_text("just some text"),
            Some("just some text".to_string())
        );
        assert!(result_output_text("   ").is_none());
        assert!(result_output_text(&serde_json::json!({ "status": "ok" }).to_string()).is_none());
    }

    async fn persistence_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY,
                session_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                message_type TEXT NOT NULL,
                tool_name TEXT,
                tool_use_id TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn compare_and_set_preserves_a_newer_live_tool_call() {
        let pool = persistence_pool().await;
        let old = serde_json::json!({ "command": "build", "output": "partial" }).to_string();
        let live = serde_json::json!({ "command": "build", "output": "newer" }).to_string();
        let stripped = serde_json::json!({ "command": "build" }).to_string();
        sqlx::query(
            "INSERT INTO agent_messages VALUES
             (1, 1, ?, 'tool_call', 'Bash', 'call-1'),
             (2, 1, 'partial output complete', 'tool_result', NULL, 'call-1')",
        )
        .bind(&old)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE agent_messages SET content = ? WHERE id = 1")
            .bind(&live)
            .execute(&pool)
            .await
            .unwrap();

        assert!(
            !store_stripped_if_unchanged(&pool, 1, &stripped, &old, "partial output complete")
                .await
                .unwrap()
        );
        let stored: String = sqlx::query_scalar("SELECT content FROM agent_messages WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(stored, live);
    }

    #[tokio::test]
    async fn compare_and_set_requires_the_exact_persisted_result() {
        let pool = persistence_pool().await;
        let old = serde_json::json!({ "command": "build", "output": "partial" }).to_string();
        let stripped = serde_json::json!({ "command": "build" }).to_string();
        sqlx::query(
            "INSERT INTO agent_messages VALUES
             (1, 1, ?, 'tool_call', 'Bash', 'call-1'),
             (2, 1, 'different result', 'tool_result', NULL, 'call-1')",
        )
        .bind(&old)
        .execute(&pool)
        .await
        .unwrap();

        assert!(
            !store_stripped_if_unchanged(&pool, 1, &stripped, &old, "expected result")
                .await
                .unwrap()
        );
    }
}
