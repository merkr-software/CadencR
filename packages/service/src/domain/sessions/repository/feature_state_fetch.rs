//! SQL helpers for `get_feature_agent_state`. Extracted from the orchestrator
//! to keep `feature_state.rs` under the 400-line cap.
//!
//! These helpers are intentionally side-effect-free except for the database
//! reads — they hand back plain maps that the orchestrator weaves into the
//! per-session response.

use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::HashMap;

use super::super::models::*;
use super::pagination::fetch_missing_parents;
use super::task_todos::latest_todos_from_messages;
use super::MESSAGE_SELECT;
use crate::error::AppError;

const USER_MESSAGE_TYPE: &str = "user_message";

pub(super) struct FullMessagesResult {
    pub messages: HashMap<i64, Vec<AgentMessageRow>>,
    pub has_more: HashMap<i64, bool>,
    pub oldest_message_id: HashMap<i64, i64>,
}

struct MessagePage {
    rows: Vec<AgentMessageRow>,
    has_more: bool,
    oldest_cursor_id: Option<i64>,
}

/// Fetch messages for sessions that need a full (re)hydration. Limited fetches
/// use per-session indexed queries so SQLite can stop after `limit + 1` rows;
/// unbounded legacy fetches keep the original batch IN-query.
pub(super) async fn fetch_full_messages(
    pool: &SqlitePool,
    session_ids: &[i64],
    limit: Option<i64>,
    before_map: &HashMap<i64, i64>,
) -> Result<FullMessagesResult, AppError> {
    if session_ids.is_empty() {
        return Ok(empty_full_messages_result());
    }

    if !before_map.is_empty() || limit.is_some() {
        return fetch_before_or_latest_per_session(pool, session_ids, limit, before_map).await;
    }

    fetch_unbounded_batch(pool, session_ids).await
}

fn empty_full_messages_result() -> FullMessagesResult {
    FullMessagesResult {
        messages: HashMap::new(),
        has_more: HashMap::new(),
        oldest_message_id: HashMap::new(),
    }
}

async fn fetch_before_or_latest_per_session(
    pool: &SqlitePool,
    session_ids: &[i64],
    limit: Option<i64>,
    before_map: &HashMap<i64, i64>,
) -> Result<FullMessagesResult, AppError> {
    let mut result = empty_full_messages_result();
    let with_before_sql = format!(
        "{MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
    );
    let latest_sql = format!(
        "{MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
    );
    let msg_limit = limit.unwrap_or(i64::MAX - 1).max(1);
    for sid in session_ids {
        let mut q = if let Some(&before_id) = before_map.get(sid) {
            sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(with_before_sql.as_str()))
                .bind(sid)
                .bind(before_id)
        } else {
            sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(latest_sql.as_str())).bind(sid)
        };
        q = q.bind(msg_limit.saturating_add(1));
        let mut rows = q.fetch_all(pool).await?;
        let has_more = rows.len() as i64 > msg_limit;
        if has_more {
            rows.truncate(msg_limit as usize);
        }
        rows.reverse();
        let oldest_cursor_id = rows.first().map(|message| message.id);
        let mut page = MessagePage {
            rows,
            has_more,
            oldest_cursor_id,
        };
        if page.has_more && !before_map.contains_key(sid) {
            if let Some(anchor) =
                fetch_initial_user_anchor_before(pool, *sid, page.oldest_cursor_id).await?
            {
                page.rows.insert(0, anchor);
            }
        }
        finish_paginated_session(pool, &mut result, *sid, page).await?;
    }
    Ok(result)
}

async fn fetch_initial_user_anchor_before(
    pool: &SqlitePool,
    session_id: i64,
    before_id: Option<i64>,
) -> Result<Option<AgentMessageRow>, AppError> {
    let Some(before_id) = before_id else {
        return Ok(None);
    };
    let anchor = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(format!(
        "{MESSAGE_SELECT} FROM agent_messages
         WHERE session_id = ? AND message_type = ?
         ORDER BY id ASC LIMIT 1"
    )))
    .bind(session_id)
    .bind(USER_MESSAGE_TYPE)
    .fetch_optional(pool)
    .await?;
    Ok(anchor.filter(|message| message.id < before_id))
}

