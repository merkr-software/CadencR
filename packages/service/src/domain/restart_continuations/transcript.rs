//! What a restart leaves in the transcript of the turn it cut off.

use sqlx::SqliteConnection;

/// Result written for a tool call the restart killed, so the transcript shows
/// it ended instead of "Running…" forever.
pub(super) const INTERRUPTED_TOOL_RESULT: &str =
    "Interrupted: Cadencr restarted before this finished.";
/// The same, for a turn the user stopped by quitting Cadencr.
pub(super) const QUIT_TOOL_RESULT: &str = "Stopped: Cadencr quit before this finished.";

/// Opencode's pre-ACP status key; mirrors the frontend's `extractToolStatus`.
const LEGACY_OPENCODE_STATUS_KEY: &str = "__opencode_status";

/// Give every tool call of the interrupted turn that never got a result an
/// error result. Only the calls the transcript would still show as running are
/// closed: a call whose arguments carry a finished status (Codex, OpenCode)
/// already reads as done.
pub(super) async fn close_running_tool_calls(
    connection: &mut SqliteConnection,
    session_id: i64,
    result: &str,
) -> Result<u64, sqlx::Error> {
    let calls: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "SELECT c.tool_use_id, c.parent_tool_use_id, c.content
         FROM agent_messages c
         WHERE c.session_id = ?1 AND c.message_type = 'tool_call'
           AND c.tool_use_id IS NOT NULL
           AND c.id > COALESCE((SELECT MAX(id) FROM agent_messages
                                WHERE session_id = ?1 AND message_type = 'user_message'), 0)
           AND NOT EXISTS (SELECT 1 FROM agent_messages r
                           WHERE r.session_id = c.session_id AND r.tool_use_id = c.tool_use_id
                             AND r.message_type IN ('tool_result', 'tool_error'))
         ORDER BY c.id",
    )
    .bind(session_id)
    .fetch_all(&mut *connection)
    .await?;
    let mut closed = 0;
    for (tool_use_id, parent_tool_use_id, tool_args) in calls {
        if !shows_as_running(&tool_args) {
            continue;
        }
        sqlx::query(
            "INSERT INTO agent_messages
             (session_id, role, content, message_type, tool_use_id, parent_tool_use_id)
             VALUES (?, 'tool', ?, 'tool_error', ?, ?)",
        )
        .bind(session_id)
        .bind(result)
        .bind(tool_use_id)
        .bind(parent_tool_use_id)
        .execute(&mut *connection)
        .await?;
        closed += 1;
    }
    Ok(closed)
}

/// Whether the frontend renders a result-less call as still running.
fn shows_as_running(tool_args: &str) -> bool {
    let status = serde_json::from_str::<serde_json::Value>(tool_args)
        .ok()
        .and_then(|args| {
            let status = args
                .get("status")
                .or_else(|| args.get(LEGACY_OPENCODE_STATUS_KEY))?;
            status.as_str().map(str::to_lowercase)
        });
    match status.as_deref() {
        None => true,
        Some(status) => matches!(status, "pending" | "running" | "active"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::restart_continuations::store::tests::session;
    use crate::domain::schedules::repository::test_support::fixture;

    #[test]
    fn only_unfinished_statuses_read_as_running() {
        assert!(shows_as_running(r#"{"command":"sleep 4"}"#));
        assert!(!shows_as_running(
            r#"{"status":"in_progress_unknown","x":1}"#
        ));
        assert!(shows_as_running(r#"{"status":"Running"}"#));
        assert!(shows_as_running(r#"{"__opencode_status":"pending"}"#));
        assert!(!shows_as_running(r#"{"status":"completed"}"#));
        assert!(shows_as_running("not json"));
    }

    #[tokio::test]
    async fn closes_only_the_interrupted_turns_running_calls() {
        let (pool, _, feature_id) = fixture().await;
        let session_id = session(&pool, feature_id, "paused").await;
        let rows = [
            ("tool_call", Some("old"), r#"{"command":"ls"}"#),
            ("user_message", None, "go on"),
            ("tool_call", Some("done"), r#"{"command":"echo 1"}"#),
            ("tool_result", Some("done"), "1"),
            ("tool_call", Some("codex"), r#"{"status":"completed"}"#),
            ("tool_call", Some("cut"), r#"{"command":"sleep 4"}"#),
        ];
        for (message_type, tool_use_id, content) in rows {
            sqlx::query(
                "INSERT INTO agent_messages (session_id, role, content, message_type, tool_use_id)
                 VALUES (?, 'assistant', ?, ?, ?)",
            )
            .bind(session_id)
            .bind(content)
            .bind(message_type)
            .bind(tool_use_id)
            .execute(&pool)
            .await
            .unwrap();
        }

        let mut connection = pool.acquire().await.unwrap();
        assert_eq!(
            close_running_tool_calls(&mut connection, session_id, INTERRUPTED_TOOL_RESULT)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            close_running_tool_calls(&mut connection, session_id, INTERRUPTED_TOOL_RESULT)
                .await
                .unwrap(),
            0
        );

        let closed: Vec<(String, String)> = sqlx::query_as(
            "SELECT tool_use_id, content FROM agent_messages WHERE message_type = 'tool_error'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(closed, vec![("cut".into(), INTERRUPTED_TOOL_RESULT.into())]);
    }
}
