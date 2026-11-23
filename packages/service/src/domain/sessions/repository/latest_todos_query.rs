use super::MESSAGE_SELECT;

/// The tool calls that write a todo list, as an SQL `IN` list.
pub(super) const TODO_TOOL_NAMES_SQL: &str = "('TodoWrite', 'TaskCreate', 'TaskUpdate')";

/// Partial index over exactly the [`TODO_TOOL_NAMES_SQL`] tool calls. Queries
/// name it with `INDEXED BY`: under other statistics (a real `ANALYZE`, another
/// SQLite release) the planner can prefer the plain `(session_id, id DESC)`
/// index and walk every message of a long session to find its last todo call.
/// The index is created by migration and re-created by
/// `repair_agent_messages_perf_indexes`.
pub(super) const TODO_TOOLS_INDEX: &str = "idx_agent_messages_session_todo_tools";

/// Which todo tool calls [`todo_rows_sql`] returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TodoRows {
    /// Every `TodoWrite` snapshot and task tool call.
    All,
    /// Only `TaskCreate` / `TaskUpdate`, enough to replay a task list.
    TasksOnly,
}

fn target_sessions_cte(session_count: usize) -> String {
    let target_values = std::iter::repeat_n("(?)", session_count)
        .collect::<Vec<_>>()
        .join(",");
    format!("WITH target_sessions(session_id) AS (VALUES {target_values})")
}

/// The last todo tool call of each target session, one row per session that
/// has one: the row that decides whether the list is a `TodoWrite` snapshot or
/// a task replay.
pub(super) fn latest_todo_heads_sql(session_count: usize) -> String {
    let message_select_m = aliased_message_select("m");
    format!(
        "{} \
         {message_select_m} FROM target_sessions t \
         JOIN agent_messages m ON m.id = ( \
            SELECT h.id FROM agent_messages h INDEXED BY {TODO_TOOLS_INDEX} \
            WHERE h.session_id = t.session_id \
              AND h.message_type = 'tool_call' \
              AND h.tool_name IN {TODO_TOOL_NAMES_SQL} \
            ORDER BY h.id DESC LIMIT 1)",
        target_sessions_cte(session_count)
    )
}

/// Todo tool calls of the target sessions, plus the results of their
/// `TaskCreate` calls (which carry the authoritative task id), oldest first.
pub(super) fn todo_rows_sql(session_count: usize, rows: TodoRows) -> String {
    let message_select_m = aliased_message_select("m");
    let tasks_only = match rows {
        TodoRows::All => "",
        TodoRows::TasksOnly => "AND m.tool_name <> 'TodoWrite'",
    };
    format!(
        "{}, \
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
           AND m.tool_name IN {TODO_TOOL_NAMES_SQL} {tasks_only} \
         UNION ALL \
         {message_select_m} FROM task_create_ids tci \
         CROSS JOIN agent_messages m \
         WHERE tci.session_id = m.session_id \
           AND tci.tool_use_id = m.tool_use_id \
           AND m.message_type IN ('tool_result', 'tool_error') \
         ORDER BY 2 ASC, 1 ASC",
        target_sessions_cte(session_count)
    )
}

/// `ANALYZE` statistics under which the plain `(session_id, id DESC)` index
/// looks cheaper than [`TODO_TOOLS_INDEX`]: todo lookups must keep the partial
/// index anyway.
#[cfg(test)]
pub(super) const PLAIN_INDEX_FAVOURED_STATS: &[(&str, &str)] = &[
    (TODO_TOOLS_INDEX, "1000000 1000000 1"),
    ("idx_agent_messages_session_id_desc", "1000000 2 1"),
];

fn aliased_message_select(alias: &str) -> String {
    MESSAGE_SELECT
        .replacen("SELECT ", &format!("SELECT {alias}."), 1)
        .replace(", ", &format!(", {alias}."))
}

#[cfg(test)]
mod tests {
    use sqlx::AssertSqlSafe;

    use super::super::test_support::setup_test_db;

    #[tokio::test]
    async fn task_result_lookup_uses_session_tool_use_index() {
        let pool = setup_test_db().await;
        create_agent_message_indexes(&pool).await;
        let explain_sql = format!(
            "EXPLAIN QUERY PLAN {}",
            super::todo_rows_sql(1, super::TodoRows::All)
        );

        let plan = sqlx::query_as::<_, (i64, i64, i64, String)>(AssertSqlSafe(explain_sql))
            .bind(1_i64)
            .fetch_all(&pool)
            .await
            .unwrap();
        let details = crate::shared::test_query_plan::plan_details(&plan);

        assert!(
            details.contains("SEARCH m USING INDEX idx_agent_messages_session_tool_use"),
            "{details}"
        );
        crate::shared::test_query_plan::assert_no_full_scan(&details, &["t", "tci"]);
    }

    async fn migrated_plan(sql: String) -> String {
        use crate::shared::test_query_plan::{forge_index_stats, migrated_pool, plan_details};
        let pool = migrated_pool().await;
        forge_index_stats(&pool, "agent_messages", super::PLAIN_INDEX_FAVOURED_STATS).await;
        let explain_sql = format!("EXPLAIN QUERY PLAN {sql}");
        let plan = sqlx::query_as::<_, (i64, i64, i64, String)>(AssertSqlSafe(explain_sql))
            .bind(1_i64)
            .bind(2_i64)
            .fetch_all(&pool)
            .await
            .unwrap();
        plan_details(&plan)
    }

    #[tokio::test]
    async fn latest_todos_uses_indexes_with_zero_table_scan_on_migrated_db() {
        use crate::shared::test_query_plan::assert_no_full_scan;
        for rows in [super::TodoRows::All, super::TodoRows::TasksOnly] {
            let details = migrated_plan(super::todo_rows_sql(2, rows)).await;

            assert!(
                details.contains("idx_agent_messages_session_todo_tools")
                    || details.contains("idx_agent_messages_session_type_tool"),
                "expected todo index seek:\n{details}"
            );
            assert!(
                details.contains("SEARCH m USING INDEX idx_agent_messages_session_tool_use"),
                "expected tool_use index seek:\n{details}"
            );
            assert_no_full_scan(&details, &["t", "tci"]);
        }
    }

    #[tokio::test]
    async fn latest_todo_heads_seek_the_partial_todo_index_once_per_session() {
        use crate::shared::test_query_plan::assert_no_full_scan;
        let details = migrated_plan(super::latest_todo_heads_sql(2)).await;

        assert!(
            details.contains("USING INDEX idx_agent_messages_session_todo_tools (session_id=?)"),
            "expected the partial todo index:\n{details}"
        );
        assert_no_full_scan(&details, &["t"]);
    }

    async fn create_agent_message_indexes(pool: &sqlx::SqlitePool) {
        sqlx::query(
            "CREATE INDEX idx_agent_messages_session_type_tool \
             ON agent_messages(session_id, message_type, tool_name)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE INDEX idx_agent_messages_session_tool_use \
             ON agent_messages(session_id, tool_use_id)",
        )
        .execute(pool)
        .await
        .unwrap();
    }
}
