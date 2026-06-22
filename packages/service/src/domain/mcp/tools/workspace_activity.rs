use serde_json::json;
use sqlx::FromRow;

use crate::domain::mcp::context::McpContext;

const DEFAULT_LIMIT: i64 = 10;
const MAX_LIMIT: i64 = 50;
const DEFAULT_SNIPPET_CHARS: i64 = 300;
const MAX_SNIPPET_CHARS: i64 = 2_000;

#[derive(FromRow)]
struct ActivityRow {
    message_id: i64,
    role: String,
    message_type: String,
    snippet: String,
    created_at: String,
    project_id: i64,
    project_name: String,
    project_path: String,
    feature_id: i64,
    feature_title: String,
    session_id: i64,
    status: String,
    runtime_provider: Option<String>,
    model: Option<String>,
}

pub async fn recent_activity(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let rows = query_recent_activity(ctx, limit(args), snippet_chars(args)).await?;
    Ok(json!({
        "activity": rows.into_iter().map(activity_json).collect::<Vec<_>>()
    }))
}

async fn query_recent_activity(
    ctx: &McpContext,
    limit: i64,
    snippet_chars: i64,
) -> Result<Vec<ActivityRow>, String> {
    sqlx::query_as(
        "SELECT m.id AS message_id, m.role, m.message_type,
                substr(m.content, 1, ?) AS snippet, m.created_at,
                p.id AS project_id, p.name AS project_name, p.path AS project_path,
                f.id AS feature_id, f.title AS feature_title,
                s.id AS session_id, s.status, s.runtime_provider, s.model
         FROM agent_messages m
         JOIN agent_sessions s ON s.id = m.session_id
         JOIN features f ON f.id = s.feature_id
         JOIN projects p ON p.id = f.project_id
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ?",
    )
    .bind(snippet_chars)
    .bind(limit)
    .fetch_all(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to read workspace recent activity: {e}"))
}

fn activity_json(row: ActivityRow) -> serde_json::Value {
    json!({
        "message": {
            "id": row.message_id,
            "role": row.role,
            "message_type": row.message_type,
            "created_at": row.created_at
        },
        "snippet": row.snippet,
        "project": { "id": row.project_id, "name": row.project_name, "path": row.project_path },
        "feature": { "id": row.feature_id, "title": row.feature_title },
        "session": {
            "id": row.session_id,
            "status": row.status,
            "provider": row.runtime_provider,
            "model": row.model
        }
    })
}

fn limit(args: &serde_json::Value) -> i64 {
    args.get("limit")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
}

fn snippet_chars(args: &serde_json::Value) -> i64 {
    args.get("snippet_chars")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_SNIPPET_CHARS)
        .clamp(1, MAX_SNIPPET_CHARS)
}
