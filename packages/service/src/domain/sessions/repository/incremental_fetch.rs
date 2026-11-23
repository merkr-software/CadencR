//! Revision-cursor fetching for mutable persisted tool calls.

use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::HashMap;

use super::super::models::{AgentMessageRow, AgentSessionRow};
use super::pagination::fetch_missing_parents;
use super::MESSAGE_SELECT;
use crate::error::AppError;

pub(super) struct IncrementalData {
    pub messages: HashMap<i64, Vec<AgentMessageRow>>,
    pub updated_tool_calls: HashMap<i64, HashMap<i64, String>>,
    pub revision_cursors: HashMap<i64, i64>,
    pub revision_has_more: HashMap<i64, bool>,
    pub message_has_more: HashMap<i64, bool>,
    pub message_cursors: HashMap<i64, i64>,
}

const LEGACY_TOOL_UPDATE_LIMIT: i64 = 100;
const TOOL_UPDATE_PAGE_LIMIT: i64 = 16;
const INCREMENTAL_MESSAGE_PAGE_LIMIT: usize = 40;

/// Fetch new immutable messages plus tool-call rows changed after the client's
/// independent content-revision cursor. `until` bounds a session's page from
/// above (exclusive): a client filling a gap in its history stops the page at
/// the messages it already holds below the gap.
pub(super) async fn fetch_incremental_data(
    pool: &SqlitePool,
    fetches: &[(i64, i64)],
    after_revisions: &HashMap<i64, i64>,
    until: &HashMap<i64, i64>,
    sessions: &[AgentSessionRow],
) -> Result<IncrementalData, AppError> {
    let mut messages: HashMap<i64, Vec<AgentMessageRow>> = HashMap::new();
    let mut updated_tool_calls: HashMap<i64, HashMap<i64, String>> = HashMap::new();
    let mut revision_cursors = HashMap::new();
    let mut revision_has_more = HashMap::new();
    let mut message_has_more = HashMap::new();
    let mut message_cursors = HashMap::new();
    let captured_revisions: HashMap<i64, i64> = sessions
        .iter()
        .map(|session| (session.id, session.message_revision))
        .collect();

    for (sid, after_id) in fetches {
        let mut msgs = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(format!(
            "{MESSAGE_SELECT} FROM agent_messages
             WHERE session_id = ? AND id > ? AND id < ? ORDER BY id ASC LIMIT ?"
        )))
        .bind(sid)
        .bind(after_id)
        .bind(until.get(sid).copied().unwrap_or(i64::MAX))
        .bind(INCREMENTAL_MESSAGE_PAGE_LIMIT as i64 + 1)
        .fetch_all(pool)
        .await?;
        let has_more_messages = msgs.len() > INCREMENTAL_MESSAGE_PAGE_LIMIT;
        msgs.truncate(INCREMENTAL_MESSAGE_PAGE_LIMIT);
        message_cursors.insert(*sid, msgs.last().map_or(*after_id, |message| message.id));
        // A bounded page may begin in the middle of a Task/Agent subtree. Inject
        // the referenced parent rows for block construction without counting
        // them toward the page cursor or page-size limit.
        let mut parents = fetch_missing_parents(pool, *sid, &msgs).await?;
        parents.append(&mut msgs);
        parents.sort_by_key(|message| message.id);
        msgs = parents;
        message_has_more.insert(*sid, has_more_messages);
        messages.insert(*sid, msgs);

        let captured_revision = captured_revisions.get(sid).copied().unwrap_or(0);
        let stale = if let Some(after_revision) = after_revisions.get(sid) {
            let mut rows: Vec<(i64, String, i64)> = sqlx::query_as(
                "SELECT id, content, content_revision FROM agent_messages
                 WHERE session_id = ? AND message_type = 'tool_call'
                   AND content_revision > 0
                   AND content_revision > ? AND content_revision <= ?
                 ORDER BY content_revision ASC LIMIT ?",
            )
            .bind(sid)
            .bind(after_revision)
            .bind(captured_revision)
            .bind(TOOL_UPDATE_PAGE_LIMIT + 1)
            .fetch_all(pool)
            .await?;
            let has_more = rows.len() as i64 > TOOL_UPDATE_PAGE_LIMIT;
            rows.truncate(TOOL_UPDATE_PAGE_LIMIT as usize);
            let applied_revision = rows.last().map_or(captured_revision, |row| row.2);
            revision_cursors.insert(*sid, applied_revision);
            revision_has_more.insert(*sid, has_more);
            rows.into_iter()
                .map(|(id, content, _)| (id, content))
                .collect()
        } else {
            // Older clients have no revision cursor. Keep compatibility
            // bounded instead of replaying every historical tool call.
            let mut rows: Vec<(i64, String)> = sqlx::query_as(
                "SELECT id, content FROM agent_messages
                 WHERE session_id = ? AND id <= ? AND message_type = 'tool_call'
                   AND content_revision > 0 AND content_revision <= ?
                 ORDER BY content_revision DESC LIMIT ?",
            )
            .bind(sid)
            .bind(after_id)
            .bind(captured_revision)
            .bind(LEGACY_TOOL_UPDATE_LIMIT)
            .fetch_all(pool)
            .await?;
            rows.reverse();
            rows
        };
        if !stale.is_empty() {
            updated_tool_calls.insert(*sid, stale.into_iter().collect());
        }
    }

    Ok(IncrementalData {
        messages,
        updated_tool_calls,
        revision_cursors,
        revision_has_more,
        message_has_more,
        message_cursors,
    })
}

