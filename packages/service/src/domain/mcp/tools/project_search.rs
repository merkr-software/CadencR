use serde_json::json;
use sqlx::{FromRow, QueryBuilder, Sqlite};

use crate::domain::mcp::context::McpContext;
use crate::domain::mcp::tools::messages::fts_literal_query;

const DEFAULT_LIMIT: i64 = 10;
const MAX_LIMIT: i64 = 50;
const DEFAULT_SNIPPET_CHARS: i64 = 400;
const MAX_SNIPPET_CHARS: i64 = 2_000;

#[derive(FromRow)]
struct SearchRow {
    message_id: i64,
    role: String,
    message_type: String,
    snippet: String,
    created_at: String,
    feature_id: i64,
    feature_title: String,
    session_id: i64,
    status: String,
    runtime_provider: Option<String>,
    model: Option<String>,
}

pub async fn find_related_sessions(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let query = args
        .get("query")
        .and_then(serde_json::Value::as_str)
        .and_then(fts_literal_query)
        .ok_or_else(|| "query is required".to_string())?;
    let project_id = current_project_id(ctx).await?;
    let rows = search_project(ctx, project_id, &query, limit(args), snippet_chars(args)).await?;
    Ok(json!({
        "project_id": project_id,
        "results": rows.into_iter().map(search_json).collect::<Vec<_>>()
    }))
}

async fn current_project_id(ctx: &McpContext) -> Result<i64, String> {
    sqlx::query_scalar("SELECT project_id FROM features WHERE id = ?")
        .bind(ctx.feature_id)
        .fetch_optional(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to resolve current project: {e}"))?
        .ok_or_else(|| format!("Feature {} does not belong to a project", ctx.feature_id))
}

async fn search_project(
    ctx: &McpContext,
    project_id: i64,
    query: &str,
    limit: i64,
    snippet_chars: i64,
) -> Result<Vec<SearchRow>, String> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT m.id AS message_id, m.role, m.message_type, substr(m.content, 1, ",
    );
    builder.push_bind(snippet_chars).push(
        ") AS snippet, m.created_at, f.id AS feature_id, f.title AS feature_title,
         s.id AS session_id, s.status, s.runtime_provider, s.model
         FROM agent_messages_fts
         JOIN agent_messages m ON m.id = agent_messages_fts.rowid
         JOIN agent_sessions s ON s.id = m.session_id
         JOIN features f ON f.id = s.feature_id
         WHERE f.project_id = ",
    );
    builder
        .push_bind(project_id)
        .push(" AND agent_messages_fts MATCH ")
        .push_bind(query)
        .push(" ORDER BY m.id DESC LIMIT ")
        .push_bind(limit);
    builder
        .build_query_as()
        .fetch_all(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to find related project sessions: {e}"))
}

fn search_json(row: SearchRow) -> serde_json::Value {
    json!({
        "message": {
            "id": row.message_id,
            "role": row.role,
            "message_type": row.message_type,
            "created_at": row.created_at
        },
        "snippet": row.snippet,
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
