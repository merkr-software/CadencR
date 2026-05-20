//! SQL helpers for `get_feature_agent_state`. Extracted from the orchestrator
//! to keep `feature_state.rs` under the 400-line cap.
//!
//! These helpers are intentionally side-effect-free except for the database
//! reads — they hand back plain maps that the orchestrator weaves into the
//! per-session response.

use sqlx::SqlitePool;
use std::collections::HashMap;

use super::super::models::*;
use super::pagination::fetch_missing_parents;
use super::task_todos::latest_todos_from_messages;
use super::MESSAGE_SELECT;
use crate::error::AppError;

pub(super) struct FullMessagesResult {
    pub messages: HashMap<i64, Vec<AgentMessageRow>>,
    pub has_more: HashMap<i64, bool>,
    pub oldest_message_id: HashMap<i64, i64>,
}

/// Fetch messages for sessions that need a full (re)hydration. Picks
/// per-session paginated SQL when `limit` or `before_map` is set, else falls
/// back to an unbounded batch IN-query for the original fast path.
pub(super) async fn fetch_full_messages(
    pool: &SqlitePool,
    session_ids: &[i64],
    limit: Option<i64>,
    before_map: &HashMap<i64, i64>,
) -> Result<FullMessagesResult, AppError> {
    let mut messages: HashMap<i64, Vec<AgentMessageRow>> = HashMap::new();
    let mut has_more: HashMap<i64, bool> = HashMap::new();
    let mut oldest_message_id: HashMap<i64, i64> = HashMap::new();

    if session_ids.is_empty() {
        return Ok(FullMessagesResult {
            messages,
            has_more,
            oldest_message_id,
        });
    }

    if limit.is_some() || !before_map.is_empty() {
        // Built once per call (not per session) and only on the paginated
        // path — the unbounded branch below issues its own batch IN-query.
        let paginated_with_before_sql = format!(
            "{MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
        );
        let paginated_sql = format!(
            "{MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
        );
        let msg_limit = limit.unwrap_or(i64::MAX);
        for sid in session_ids {
            let mut q = if let Some(&before_id) = before_map.get(sid) {
                sqlx::query_as::<_, AgentMessageRow>(&paginated_with_before_sql)
                    .bind(sid)
                    .bind(before_id)
            } else {
                sqlx::query_as::<_, AgentMessageRow>(&paginated_sql).bind(sid)
            };
            // Fetch limit+1 to detect has_more
            q = q.bind(msg_limit + 1);
            let mut msgs = q.fetch_all(pool).await?;
            let session_has_more = msgs.len() as i64 > msg_limit;
            if session_has_more {
                msgs.truncate(msg_limit as usize);
            }
            // Reverse to restore ASC order for block building
            msgs.reverse();
            if let Some(oldest) = msgs.first().map(|m| m.id) {
                oldest_message_id.insert(*sid, oldest);
            }

            // Fetch parent Agent/Task tool_call rows referenced by children
            // in this page but not already present, so build_blocks can nest them.
            let parent_msgs = fetch_missing_parents(pool, *sid, &msgs).await?;
            if !parent_msgs.is_empty() {
                // Merge parents at the front (they have lower IDs)
                let mut merged = parent_msgs;
                merged.append(&mut msgs);
                msgs = merged;
            }

            has_more.insert(*sid, session_has_more);
            messages.insert(*sid, msgs);
        }
    } else {
        // Unbounded batch fetch (no limit) — original fast path
        let placeholders = session_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "{MESSAGE_SELECT} FROM agent_messages WHERE session_id IN ({placeholders}) ORDER BY id ASC"
        );
        let mut q = sqlx::query_as::<_, AgentMessageRow>(&sql);
        for sid in session_ids {
            q = q.bind(sid);
        }
        let msgs = q.fetch_all(pool).await?;
        for msg in msgs {
            messages.entry(msg.session_id).or_default().push(msg);
        }
    }

    Ok(FullMessagesResult {
        messages,
        has_more,
        oldest_message_id,
    })
}

pub(super) struct IncrementalData {
    pub messages: HashMap<i64, Vec<AgentMessageRow>>,
    pub updated_tool_calls: HashMap<i64, HashMap<i64, String>>,
}

