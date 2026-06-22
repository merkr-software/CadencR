use serde_json::json;
use sqlx::{FromRow, QueryBuilder, Sqlite};

use crate::domain::mcp::context::McpContext;

#[derive(FromRow)]
struct WorktreeRow {
    session_id: i64,
    status: String,
    runtime_provider: Option<String>,
    model: Option<String>,
    feature_id: i64,
    feature_title: String,
    worktree_mode: Option<String>,
    worktree_path: Option<String>,
    worktree_reuse_branch: Option<String>,
    worktree_base_branch: Option<String>,
}

pub async fn get_worktree_status(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let project_id = current_project_id(ctx).await?;
    let rows = query_worktrees(ctx, project_id, filter_session_id(args)).await?;
    Ok(json!({
        "project_id": project_id,
        "source_session_id": ctx.source_session_id,
        "sessions": rows.into_iter().map(worktree_json).collect::<Vec<_>>()
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

async fn query_worktrees(
    ctx: &McpContext,
    project_id: i64,
    session_id: Option<i64>,
) -> Result<Vec<WorktreeRow>, String> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.id AS session_id, s.status, s.runtime_provider, s.model,
                f.id AS feature_id, f.title AS feature_title,
                wm.value AS worktree_mode, wp.value AS worktree_path,
                wb.value AS worktree_reuse_branch, wbase.value AS worktree_base_branch
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         LEFT JOIN feature_settings wm ON wm.feature_id = f.id AND wm.key = 'worktree_mode'
         LEFT JOIN feature_settings wp ON wp.feature_id = f.id AND wp.key = 'worktree_path'
         LEFT JOIN feature_settings wb ON wb.feature_id = f.id AND wb.key = 'worktree_reuse_branch'
         LEFT JOIN feature_settings wbase ON wbase.feature_id = f.id AND wbase.key = 'worktree_base_branch'
         WHERE f.project_id = ",
    );
    builder.push_bind(project_id);
    if let Some(session_id) = session_id {
        builder.push(" AND s.id = ").push_bind(session_id);
    }
    builder.push(" ORDER BY s.id ASC");
    let rows: Vec<WorktreeRow> = builder
        .build_query_as()
        .fetch_all(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to read project worktree status: {e}"))?;
    if rows.is_empty() {
        if let Some(session_id) = session_id {
            return Err(format!(
                "Session {} does not belong to current project {}",
                session_id, project_id
            ));
        }
    }
    Ok(rows)
}

fn filter_session_id(args: &serde_json::Value) -> Option<i64> {
    args.get("session_id").and_then(serde_json::Value::as_i64)
}

fn worktree_json(row: WorktreeRow) -> serde_json::Value {
    json!({
        "session": {
            "id": row.session_id,
            "status": row.status,
            "provider": row.runtime_provider,
            "model": row.model
        },
        "feature": { "id": row.feature_id, "title": row.feature_title },
        "worktree": {
            "mode": row.worktree_mode,
            "path": row.worktree_path,
            "branch": row.worktree_reuse_branch,
            "base_branch": row.worktree_base_branch
        }
    })
}
