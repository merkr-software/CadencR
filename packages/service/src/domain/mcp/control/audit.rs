use crate::error::AppError;

pub(super) struct ToolAudit<'a> {
    pub server_name: &'a str,
    pub tool_name: &'a str,
    pub source_session_id: Option<i64>,
    pub source_feature_id: Option<i64>,
    pub source_project_id: Option<i64>,
    pub target_session_id: Option<i64>,
    pub target_feature_id: Option<i64>,
    pub target_project_id: Option<i64>,
    pub status: &'a str,
    pub result_size_bytes: i64,
    pub latency_ms: i64,
    pub error: Option<&'a str>,
}

pub(super) async fn record_tool_audit(
    pool: &sqlx::SqlitePool,
    event: ToolAudit<'_>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO mcp_tool_audit_log
         (server_name, tool_name, source_session_id, source_feature_id, source_project_id,
          target_session_id, target_feature_id, target_project_id, status, result_size_bytes,
          latency_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(event.server_name)
    .bind(event.tool_name)
    .bind(event.source_session_id)
    .bind(event.source_feature_id)
    .bind(event.source_project_id)
    .bind(event.target_session_id)
    .bind(event.target_feature_id)
    .bind(event.target_project_id)
    .bind(event.status)
    .bind(event.result_size_bytes)
    .bind(event.latency_ms)
    .bind(event.error)
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) fn elapsed_ms(started_at: std::time::Instant) -> i64 {
    i64::try_from(started_at.elapsed().as_millis()).unwrap_or(i64::MAX)
}

pub(super) fn result_size_bytes<T: serde::Serialize>(value: &T) -> i64 {
    serde_json::to_vec(value)
        .map(|bytes| i64::try_from(bytes.len()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
