//! Batched session hydration for `list_unified_agents`.
//!
//! Fetches candidate sessions, their latest limited message windows, initial
//! user-prompt anchors, cross-page parent tool calls, message origins, and
//! latest todo snapshots in a constant number of SQLite queries instead of an
//! N+1 loop over `get_feature_agent_state`.

use std::collections::HashMap;

use sqlx::{AssertSqlSafe, SqlitePool};

use super::super::models::{AgentMessageRow, AgentSessionRow, SessionState};
use super::feature_state_build::build_session_state;
use super::latest_todos::fetch_latest_todos;
use super::origins::attach_message_origins;
use super::pagination::fetch_missing_parents_batch;
use super::{MESSAGE_SELECT, SESSION_SELECT};
use crate::error::AppError;

const SESSION_ID_CHUNK_SIZE: usize = 500;
const COMPOUND_BRANCH_CHUNK_SIZE: usize = 50;
const USER_MESSAGE_TYPE: &str = "user_message";

/// Hydrate a batch of sessions with their latest `limit` messages, matching the
/// per-session behavior of `get_feature_agent_state(..., None, None, Some(limit), None)`.
pub(crate) async fn get_sessions_agent_state_batch(
    pool: &SqlitePool,
    session_ids: &[i64],
    limit: i64,
) -> Result<HashMap<i64, SessionState>, AppError> {
    let mut unique_ids = session_ids.to_vec();
    unique_ids.sort_unstable();
    unique_ids.dedup();
    if unique_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let sessions = fetch_sessions_by_ids(pool, &unique_ids).await?;
    if sessions.is_empty() {
        return Ok(HashMap::new());
    }
    let found_ids: Vec<i64> = sessions.iter().map(|s| s.id).collect();
    let msg_limit = limit.max(1);

    let ((mut messages_by_session, has_more_map, oldest_message_id_map), mut todos_by_session) = tokio::try_join!(
        fetch_latest_messages_batch(pool, &found_ids, msg_limit),
        fetch_latest_todos(pool, &found_ids),
    )?;

    let anchor_ids: Vec<i64> = has_more_map
        .iter()
        .filter_map(|(&sid, &has_more)| {
            (has_more && oldest_message_id_map.contains_key(&sid)).then_some(sid)
        })
        .collect();
    if !anchor_ids.is_empty() {
        let anchors = fetch_initial_user_anchors_batch(pool, &anchor_ids).await?;
        for anchor in anchors {
            if let Some(&oldest_id) = oldest_message_id_map.get(&anchor.session_id) {
                if anchor.id < oldest_id {
                    messages_by_session
                        .entry(anchor.session_id)
                        .or_default()
                        .push(anchor);
                }
            }
        }
    }

    fetch_missing_parents_batch(pool, &mut messages_by_session).await?;
    for rows in messages_by_session.values_mut() {
        rows.sort_unstable_by_key(|message| message.id);
    }

    attach_message_origins(pool, &mut messages_by_session).await?;

    let empty_i64 = HashMap::new();
    let empty_bool = HashMap::new();
    let empty_updates = HashMap::new();
    let mut states = HashMap::with_capacity(sessions.len());
    for session in sessions {
        let sid = session.id;
        let msgs = messages_by_session.remove(&sid).unwrap_or_default();
        let state = build_session_state()
            .s(session)
            .msgs(msgs)
            .is_incremental(false)
            .revision_cursors(&empty_i64)
            .revision_has_more(&empty_bool)
            .message_has_more(&empty_bool)
            .message_cursors(&empty_i64)
            .after_map(&empty_i64)
            .updated_tool_calls(&empty_updates)
            .todos_by_session(&mut todos_by_session)
            .has_more_map(&has_more_map)
            .oldest_message_id_map(&oldest_message_id_map)
            .call();
        states.insert(sid, state);
    }
    Ok(states)
}

async fn fetch_sessions_by_ids(
    pool: &SqlitePool,
    session_ids: &[i64],
) -> Result<Vec<AgentSessionRow>, AppError> {
    let mut sessions = Vec::with_capacity(session_ids.len());
    for chunk in session_ids.chunks(SESSION_ID_CHUNK_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "{SESSION_SELECT} FROM agent_sessions WHERE id IN ({placeholders}) ORDER BY id ASC"
        );
        let mut query = sqlx::query_as::<_, AgentSessionRow>(AssertSqlSafe(sql));
        for sid in chunk {
            query = query.bind(sid);
        }
        sessions.extend(query.fetch_all(pool).await?);
    }
    Ok(sessions)
}