pub(super) fn todo_fetch_session_ids(
    full_fetch_ids: &[i64],
    incremental_messages: &HashMap<i64, Vec<AgentMessageRow>>,
    updated_tool_calls: &HashMap<i64, HashMap<i64, String>>,
) -> Vec<i64> {
    let mut ids = full_fetch_ids.to_vec();
    for (session_id, messages) in incremental_messages {
        if messages.iter().any(is_todo_source_message)
            || updated_tool_calls.contains_key(session_id)
        {
            ids.push(*session_id);
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

pub(super) fn todos_from_full_messages(
    messages: &HashMap<i64, Vec<AgentMessageRow>>,
) -> HashMap<i64, Vec<serde_json::Value>> {
    messages
        .iter()
        .filter_map(|(session_id, rows)| {
            latest_todos_from_messages(rows).map(|todos| (*session_id, todos))
        })
        .collect()
}

fn is_todo_source_message(message: &AgentMessageRow) -> bool {
    matches!(
        (message.message_type.as_str(), message.tool_name.as_deref()),
        ("tool_call", Some("TodoWrite" | "TaskCreate" | "TaskUpdate"))
            | ("tool_result" | "tool_error", _)
    )
}

/// Fetch the new messages produced since `after_id` for each incremental
/// session, plus any stale tool_call rows whose content may have grown.
pub(super) async fn fetch_incremental_data(
    pool: &SqlitePool,
    fetches: &[(i64, i64)],
) -> Result<IncrementalData, AppError> {
    let mut messages: HashMap<i64, Vec<AgentMessageRow>> = HashMap::new();
    let mut updated_tool_calls: HashMap<i64, HashMap<i64, String>> = HashMap::new();

    for (sid, after_id) in fetches {
        let msgs = sqlx::query_as::<_, AgentMessageRow>(&format!(
            "{MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? AND id > ? ORDER BY id ASC"
        ))
        .bind(sid)
        .bind(after_id)
        .fetch_all(pool)
        .await?;
        messages.insert(*sid, msgs);

        // Re-fetch stale tool_call rows
        let stale = sqlx::query_as::<_, AgentMessageRow>(&format!(
            "{MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? AND id <= ? AND message_type = 'tool_call' AND content != '{{}}' ORDER BY id ASC"
        ))
        .bind(sid)
        .bind(after_id)
        .fetch_all(pool)
        .await?;
        if !stale.is_empty() {
            let map: HashMap<i64, String> = stale.into_iter().map(|r| (r.id, r.content)).collect();
            updated_tool_calls.insert(*sid, map);
        }
    }

    Ok(IncrementalData {
        messages,
        updated_tool_calls,
    })
}

/// Fetch latest todo state for each session from `TodoWrite` snapshots or
/// Claude Code task tool deltas.
pub(super) async fn fetch_latest_todos(
    pool: &SqlitePool,
    session_ids: &[i64],
) -> Result<HashMap<i64, Vec<serde_json::Value>>, AppError> {
    let mut todos_by_session: HashMap<i64, Vec<serde_json::Value>> = HashMap::new();
    if session_ids.is_empty() {
        return Ok(todos_by_session);
    }

    let placeholders = session_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "WITH task_create_ids AS ( \
            SELECT session_id, tool_use_id FROM agent_messages \
            WHERE session_id IN ({placeholders}) \
              AND message_type = 'tool_call' \
              AND tool_name = 'TaskCreate' \
              AND tool_use_id IS NOT NULL \
         ) \
         {MESSAGE_SELECT} FROM agent_messages \
         WHERE session_id IN ({placeholders}) AND ( \
           (message_type = 'tool_call' AND tool_name IN ('TodoWrite', 'TaskCreate', 'TaskUpdate')) \
           OR (message_type IN ('tool_result', 'tool_error') AND EXISTS ( \
                SELECT 1 FROM task_create_ids \
                WHERE task_create_ids.session_id = agent_messages.session_id \
                  AND task_create_ids.tool_use_id = agent_messages.tool_use_id \
           )) \
         ) \
         ORDER BY session_id ASC, id ASC"
    );
    let mut query = sqlx::query_as::<_, AgentMessageRow>(&sql);
    for sid in session_ids {
        query = query.bind(sid);
    }
    for sid in session_ids {
        query = query.bind(sid);
    }
    let rows = query.fetch_all(pool).await?;
    let mut rows_by_session: HashMap<i64, Vec<AgentMessageRow>> = HashMap::new();
    for row in rows {
        rows_by_session.entry(row.session_id).or_default().push(row);
    }
    for (session_id, rows) in rows_by_session {
        if let Some(todos) = latest_todos_from_messages(&rows) {
            todos_by_session.insert(session_id, todos);
        }
    }
    Ok(todos_by_session)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_support::{insert_message, insert_session, setup_test_db};
    use super::fetch_latest_todos;

    #[tokio::test]
    async fn fetch_latest_todos_reconstructs_persisted_task_tools() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 1, "running").await;

        insert_message(
            &pool,
            session_id,
            "tool_call",
            r#"{"subject":"Write replay tests","activeForm":"Writing replay tests"}"#,
            Some("TaskCreate"),
            Some("create-1"),
            None,
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "tool_result",
            r#"{"id":"task-1"}"#,
            None,
            Some("create-1"),
            None,
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "tool_call",
            r#"{"taskId":"task-1","status":"completed","activeForm":"Finishing replay tests"}"#,
            Some("TaskUpdate"),
            Some("update-1"),
            None,
        )
        .await;

        let todos = fetch_latest_todos(&pool, &[session_id]).await.unwrap();

        assert_eq!(
            todos.get(&session_id),
            Some(&vec![json!({
                "content": "Write replay tests",
                "status": "completed",
                "activeForm": "Finishing replay tests"
            })])
        );
    }
}
