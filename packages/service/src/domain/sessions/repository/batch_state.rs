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
use super::feature_state_fetch::fetch_latest_todos;
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