type LatestBatchResult = (
    HashMap<i64, Vec<AgentMessageRow>>,
    HashMap<i64, bool>,
    HashMap<i64, i64>,
);

/// Fetch the latest `msg_limit + 1` messages per session via chunked `UNION ALL`
/// indexed top-N seeks so SQLite never scans a full session's message history.
async fn fetch_latest_messages_batch(
    pool: &SqlitePool,
    session_ids: &[i64],
    msg_limit: i64,
) -> Result<LatestBatchResult, AppError> {
    let fetch_limit = msg_limit.saturating_add(1);
    let branch = format!(
        "SELECT * FROM ({MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?)"
    );
    let mut by_session: HashMap<i64, Vec<AgentMessageRow>> = HashMap::new();

    for chunk in session_ids.chunks(COMPOUND_BRANCH_CHUNK_SIZE) {
        let sql = std::iter::repeat_n(branch.as_str(), chunk.len())
            .collect::<Vec<_>>()
            .join(" UNION ALL ");
        let mut query = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(sql));
        for sid in chunk {
            query = query.bind(sid).bind(fetch_limit);
        }
        for row in query.fetch_all(pool).await? {
            by_session.entry(row.session_id).or_default().push(row);
        }
    }

    let mut has_more_map = HashMap::with_capacity(session_ids.len());
    let mut oldest_message_id_map = HashMap::new();
    for &sid in session_ids {
        let mut rows = by_session.remove(&sid).unwrap_or_default();
        rows.sort_unstable_by_key(|row| std::cmp::Reverse(row.id));
        let has_more = rows.len() as i64 > msg_limit;
        if has_more {
            rows.truncate(msg_limit as usize);
        }
        rows.reverse();
        if let Some(oldest) = rows.first().map(|message| message.id) {
            oldest_message_id_map.insert(sid, oldest);
        }
        has_more_map.insert(sid, has_more);
        by_session.insert(sid, rows);
    }
    Ok((by_session, has_more_map, oldest_message_id_map))
}

async fn fetch_initial_user_anchors_batch(
    pool: &SqlitePool,
    session_ids: &[i64],
) -> Result<Vec<AgentMessageRow>, AppError> {
    let branch = format!(
        "SELECT * FROM ({MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? AND message_type = ? ORDER BY id ASC LIMIT 1)"
    );
    let mut anchors = Vec::new();
    for chunk in session_ids.chunks(COMPOUND_BRANCH_CHUNK_SIZE) {
        let sql = std::iter::repeat_n(branch.as_str(), chunk.len())
            .collect::<Vec<_>>()
            .join(" UNION ALL ");
        let mut query = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(sql));
        for sid in chunk {
            query = query.bind(sid).bind(USER_MESSAGE_TYPE);
        }
        anchors.extend(query.fetch_all(pool).await?);
    }
    Ok(anchors)
}

#[cfg(test)]
mod tests {
    use super::super::feature_state::get_feature_agent_state;
    use super::super::test_support::{
        insert_feature, insert_message, insert_session, setup_test_db,
    };
    use super::*;