#[cfg(test)]
mod tests {
    use super::super::feature_state::get_feature_agent_state;
    use super::super::test_support::{insert_message, insert_session, setup_test_db};
    use super::*;

    async fn load_session(pool: &SqlitePool, session_id: i64) -> AgentSessionRow {
        sqlx::query_as(
            "SELECT id, feature_id, agent_type, runtime_provider, runtime_session_id, status,
             started_at, ended_at, subprocess_id, model, profile, pending_questions,
             has_file_changes, permission_mode, codex_permission_mode, pending_permission,
             input_tokens, output_tokens, context_window, was_compacted, draft_prompt,
             message_revision FROM agent_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn revision_pages_advance_without_skipping_tool_updates() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 1, "completed").await;
        let mut ids = Vec::new();
        for index in 0..17 {
            let id = insert_message(
                &pool,
                session_id,
                "tool_call",
                "{}",
                Some("Read"),
                Some(&format!("tool-{index}")),
                None,
            )
            .await;
            ids.push(id);
            sqlx::query("UPDATE agent_messages SET content = ? WHERE id = ?")
                .bind(format!(r#"{{"index":{index}}}"#))
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }
        let after = HashMap::from([(session_id, *ids.last().unwrap())]);
        let first = get_feature_agent_state(
            &pool,
            1,
            Some(after.clone()),
            Some(HashMap::from([(session_id, 0)])),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            first.sessions[0].tool_call_updates.as_ref().unwrap().len(),
            16
        );
        assert_eq!(first.sessions[0].max_content_revision, Some(16));
        assert_eq!(first.sessions[0].has_more_content_revisions, Some(true));

        let second = get_feature_agent_state(
            &pool,
            1,
            Some(after),
            Some(HashMap::from([(session_id, 16)])),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            second.sessions[0].tool_call_updates.as_ref().unwrap().len(),
            1
        );
        assert_eq!(second.sessions[0].max_content_revision, Some(17));
        assert_eq!(second.sessions[0].has_more_content_revisions, Some(false));
    }

    #[tokio::test]
    async fn new_message_pages_advance_without_skipping_rows() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 1, "completed").await;
        for index in 0..42 {
            insert_message(
                &pool,
                session_id,
                "user_message",
                &format!("row-{index}"),
                None,
                None,
                None,
            )
            .await;
        }
        let first = get_feature_agent_state(
            &pool,
            1,
            Some(HashMap::from([(session_id, 0)])),
            Some(HashMap::from([(session_id, 0)])),
            None,
            None,
        )
        .await
        .unwrap();
        // Cursor 0 selects a full fetch by contract, so start from the first row.
        let first_id: (i64,) =
            sqlx::query_as("SELECT MIN(id) FROM agent_messages WHERE session_id = ?")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let page = get_feature_agent_state(
            &pool,
            1,
            Some(HashMap::from([(session_id, first_id.0)])),
            Some(HashMap::from([(session_id, 0)])),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(page.sessions[0].blocks.len(), 40);
        assert_eq!(page.sessions[0].has_more_incremental_messages, Some(true));
        let tail = get_feature_agent_state(
            &pool,
            1,
            Some(HashMap::from([(
                session_id,
                page.sessions[0].max_message_id,
            )])),
            Some(HashMap::from([(session_id, 0)])),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(tail.sessions[0].blocks.len(), 1);
        assert_eq!(tail.sessions[0].has_more_incremental_messages, Some(false));
        assert!(first.sessions[0].blocks.len() <= 42);
    }

    #[tokio::test]
    async fn byte_bounded_incremental_pages_advance_without_skipping_rows() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 1, "completed").await;
        let anchor_id = insert_message(
            &pool,
            session_id,
            "user_message",
            "anchor",
            None,
            None,
            None,
        )
        .await;
        let mut expected_ids = Vec::new();
        for index in 0..24 {
            expected_ids.push(
                insert_message(
                    &pool,
                    session_id,
                    "tool_call",
                    &"x".repeat(64 * 1024),
                    Some("Read"),
                    Some(&format!("large-{index}")),
                    None,
                )
                .await,
            );
        }

        let mut cursor = anchor_id;
        let mut received_ids = Vec::new();
        loop {
            let response = get_feature_agent_state(
                &pool,
                1,
                Some(HashMap::from([(session_id, cursor)])),
                Some(HashMap::from([(session_id, 0)])),
                None,
                None,
            )
            .await
            .unwrap();
            let page = &response.sessions[0];
            assert!(
                serde_json::to_vec(&page.blocks).unwrap().len()
                    <= super::super::byte_pagination::SESSION_WIRE_SOFT_CAP_BYTES
            );
            assert!(page.max_message_id > cursor, "cursor must make progress");
            received_ids.extend(
                page.blocks
                    .iter()
                    .filter_map(super::super::pagination::block_message_id),
            );
            cursor = page.max_message_id;
            if page.has_more_incremental_messages == Some(false) {
                break;
            }
        }

        assert_eq!(received_ids, expected_ids);
    }

