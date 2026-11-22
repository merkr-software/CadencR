//! SQL helpers for `get_feature_agent_state`. Extracted from the orchestrator
//! to keep `feature_state.rs` under the 400-line cap.
//!
//! These helpers are intentionally side-effect-free except for the database
//! reads — they hand back plain maps that the orchestrator weaves into the
//! per-session response.

use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::HashMap;

use super::super::models::*;
use super::latest_todos_query::latest_todos_sql;
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
    // The anchor and missing-parent rows are fetched out-of-band and land
    // ahead of the page window; blocks must be emitted in ascending id order
    // or the transcript renders scrambled (user prompt after its own turn).
    // `id` is a unique PK, so an unstable sort is both correct and cheaper.
    rows.sort_unstable_by_key(|message| message.id);
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

const TODO_SESSION_CHUNK_SIZE: usize = 200;

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

    let mut rows_by_session: HashMap<i64, Vec<AgentMessageRow>> = HashMap::new();
    for chunk in session_ids.chunks(TODO_SESSION_CHUNK_SIZE) {
        let sql = latest_todos_sql(chunk.len());
        let mut query = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(sql));
        for sid in chunk {
            query = query.bind(sid);
        }
        for row in query.fetch_all(pool).await? {
            rows_by_session.entry(row.session_id).or_default().push(row);
        }
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
    use super::{fetch_full_messages, fetch_latest_todos, todo_fetch_session_ids};

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
    async fn limited_fetch_keeps_rows_in_ascending_id_order() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 1, "running").await;

        // First user prompt (becomes the out-of-band anchor once the limited
        // window excludes it) plus a dangling tool_call whose result lands
        // inside the window (fetched as a missing parent).
        insert_message(
            &pool,
            session_id,
            "user_message",
            "first prompt",
            None,
            None,
            None,
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "tool_call",
            "{}",
            Some("Bash"),
            Some("tu-1"),
            None,
        )
        .await;
        for i in 0..6 {
            let content = format!("t{i}");
            insert_message(&pool, session_id, "text", &content, None, None, None).await;
        }
        insert_message(
            &pool,
            session_id,
            "tool_result",
            "done",
            None,
            Some("tu-1"),
            None,
        )
        .await;

        let result = fetch_full_messages(&pool, &[session_id], Some(3), &HashMap::new())
            .await
            .unwrap();

        let rows = result.messages.get(&session_id).unwrap();
        let ids: Vec<i64> = rows.iter().map(|m| m.id).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        assert_eq!(ids, sorted, "rows must be in ascending id order");
        assert_eq!(
            rows.first().map(|m| m.message_type.as_str()),
            Some("user_message"),
            "the anchor user prompt must come first"
        );
        assert!(result.has_more.get(&session_id).copied().unwrap_or(false));
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