    async fn add_origin(pool: &SqlitePool, message_id: i64, source_session_id: i64) {
        sqlx::query(
            "INSERT INTO agent_message_origins (message_id, origin_kind, source_session_id, note) \
             VALUES (?, 'session_generated', ?, 'delegated')",
        )
        .bind(message_id)
        .bind(source_session_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Anchor, origins, an out-of-page `TodoWrite` and a sub-agent whose
    /// carrier falls out of the window while its children stay in it.
    async fn seed_anchor_session(pool: &SqlitePool, feature_id: i64) -> i64 {
        let sid = insert_session(pool, feature_id, "completed").await;
        let prompt = insert_message(pool, sid, "user_message", "first", None, None, None).await;
        add_origin(pool, prompt, 99).await;
        let todos = r#"{"todos":[{"content":"ship","status":"in_progress","activeForm":"s"}]}"#;
        insert_message(
            pool,
            sid,
            "tool_call",
            todos,
            Some("TodoWrite"),
            Some("tw-1"),
            None,
        )
        .await;
        insert_message(
            pool,
            sid,
            "tool_call",
            "{}",
            Some("Task"),
            Some("task-1"),
            None,
        )
        .await;
        for i in 0..4 {
            insert_message(pool, sid, "text", &format!("chatter {i}"), None, None, None).await;
        }
        let child = Some("task-1");
        insert_message(
            pool,
            sid,
            "tool_call",
            "{}",
            Some("Bash"),
            Some("b-1"),
            child,
        )
        .await;
        insert_message(pool, sid, "text", "nested", None, None, child).await;
        let reply = insert_message(pool, sid, "user_message", "again", None, None, None).await;
        add_origin(pool, reply, 98).await;
        insert_message(pool, sid, "tool_result", "done", None, Some("b-1"), child).await;
        sid
    }

    async fn seed_task_session(pool: &SqlitePool, feature_id: i64) -> i64 {
        let sid = insert_session(pool, feature_id, "running").await;
        insert_message(pool, sid, "text", "no prompt yet", None, None, None).await;
        let create = r#"{"subject":"write tests","activeForm":"writing"}"#;
        insert_message(
            pool,
            sid,
            "tool_call",
            create,
            Some("TaskCreate"),
            Some("c-1"),
            None,
        )
        .await;
        insert_message(
            pool,
            sid,
            "tool_result",
            r#"{"id":"t-1"}"#,
            None,
            Some("c-1"),
            None,
        )
        .await;
        for i in 0..3 {
            insert_message(pool, sid, "text", &format!("work {i}"), None, None, None).await;
        }
        let update = r#"{"taskId":"t-1","status":"completed"}"#;
        insert_message(
            pool,
            sid,
            "tool_call",
            update,
            Some("TaskUpdate"),
            Some("u-1"),
            None,
        )
        .await;
        sid
    }

    #[tokio::test]
    async fn batch_matches_feature_agent_state_for_every_session_shape() {
        let pool = setup_test_db().await;
        let first = insert_feature(&pool).await;
        let second = insert_feature(&pool).await;
        let anchored = seed_anchor_session(&pool, first).await;
        let tasks = seed_task_session(&pool, first).await;
        let empty = insert_session(&pool, second, "idle").await;
        let short = insert_session(&pool, second, "completed").await;
        let short_prompt =
            insert_message(&pool, short, "user_message", "hi", None, None, None).await;
        add_origin(&pool, short_prompt, anchored).await;
        insert_message(&pool, short, "text", "hello", None, None, None).await;
        let sessions = [
            (anchored, first),
            (tasks, first),
            (empty, second),
            (short, second),
        ];
        let ids: Vec<i64> = sessions.iter().map(|(sid, _)| *sid).collect();

        for limit in [1, 2, 3, 5, 50] {
            let batch = get_sessions_agent_state_batch(&pool, &ids, limit)
                .await
                .unwrap();
            assert_eq!(batch.len(), sessions.len(), "limit {limit}");
            for (sid, feature_id) in sessions {
                let expected =
                    get_feature_agent_state(&pool, feature_id, None, None, Some(limit), None)
                        .await
                        .unwrap()
                        .sessions
                        .into_iter()
                        .find(|state| state.session_db_id == sid)
                        .unwrap();
                assert_eq!(
                    serde_json::to_value(&batch[&sid]).unwrap(),
                    serde_json::to_value(&expected).unwrap(),
                    "session {sid} diverged at limit {limit}"
                );
            }
        }

        // The shapes the comparison is meant to cover actually occurred.
        let small = get_sessions_agent_state_batch(&pool, &ids, 3)
            .await
            .unwrap();
        let anchored_state = &small[&anchored];
        assert!(anchored_state.has_more);
        assert_eq!(
            anchored_state.blocks[0].content, "first",
            "anchor prepended"
        );
        assert!(anchored_state.blocks[0].origin.is_some(), "anchor origin");
        assert!(
            anchored_state
                .blocks
                .iter()
                .any(|block| block.tool_name.as_deref() == Some("Task")),
            "out-of-page sub-agent carrier injected"
        );
        assert_eq!(anchored_state.todos.as_ref().map(Vec::len), Some(1));
        assert_eq!(small[&tasks].todos.as_ref().map(Vec::len), Some(1));
        assert!(small[&tasks].has_more);
        assert!(small[&empty].blocks.is_empty() && !small[&empty].has_more);
        assert!(!small[&short].has_more);
    }

    #[tokio::test]
    async fn unknown_and_duplicate_ids_are_ignored() {
        let pool = setup_test_db().await;
        let feature = insert_feature(&pool).await;
        let sid = seed_task_session(&pool, feature).await;

        let states = get_sessions_agent_state_batch(&pool, &[sid, 4242, sid], 2)
            .await
            .unwrap();

        assert_eq!(states.keys().copied().collect::<Vec<_>>(), vec![sid]);
    }
}