    #[tokio::test]
    async fn edit_after_captured_upper_bound_is_deferred_not_skipped() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 1, "running").await;
        let call_id = insert_message(
            &pool,
            session_id,
            "tool_call",
            "{}",
            Some("Read"),
            Some("tool"),
            None,
        )
        .await;
        sqlx::query("UPDATE agent_messages SET content = 'first' WHERE id = ?")
            .bind(call_id)
            .execute(&pool)
            .await
            .unwrap();
        let captured = load_session(&pool, session_id).await;
        sqlx::query("UPDATE agent_messages SET content = 'second' WHERE id = ?")
            .bind(call_id)
            .execute(&pool)
            .await
            .unwrap();

        let deferred = fetch_incremental_data(
            &pool,
            &[(session_id, call_id)],
            &HashMap::from([(session_id, 0)]),
            &HashMap::new(),
            &[captured],
        )
        .await
        .unwrap();
        assert!(!deferred.updated_tool_calls.contains_key(&session_id));
        assert_eq!(deferred.revision_cursors[&session_id], 1);

        let fresh = load_session(&pool, session_id).await;
        let caught = fetch_incremental_data(
            &pool,
            &[(session_id, call_id)],
            &HashMap::from([(session_id, 1)]),
            &HashMap::new(),
            &[fresh],
        )
        .await
        .unwrap();
        assert_eq!(caught.updated_tool_calls[&session_id][&call_id], "second");
        assert_eq!(caught.revision_cursors[&session_id], 2);
    }
}
