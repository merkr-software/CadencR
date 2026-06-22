//! Small, self-contained session-level queries: list active sessions for a
//! feature and the live status snapshot used by the WS subscribe handler.
//!
//! The much larger `get_feature_agent_state` query lives in its own
//! `feature_state` module — together with its message-fetch helpers in
//! `feature_state_fetch` — to keep both files under the 400-line cap.

use sqlx::SqlitePool;
use std::collections::HashMap;

use super::super::models::*;
use crate::error::AppError;

pub async fn get_sessions(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Vec<AgentSessionRow>, AppError> {
    let rows = sqlx::query_as::<_, AgentSessionRow>(
        r#"SELECT id, feature_id, agent_type, runtime_provider, runtime_session_id, status, started_at, ended_at,
           subprocess_id, model, pending_questions, has_file_changes,
           permission_mode, codex_permission_mode, pending_permission,
           input_tokens, output_tokens, context_window, was_compacted, draft_prompt
           FROM agent_sessions WHERE feature_id = ? ORDER BY id DESC"#,
    )
    .bind(feature_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Per-session live status snapshot used by the WS subscribe handler to
/// hydrate (re)connecting clients. The result is keyed by `session_id`
/// (stringified for JSON-friendly serialization). Each entry is the full
/// derived [`SessionStatusSnapshotEntry`] minus `seq` — the snapshot wraps
/// these with the broadcaster's `current_seq()` at the moment of subscription.
///
/// Includes `status='paused'` rows that have a pending-input column set —
/// a workflow agent awaiting user input is persisted as `paused` but must
/// surface as Question. Plain-paused rows (no pending column) are excluded
/// so they don't resurrect as a fake "agent" turn.
pub async fn get_session_status_snapshot(
    pool: &SqlitePool,
) -> Result<HashMap<String, SessionStatusSnapshotEntry>, AppError> {
    let rows = sqlx::query_as::<_, SessionStatusSnapshotRow>(
        r#"SELECT id AS session_id,
                  feature_id,
                  status,
                  pending_permission IS NOT NULL AS pending_permission,
                  pending_questions IS NOT NULL AS pending_question
           FROM agent_sessions
           WHERE status = 'running'
              OR pending_questions IS NOT NULL
              OR pending_permission IS NOT NULL"#,
    )
    .fetch_all(pool)
    .await?;

    let mut result = HashMap::new();
    for row in rows {
        let (status, kind) = crate::domain::session_status::derive_status_from_db(
            crate::domain::session_status::DbStatusInputs {
                status_col: &row.status,
                pending_permission: row.pending_permission,
                pending_question: row.pending_question,
            },
        );
        // Idle entries get filtered: a snapshot only carries sessions
        // actively driving the UI. A session with `status='running'` and no
        // pending column is Agent; one with a pending column is Question;
        // an Idle slip-through here would just bloat the payload.
        if status == crate::domain::session_status::AgentStatus::Idle {
            continue;
        }
        result.insert(
            row.session_id.to_string(),
            SessionStatusSnapshotEntry {
                session_id: row.session_id,
                feature_id: row.feature_id,
                status,
                kind,
                // Filled by the WS handler from the active-turn registry; the
                // DB has no per-turn start column.
                turn_started_at_ms: None,
            },
        );
    }
    Ok(result)
}

/// Max characters of an agent reply surfaced in a notification preview.
const PREVIEW_MAX_CHARS: usize = 120;

/// The start of the agent's most recent text reply for a feature, cleaned for a
/// single-line notification body (whitespace collapsed, truncated with an
/// ellipsis). Thinking blocks, tool calls and tool results are excluded — only
/// `role = 'assistant'` / `message_type = 'text'` rows. `None` when the feature
/// has no assistant text yet. Shared by the desktop notification endpoint and
/// the Web Push dispatcher so both render the same body.
pub async fn latest_assistant_preview(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT content FROM agent_messages \
         WHERE session_id IN (SELECT id FROM agent_sessions WHERE feature_id = ?) \
           AND role = 'assistant' AND message_type = 'text' AND TRIM(content) <> '' \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(content,)| preview_snippet(&content)))
}

/// Collapse whitespace and truncate to [`PREVIEW_MAX_CHARS`] on a char boundary.
fn preview_snippet(content: &str) -> String {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= PREVIEW_MAX_CHARS {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(PREVIEW_MAX_CHARS).collect();
    format!("{}…", truncated.trim_end())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    #[test]
    fn preview_snippet_collapses_whitespace_and_truncates() {
        assert_eq!(preview_snippet("  hello\n\n  world  "), "hello world");
        let snippet = preview_snippet(&"a".repeat(200));
        assert!(snippet.ends_with('…'));
        // 120 kept chars + the ellipsis.
        assert_eq!(snippet.chars().count(), PREVIEW_MAX_CHARS + 1);
    }

    #[tokio::test]
    async fn test_get_sessions() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let feature_id = fid.0;

        insert_session(&pool, feature_id, "running").await;
        insert_session(&pool, feature_id, "completed").await;

        let sessions = get_sessions(&pool, feature_id).await.unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[tokio::test]
    async fn test_get_sessions_empty() {
        let pool = setup_test_db().await;
        let sessions = get_sessions(&pool, 9999).await.unwrap();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn test_get_session_status_snapshot() {
        use crate::domain::session_status::{AgentStatus, PendingKind};

        let pool = setup_test_db().await;

        let mk_feature = |label: &'static str| {
            let pool = pool.clone();
            async move {
                let row: (i64,) =
                    sqlx::query_as("INSERT INTO features (title) VALUES (?) RETURNING id")
                        .bind(label)
                        .fetch_one(&pool)
                        .await
                        .unwrap();
                row.0
            }
        };

        let fid1 = mk_feature("f1").await;
        let fid2 = mk_feature("f2").await;
        let fid3 = mk_feature("f3").await;
        let fid5 = mk_feature("f5").await;

        // Feature 1: running session with pending_questions → Question/Question
        let sid1: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status, pending_questions) \
             VALUES (?, 'main', 'running', '[\"q\"]') RETURNING id",
        )
        .bind(fid1)
        .fetch_one(&pool)
        .await
        .unwrap();

        // Feature 2: running session without pending_* → Agent
        let sid2 = insert_session(&pool, fid2, "running").await;

        // Feature 3: PAUSED session with pending_permission → Question/Permission
        let sid3: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status, pending_permission) \
             VALUES (?, 'main', 'paused', '{\"request_id\":\"r\"}') RETURNING id",
        )
        .bind(fid3)
        .fetch_one(&pool)
        .await
        .unwrap();

        // Feature 5: PAUSED session with no pending_* columns → excluded
        // (plain paused, not waiting for input — must not surface in the snapshot)
        let sid5 = insert_session(&pool, fid5, "paused").await;

        let states = get_session_status_snapshot(&pool).await.unwrap();

        let s1 = states.get(&sid1.to_string()).unwrap();
        assert_eq!(s1.status, AgentStatus::Question);
        assert_eq!(s1.kind, Some(PendingKind::Question));
        assert_eq!(s1.feature_id, fid1);

        let s2 = states.get(&sid2.to_string()).unwrap();
        assert_eq!(s2.status, AgentStatus::Agent);
        assert_eq!(s2.kind, None);

        // Paused + pending must surface as Question (this was the sidebar-blank bug).
        let s3 = states.get(&sid3.to_string()).unwrap();
        assert_eq!(s3.status, AgentStatus::Question);
        assert_eq!(s3.kind, Some(PendingKind::Permission));

        // Plain-paused must NOT appear (no pending → idle → filtered out).
        assert!(states.get(&sid5.to_string()).is_none());
    }
}
