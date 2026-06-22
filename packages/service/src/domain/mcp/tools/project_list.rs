use serde_json::json;
use sqlx::{FromRow, QueryBuilder, Sqlite};

use crate::domain::mcp::context::McpContext;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 50;

#[derive(FromRow, serde::Serialize)]
struct ProjectSummary {
    id: i64,
    name: String,
    path: String,
}

#[derive(FromRow)]
struct ProjectSessionRow {
    id: i64,
    status: String,
    agent_type: Option<String>,
    runtime_provider: Option<String>,
    model: Option<String>,
    started_at: Option<String>,
    feature_id: i64,
    feature_title: String,
    worktree_path: Option<String>,
    worktree_reuse_branch: Option<String>,
}

pub async fn list_sessions(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let project = current_project(ctx).await?;
    let limit = limit_from_args(args);
    let mut sessions = sessions_for_project(ctx, project.id, limit + 1, cursor(args)).await?;
    let has_more = sessions.len() > limit as usize;
    sessions.truncate(limit as usize);
    let next_cursor = if has_more {
        sessions.last().map(session_cursor)
    } else {
        None
    };

    Ok(json!({
        "project": project,
        "source_session_id": ctx.source_session_id,
        "sessions": sessions.into_iter().map(session_json).collect::<Vec<_>>(),
        "next_cursor": next_cursor
    }))
}

async fn current_project(ctx: &McpContext) -> Result<ProjectSummary, String> {
    sqlx::query_as(
        "SELECT p.id, p.name, p.path
         FROM features f
         JOIN projects p ON p.id = f.project_id
         WHERE f.id = ?",
    )
    .bind(ctx.feature_id)
    .fetch_optional(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to resolve current project: {e}"))?
    .ok_or_else(|| format!("Feature {} does not belong to a project", ctx.feature_id))
}

async fn sessions_for_project(
    ctx: &McpContext,
    project_id: i64,
    limit: i64,
    cursor: Option<ProjectListCursor>,
) -> Result<Vec<ProjectSessionRow>, String> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.id, s.status, s.agent_type, s.runtime_provider, s.model, s.started_at,
                f.id AS feature_id, f.title AS feature_title,
                wt.value AS worktree_path, rb.value AS worktree_reuse_branch
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         LEFT JOIN feature_settings wt ON wt.feature_id = f.id AND wt.key = 'worktree_path'
         LEFT JOIN feature_settings rb ON rb.feature_id = f.id AND rb.key = 'worktree_reuse_branch'
         WHERE f.project_id = ",
    );
    builder.push_bind(project_id);
    if let Some(cursor) = cursor {
        builder
            .push(" AND (COALESCE(s.started_at, '') < ")
            .push_bind(cursor.before_started_at.clone())
            .push(" OR (COALESCE(s.started_at, '') = ")
            .push_bind(cursor.before_started_at)
            .push(" AND s.id < ")
            .push_bind(cursor.before_session_id)
            .push("))");
    }
    builder
        .push(" ORDER BY COALESCE(s.started_at, '') DESC, s.id DESC LIMIT ")
        .push_bind(limit);
    builder
        .build_query_as()
        .fetch_all(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to list project sessions: {e}"))
}

fn limit_from_args(args: &serde_json::Value) -> i64 {
    args.get("limit")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
}

struct ProjectListCursor {
    before_session_id: i64,
    before_started_at: String,
}

fn cursor(args: &serde_json::Value) -> Option<ProjectListCursor> {
    let cursor = args.get("cursor")?;
    Some(ProjectListCursor {
        before_session_id: cursor.get("before_session_id")?.as_i64()?,
        before_started_at: cursor.get("before_started_at")?.as_str()?.to_string(),
    })
}

fn session_cursor(row: &ProjectSessionRow) -> serde_json::Value {
    json!({
        "before_session_id": row.id,
        "before_started_at": row.started_at.as_deref().unwrap_or("")
    })
}

fn session_json(row: ProjectSessionRow) -> serde_json::Value {
    json!({
        "id": row.id,
        "status": row.status,
        "agent_type": row.agent_type,
        "provider": row.runtime_provider,
        "model": row.model,
        "started_at": row.started_at,
        "feature": {
            "id": row.feature_id,
            "title": row.feature_title,
            "worktree_path": row.worktree_path,
            "branch": row.worktree_reuse_branch
        }
    })
}
