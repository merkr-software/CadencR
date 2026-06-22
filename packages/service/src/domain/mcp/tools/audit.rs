use std::time::Instant;

use serde_json::Value;

use crate::domain::mcp::context::McpContext;

#[derive(sqlx::FromRow)]
struct TargetScope {
    session_id: i64,
    feature_id: i64,
    project_id: i64,
}

pub async fn record_read_tool_audit(
    server_name: &str,
    tool_name: &str,
    args: &Value,
    ctx: &McpContext,
    result: &Result<Value, String>,
    started_at: Instant,
) -> Result<(), String> {
    let source_project_id = source_project_id(ctx).await?;
    let target = match target_session_id(args) {
        Some(session_id) => target_scope(ctx, session_id).await?,
        None => None,
    };
    let (status, result_size_bytes, error) = audit_outcome(result);
    insert_audit(
        ctx,
        server_name,
        tool_name,
        source_project_id,
        target,
        status,
        result_size_bytes,
        error,
        elapsed_ms(started_at),
    )
    .await
}

async fn source_project_id(ctx: &McpContext) -> Result<Option<i64>, String> {
    sqlx::query_scalar("SELECT project_id FROM features WHERE id = ?")
        .bind(ctx.feature_id)
        .fetch_optional(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to resolve MCP audit source project: {e}"))
}

async fn target_scope(ctx: &McpContext, session_id: i64) -> Result<Option<TargetScope>, String> {
    sqlx::query_as(
        "SELECT s.id AS session_id, f.id AS feature_id, f.project_id
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_optional(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to resolve MCP audit target session: {e}"))
}

fn target_session_id(args: &Value) -> Option<i64> {
    args.get("session_id")
        .or_else(|| args.get("target_session_id"))
        .and_then(Value::as_i64)
}

fn audit_outcome(result: &Result<Value, String>) -> (&'static str, i64, Option<&str>) {
    match result {
        Ok(value) => ("ok", json_size(value), None),
        Err(error) => ("error", 0, Some(error.as_str())),
    }
}

fn json_size(value: &Value) -> i64 {
    serde_json::to_vec(value)
        .map(|bytes| i64::try_from(bytes.len()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn elapsed_ms(started_at: Instant) -> i64 {
    i64::try_from(started_at.elapsed().as_millis()).unwrap_or(i64::MAX)
}

#[allow(clippy::too_many_arguments)]
async fn insert_audit(
    ctx: &McpContext,
    server_name: &str,
    tool_name: &str,
    source_project_id: Option<i64>,
    target: Option<TargetScope>,
    status: &str,
    result_size_bytes: i64,
    error: Option<&str>,
    latency_ms: i64,
) -> Result<(), String> {
    let target_session_id = target.as_ref().map(|scope| scope.session_id);
    let target_feature_id = target.as_ref().map(|scope| scope.feature_id);
    let target_project_id = target.as_ref().map(|scope| scope.project_id);
    sqlx::query(
        "INSERT INTO mcp_tool_audit_log
         (server_name, tool_name, source_session_id, source_feature_id, source_project_id,
          target_session_id, target_feature_id, target_project_id, status, result_size_bytes,
          latency_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(server_name)
    .bind(tool_name)
    .bind(ctx.source_session_id)
    .bind(ctx.feature_id)
    .bind(source_project_id)
    .bind(target_session_id)
    .bind(target_feature_id)
    .bind(target_project_id)
    .bind(status)
    .bind(result_size_bytes)
    .bind(latency_ms)
    .bind(error)
    .execute(&ctx.write_pool)
    .await
    .map_err(|e| format!("Failed to record MCP tool audit: {e}"))?;
    Ok(())
}
