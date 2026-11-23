//! Latest todo list per session, from `TodoWrite` snapshots or Claude Code
//! task tool deltas.
//!
//! The list comes from the session's last todo tool call that yields one (see
//! [`latest_todos_from_messages`]):
//! - a `TodoWrite` snapshot replaces everything before it, so when the last
//!   todo call is a readable snapshot that single row is the answer;
//! - a `TaskCreate` / `TaskUpdate` replays every task call of the session
//!   (snapshots play no part in it), so only task rows are loaded.
//!
//! Only an unreadable last snapshot, where the answer falls back to an older
//! call, reloads the whole todo history. A session that writes a todo list on
//! every step therefore costs one indexed row instead of its full history.

use std::collections::HashMap;

use sqlx::{AssertSqlSafe, SqlitePool};

use super::super::models::AgentMessageRow;
use super::latest_todos_query::{latest_todo_heads_sql, todo_rows_sql, TodoRows};
use super::task_todos::latest_todos_from_messages;
use crate::error::AppError;

const TODO_SESSION_CHUNK_SIZE: usize = 200;

type TodosBySession = HashMap<i64, Vec<serde_json::Value>>;

/// What the last todo call of each session leaves to load.
#[derive(Debug, Default, PartialEq)]
struct HeadPlan {
    resolved: TodosBySession,
    task_replays: Vec<i64>,
    full_history: Vec<i64>,
}

fn plan_from_heads(heads: Vec<AgentMessageRow>) -> HeadPlan {
    let mut plan = HeadPlan::default();
    for head in heads {
        if head.tool_name.as_deref() != Some("TodoWrite") {
            plan.task_replays.push(head.session_id);
            continue;
        }
        match latest_todos_from_messages(std::slice::from_ref(&head)) {
            Some(todos) => {
                plan.resolved.insert(head.session_id, todos);
            }
            None => plan.full_history.push(head.session_id),
        }
    }
    plan
}

/// Fetch latest todo state for each session.
pub(super) async fn fetch_latest_todos(
    pool: &SqlitePool,
    session_ids: &[i64],
) -> Result<TodosBySession, AppError> {
    if session_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let heads = fetch_rows(pool, session_ids, latest_todo_heads_sql).await?;
    let HeadPlan {
        mut resolved,
        task_replays,
        full_history,
    } = plan_from_heads(heads);
    resolved.extend(fetch_todos_from_rows(pool, &task_replays, TodoRows::TasksOnly).await?);
    resolved.extend(fetch_todos_from_rows(pool, &full_history, TodoRows::All).await?);
    Ok(resolved)
}

async fn fetch_todos_from_rows(
    pool: &SqlitePool,
    session_ids: &[i64],
    rows: TodoRows,
) -> Result<TodosBySession, AppError> {
    let mut rows_by_session: HashMap<i64, Vec<AgentMessageRow>> = HashMap::new();
    for row in fetch_rows(pool, session_ids, |count| todo_rows_sql(count, rows)).await? {
        rows_by_session.entry(row.session_id).or_default().push(row);
    }
    Ok(rows_by_session
        .into_iter()
        .filter_map(|(session_id, rows)| {
            latest_todos_from_messages(&rows).map(|todos| (session_id, todos))
        })
        .collect())
}

