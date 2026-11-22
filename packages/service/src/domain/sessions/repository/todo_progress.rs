//! How far a conversation's agent has come through its todo list, for the
//! sidebar row ("3/7"). Reads the same `TodoWrite` / task-tool history as the
//! conversation's own todo list, so both always agree.

use sqlx::{AssertSqlSafe, SqlitePool};

use super::super::models::TodoProgress;
use super::feature_state_fetch::fetch_latest_todos;
use super::latest_todos_query::TODO_TOOL_NAMES_SQL;
use crate::error::AppError;

fn latest_todo_session_sql() -> String {
    format!(
        "SELECT session_id FROM ( \
             SELECT s.id AS session_id, \
                    (SELECT m.id FROM agent_messages m \
                     WHERE m.session_id = s.id \
                       AND m.message_type = 'tool_call' \
                       AND m.tool_name IN {TODO_TOOL_NAMES_SQL} \
                     ORDER BY m.id DESC LIMIT 1) AS last_todo_id \
             FROM agent_sessions s \
             WHERE s.feature_id = ? \
         ) \
         WHERE last_todo_id IS NOT NULL \
         ORDER BY last_todo_id DESC LIMIT 1"
    )
}

/// Progress of the todo list the feature's agents touched last, or `None`
/// when none of its sessions ever wrote one.
pub async fn latest_todo_progress(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<TodoProgress>, AppError> {
    // A conversation can hold several sessions; the list that counts is the
    // one written most recently.
    let session_id: Option<i64> = sqlx::query_scalar(AssertSqlSafe(latest_todo_session_sql()))
        .bind(feature_id)
        .fetch_optional(pool)
        .await?;
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let todos = fetch_latest_todos(pool, &[session_id]).await?;
    Ok(todos.get(&session_id).map(|todos| progress_of(todos)))
}

fn progress_of(todos: &[serde_json::Value]) -> TodoProgress {
    let done = todos
        .iter()
        .filter(|todo| todo.get("status").and_then(|status| status.as_str()) == Some("completed"))
        .count();
    TodoProgress {
        done: done as i64,
        total: todos.len() as i64,
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{insert_message, insert_session, setup_test_db};
    use super::*;

    const TWO_OF_THREE: &str = r#"{"todos":[
        {"content":"a","status":"completed","activeForm":"a"},
        {"content":"b","status":"completed","activeForm":"b"},
        {"content":"c","status":"in_progress","activeForm":"c"}]}"#;

    #[tokio::test]
    async fn counts_completed_todos_of_the_latest_list() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 7, "idle").await;
        insert_message(
            &pool,
            session_id,
            "tool_call",
            r#"{"todos":[{"content":"a","status":"pending","activeForm":"a"}]}"#,
            Some("TodoWrite"),
            Some("t-1"),
            None,
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "tool_call",
            TWO_OF_THREE,
            Some("TodoWrite"),
            Some("t-2"),
            None,
        )
        .await;

        let progress = latest_todo_progress(&pool, 7).await.unwrap();

        assert_eq!(progress, Some(TodoProgress { done: 2, total: 3 }));
    }

    #[tokio::test]
    async fn the_most_recently_written_session_wins() {
        let pool = setup_test_db().await;
        let older = insert_session(&pool, 7, "idle").await;
        let newer = insert_session(&pool, 7, "idle").await;
        insert_message(
            &pool,
            newer,
            "tool_call",
            TWO_OF_THREE,
            Some("TodoWrite"),
            Some("t-1"),
            None,
        )
        .await;
        insert_message(
            &pool,
            older,
            "tool_call",
            r#"{"todos":[{"content":"a","status":"completed","activeForm":"a"}]}"#,
            Some("TodoWrite"),
            Some("t-2"),
            None,
        )
        .await;

        let progress = latest_todo_progress(&pool, 7).await.unwrap();

        assert_eq!(progress, Some(TodoProgress { done: 1, total: 1 }));
    }

    #[tokio::test]
    async fn a_conversation_without_todos_has_no_progress() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 7, "idle").await;
        insert_message(&pool, session_id, "text", "hello", None, None, None).await;

        assert_eq!(latest_todo_progress(&pool, 7).await.unwrap(), None);
    }

    #[tokio::test]
    async fn latest_todo_progress_uses_partial_todo_index_on_migrated_db() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();

        let explain_sql = format!("EXPLAIN QUERY PLAN {}", latest_todo_session_sql());
        let plan = sqlx::query_as::<_, (i64, i64, i64, String)>(AssertSqlSafe(explain_sql))
            .bind(1_i64)
            .fetch_all(&pool)
            .await
            .unwrap();
        let details = plan
            .iter()
            .map(|(_, _, _, detail)| detail.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            details.contains("idx_agent_messages_session_todo_tools"),
            "expected partial index idx_agent_messages_session_todo_tools:\n{details}"
        );
        assert!(
            !details
                .lines()
                .any(|line| line.contains("SCAN agent_messages")),
            "unexpected full scan of agent_messages:\n{details}"
        );
    }
}