async fn finish_paginated_session(
    pool: &SqlitePool,
    result: &mut FullMessagesResult,
    session_id: i64,
    page: MessagePage,
) -> Result<(), AppError> {
    let MessagePage {
        mut rows,
        has_more,
        oldest_cursor_id,
    } = page;
    if let Some(oldest) = oldest_cursor_id {
        result.oldest_message_id.insert(session_id, oldest);
    }
    let parent_msgs = fetch_missing_parents(pool, session_id, &rows).await?;
    if !parent_msgs.is_empty() {
        let mut merged = parent_msgs;
        merged.append(&mut rows);
        rows = merged;
    }
    result.has_more.insert(session_id, has_more);
    result.messages.insert(session_id, rows);
    Ok(())
}

async fn fetch_unbounded_batch(
    pool: &SqlitePool,
    session_ids: &[i64],
) -> Result<FullMessagesResult, AppError> {
    let placeholders = session_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "{MESSAGE_SELECT} FROM agent_messages WHERE session_id IN ({placeholders}) ORDER BY id ASC"
    );
    let mut query = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(sql));
    for sid in session_ids {
        query = query.bind(sid);
    }
    let rows = query.fetch_all(pool).await?;
    let mut result = empty_full_messages_result();
    for row in rows {
        result.messages.entry(row.session_id).or_default().push(row);
    }
    Ok(result)
}

pub(super) struct IncrementalData {
    pub messages: HashMap<i64, Vec<AgentMessageRow>>,
    pub updated_tool_calls: HashMap<i64, HashMap<i64, String>>,
}

pub(super) fn todo_fetch_session_ids(
    full_fetch_ids: &[i64],
    include_full_fetches: bool,
    incremental_messages: &HashMap<i64, Vec<AgentMessageRow>>,
    updated_tool_calls: &HashMap<i64, HashMap<i64, String>>,
) -> Vec<i64> {
    let mut ids = if include_full_fetches {
        full_fetch_ids.to_vec()
    } else {
        Vec::new()
    };
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
        let msgs = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(format!(
            "{MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? AND id > ? ORDER BY id ASC"
        )))
        .bind(sid)
        .bind(after_id)
        .fetch_all(pool)
        .await?;
        messages.insert(*sid, msgs);

        // Re-fetch stale tool_call rows
        let stale = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(format!(
            "{MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? AND id <= ? AND message_type = 'tool_call' AND content != '{{}}' ORDER BY id ASC"
        )))
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

    let target_values = session_ids
        .iter()
        .map(|_| "(?)")
        .collect::<Vec<_>>()
        .join(",");
    let message_select_m = "SELECT m.id AS id, m.session_id AS session_id, m.content AS content, m.message_type AS message_type, m.tool_name AS tool_name, m.tool_use_id AS tool_use_id, m.parent_tool_use_id AS parent_tool_use_id, m.created_at AS created_at, m.model AS model";
    let sql = format!(
        "WITH target_sessions(session_id) AS (VALUES {target_values}), \
         task_create_ids AS ( \
            SELECT DISTINCT m.session_id, m.tool_use_id FROM agent_messages m \
            JOIN target_sessions t ON t.session_id = m.session_id \
            WHERE m.message_type = 'tool_call' \
              AND m.tool_name = 'TaskCreate' \
              AND m.tool_use_id IS NOT NULL \
         ) \
         {message_select_m} FROM agent_messages m \
         JOIN target_sessions t ON t.session_id = m.session_id \
         WHERE m.message_type = 'tool_call' \
           AND m.tool_name IN ('TodoWrite', 'TaskCreate', 'TaskUpdate') \
         UNION ALL \
         {message_select_m} FROM agent_messages m \
         JOIN task_create_ids tci \
           ON tci.session_id = m.session_id \
          AND tci.tool_use_id = m.tool_use_id \
         WHERE m.message_type IN ('tool_result', 'tool_error') \
         ORDER BY session_id ASC, id ASC"
    );
    let mut query = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(sql));
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
    use std::collections::HashMap;

    use serde_json::json;

    use super::super::test_support::{insert_message, insert_session, setup_test_db};
    use super::{fetch_latest_todos, todo_fetch_session_ids};

    #[test]
    fn todo_fetch_session_ids_skips_full_fetches_for_before_pagination() {
        let ids = todo_fetch_session_ids(&[1, 2], false, &HashMap::new(), &HashMap::new());

        assert!(ids.is_empty());
    }

    #[test]
    fn todo_fetch_session_ids_keeps_initial_limited_fetches() {
        let ids = todo_fetch_session_ids(&[2, 1], true, &HashMap::new(), &HashMap::new());

        assert_eq!(ids, vec![1, 2]);
    }

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