async fn fetch_rows(
    pool: &SqlitePool,
    session_ids: &[i64],
    sql_for: impl Fn(usize) -> String,
) -> Result<Vec<AgentMessageRow>, AppError> {
    let mut rows = Vec::new();
    for chunk in session_ids.chunks(TODO_SESSION_CHUNK_SIZE) {
        let mut query = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(sql_for(chunk.len())));
        for sid in chunk {
            query = query.bind(sid);
        }
        rows.extend(query.fetch_all(pool).await?);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_support::{
        insert_message, insert_session, make_message_full, setup_test_db,
    };
    use super::*;

    #[tokio::test]
    async fn fetch_latest_todos_reconstructs_persisted_task_tools() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 1, "running").await;
        for (kind, content, tool, tool_use_id) in [
            (
                "tool_call",
                r#"{"subject":"Write replay tests","activeForm":"Writing replay tests"}"#,
                Some("TaskCreate"),
                "create-1",
            ),
            ("tool_result", r#"{"id":"task-1"}"#, None, "create-1"),
            (
                "tool_call",
                r#"{"taskId":"task-1","status":"completed","activeForm":"Finishing replay tests"}"#,
                Some("TaskUpdate"),
                "update-1",
            ),
        ] {
            insert_message(
                &pool,
                session_id,
                kind,
                content,
                tool,
                Some(tool_use_id),
                None,
            )
            .await;
        }

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

    #[test]
    fn a_readable_last_snapshot_needs_no_further_rows() {
        let snapshot = r#"{"todos":[{"content":"a","status":"pending","activeForm":"a"}]}"#;
        let plan = plan_from_heads(vec![
            make_message_full(9, 1, "tool_call", snapshot, Some("TodoWrite"), None, None),
            make_message_full(8, 2, "tool_call", "{}", Some("TaskUpdate"), None, None),
            make_message_full(7, 3, "tool_call", "not json", Some("TodoWrite"), None, None),
        ]);

        assert_eq!(plan.resolved.len(), 1);
        assert_eq!(plan.resolved[&1][0]["content"], "a");
        assert_eq!(plan.task_replays, vec![2]);
        assert_eq!(plan.full_history, vec![3]);
    }

    /// One step of a generated session history.
    async fn step(pool: &SqlitePool, session_id: i64, seed: u64, n: u64) {
        let snapshot = format!(
            r#"{{"todos":[{{"content":"s{n}","status":"{}","activeForm":"f"}}]}}"#,
            if seed.is_multiple_of(2) {
                "completed"
            } else {
                "pending"
            }
        );
        let create_id = format!("c-{session_id}-{}", n.saturating_sub(seed % 3));
        let (kind, content, tool, tool_use_id): (&str, String, Option<&str>, Option<String>) =
            match seed % 9 {
                0 | 1 => ("tool_call", snapshot, Some("TodoWrite"), None),
                2 => (
                    "tool_call",
                    "{\"todos\": 3}".into(),
                    Some("TodoWrite"),
                    None,
                ),
                3 => ("tool_call", "not json".into(), Some("TodoWrite"), None),
                4 => (
                    "tool_call",
                    format!(r#"{{"subject":"t{n}","activeForm":"t"}}"#),
                    Some("TaskCreate"),
                    Some(format!("c-{session_id}-{n}")),
                ),
                5 => (
                    "tool_result",
                    format!(r#"{{"id":"task-{n}"}}"#),
                    None,
                    Some(create_id),
                ),
                6 => (
                    "tool_call",
                    format!(
                        r#"{{"taskId":"task-{}","status":"completed"}}"#,
                        n.saturating_sub(1)
                    ),
                    Some("TaskUpdate"),
                    None,
                ),
                7 => (
                    "tool_call",
                    format!(
                        r#"{{"taskId":"task-{}","status":"deleted"}}"#,
                        n.saturating_sub(2)
                    ),
                    Some("TaskUpdate"),
                    None,
                ),
                _ => ("text", format!("chatter {n}"), None, None),
            };
        insert_message(
            pool,
            session_id,
            kind,
            &content,
            tool,
            tool_use_id.as_deref(),
            None,
        )
        .await;
    }

    #[tokio::test]
    async fn matches_a_full_history_replay_on_generated_sessions() {
        let pool = setup_test_db().await;
        let mut session_ids = Vec::new();
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        // More sessions than one query chunk, so the chunked path runs too.
        for _ in 0..(TODO_SESSION_CHUNK_SIZE + 60) {
            let session_id = insert_session(&pool, 1, "idle").await;
            session_ids.push(session_id);
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            for n in 0..(state >> 60) {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                step(&pool, session_id, state >> 33, n).await;
            }
        }

        // Every branch of the head plan must be exercised.
        let heads = fetch_rows(&pool, &session_ids, latest_todo_heads_sql)
            .await
            .unwrap();
        let plan = plan_from_heads(heads);
        assert!(
            !plan.resolved.is_empty(),
            "no readable last snapshot generated"
        );
        assert!(!plan.task_replays.is_empty(), "no task replay generated");
        assert!(
            !plan.full_history.is_empty(),
            "no unreadable last snapshot generated"
        );

        let optimized = fetch_latest_todos(&pool, &session_ids).await.unwrap();
        let reference = fetch_todos_from_rows(&pool, &session_ids, TodoRows::All)
            .await
            .unwrap();

        assert_eq!(optimized, reference);
        assert!(optimized.len() > 30, "generator must cover todo sessions");
    }
}
