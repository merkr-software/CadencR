use std::collections::BTreeMap;

use serde_json::json;

use crate::domain::mcp::context::McpContext;
use crate::domain::mcp::tools::helpers::require_i64;

#[derive(sqlx::FromRow)]
struct SessionSummaryRow {
    session_id: i64,
    status: String,
    runtime_provider: Option<String>,
    model: Option<String>,
    feature_id: i64,
    feature_title: String,
    project_id: i64,
    branch: Option<String>,
}

#[derive(sqlx::FromRow, serde::Serialize)]
struct LinkRow {
    source_session_id: i64,
    target_session_id: i64,
    link_type: String,
    note: Option<String>,
    created_at: String,
}

pub async fn compare_sessions(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let project_id = current_project_id(ctx).await?;
    let left_id = require_i64(args, "left_session_id")?;
    let right_id = require_i64(args, "right_session_id")?;
    let left = load_summary(ctx, left_id).await?;
    let right = load_summary(ctx, right_id).await?;
    ensure_current_project(&left, project_id)?;
    ensure_current_project(&right, project_id)?;
    let links = load_links(ctx, left_id, right_id).await?;

    Ok(json!({
        "project_id": project_id,
        "left": session_json(ctx, left).await?,
        "right": session_json(ctx, right).await?,
        "links": links
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

async fn load_summary(ctx: &McpContext, session_id: i64) -> Result<SessionSummaryRow, String> {
    sqlx::query_as(
        "SELECT s.id AS session_id, s.status, s.runtime_provider, s.model,
                f.id AS feature_id, f.title AS feature_title, f.project_id,
                wb.value AS branch
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         LEFT JOIN feature_settings wb
             ON wb.feature_id = f.id AND wb.key = 'worktree_reuse_branch'
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_optional(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to read session summary: {e}"))?
    .ok_or_else(|| format!("Session {session_id} was not found"))
}

async fn session_json(
    ctx: &McpContext,
    row: SessionSummaryRow,
) -> Result<serde_json::Value, String> {
    let counts = message_counts(ctx, row.session_id).await?;
    Ok(json!({
        "session": {
            "id": row.session_id,
            "status": row.status,
            "provider": row.runtime_provider,
            "model": row.model
        },
        "feature": { "id": row.feature_id, "title": row.feature_title },
        "worktree": { "branch": row.branch },
        "message_counts": counts,
        "first_user_message": first_message(ctx, row.session_id, "user_message").await?,
        "latest_assistant_text": crate::domain::mcp::message_queries::latest_assistant_text(
            &ctx.read_pool,
            row.session_id,
        )
        .await
        .map_err(|e| format!("Failed to read latest assistant text: {e}"))?
    }))
}

async fn message_counts(
    ctx: &McpContext,
    session_id: i64,
) -> Result<BTreeMap<String, i64>, String> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT message_type, COUNT(*) FROM agent_messages
         WHERE session_id = ? GROUP BY message_type",
    )
    .bind(session_id)
    .fetch_all(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to count session messages: {e}"))?;
    Ok(rows.into_iter().collect())
}

async fn first_message(
    ctx: &McpContext,
    session_id: i64,
    message_type: &str,
) -> Result<Option<String>, String> {
    sqlx::query_scalar(
        "SELECT content FROM agent_messages
         WHERE session_id = ? AND message_type = ?
         ORDER BY id ASC LIMIT 1",
    )
    .bind(session_id)
    .bind(message_type)
    .fetch_optional(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to read first session message: {e}"))
}

async fn load_links(ctx: &McpContext, left_id: i64, right_id: i64) -> Result<Vec<LinkRow>, String> {
    sqlx::query_as(
        "SELECT source_session_id, target_session_id, link_type, note, created_at
         FROM agent_session_links
         WHERE (source_session_id = ? AND target_session_id = ?)
            OR (source_session_id = ? AND target_session_id = ?)
         ORDER BY created_at ASC, id ASC",
    )
    .bind(left_id)
    .bind(right_id)
    .bind(right_id)
    .bind(left_id)
    .fetch_all(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to read session links: {e}"))
}

fn ensure_current_project(row: &SessionSummaryRow, project_id: i64) -> Result<(), String> {
    if row.project_id != project_id {
        return Err(format!(
            "Session {} does not belong to current project {}",
            row.session_id, project_id
        ));
    }
    Ok(())
}
