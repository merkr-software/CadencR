use serde_json::json;
use sqlx::FromRow;

use crate::domain::mcp::context::McpContext;

#[derive(FromRow, serde::Serialize)]
struct ProjectRow {
    id: i64,
    name: String,
    path: String,
    created_at: Option<String>,
}

pub async fn list_projects(ctx: &McpContext) -> Result<serde_json::Value, String> {
    let projects: Vec<ProjectRow> = sqlx::query_as(
        "SELECT id, name, path, created_at FROM projects ORDER BY name ASC, id ASC LIMIT 200",
    )
    .fetch_all(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to list workspace projects: {e}"))?;
    Ok(json!({ "projects": projects }))
}
