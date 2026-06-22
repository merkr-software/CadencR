use sqlx::{AssertSqlSafe, SqlitePool};
use tracing::warn;

/// Extra WHERE filter for `retry_update_agent_message_content`.
#[allow(dead_code)]
pub enum ToolCallFilter {
    /// Match by `tool_name = ?`  (e.g. "ExitPlanMode")
    ToolName(String),
    /// Match by `message_type = ?`  (e.g. "tool_call")
    MessageType(String),
}

/// Retry-update the `content` column of an `agent_messages` row that may not
/// be inserted yet (race with the stream reader).
///
/// Tries up to 5 times with a 50 ms delay between attempts.
pub async fn retry_update_agent_message_content(
    pool: &SqlitePool,
    session_id: i64,
    tool_use_id: &str,
    content: &str,
    filter: &ToolCallFilter,
) {
    let (extra_clause, bind_value) = match filter {
        ToolCallFilter::ToolName(name) => ("AND tool_name = ?", name.as_str()),
        ToolCallFilter::MessageType(mt) => ("AND message_type = ?", mt.as_str()),
    };

    let sql = format!(
        "UPDATE agent_messages SET content = ? WHERE session_id = ? AND tool_use_id = ? {extra_clause}"
    );

    for attempt in 0..5 {
        let result = sqlx::query(AssertSqlSafe(sql.as_str()))
            .bind(content)
            .bind(session_id)
            .bind(tool_use_id)
            .bind(bind_value)
            .execute(pool)
            .await;
        match result {
            Ok(r) if r.rows_affected() > 0 => return,
            _ if attempt < 4 => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            _ => {
                warn!(
                    session_id,
                    "failed to update agent_messages row after retries"
                );
            }
        }
    }
}
