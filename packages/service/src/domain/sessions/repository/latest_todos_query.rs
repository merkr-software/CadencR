use super::MESSAGE_SELECT;

/// The tool calls that write a todo list, as an SQL `IN` list.
pub(super) const TODO_TOOL_NAMES_SQL: &str = "('TodoWrite', 'TaskCreate', 'TaskUpdate')";

pub(super) fn latest_todos_sql(session_count: usize) -> String {
    let target_values = std::iter::repeat_n("(?)", session_count)
        .collect::<Vec<_>>()
        .join(",");
    let message_select_m = aliased_message_select("m");
    format!(
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
           AND m.tool_name IN {TODO_TOOL_NAMES_SQL} \
         UNION ALL \
         {message_select_m} FROM task_create_ids tci \
         CROSS JOIN agent_messages m \
         WHERE tci.session_id = m.session_id \
           AND tci.tool_use_id = m.tool_use_id \
           AND m.message_type IN ('tool_result', 'tool_error') \
         ORDER BY 2 ASC, 1 ASC"
    )
}

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
        let explain_sql = format!("EXPLAIN QUERY PLAN {}", super::latest_todos_sql(1));

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
            details.contains("SEARCH m USING INDEX idx_agent_messages_session_tool_use"),
            "{details}"
        );
        assert!(
            !details.lines().any(|detail| detail.contains("SCAN m")),
            "{details}"
        );
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
