use std::sync::Arc;

use rmcp::model::CallToolResult;
use serde_json::json;
use sqlx::{FromRow, QueryBuilder, Sqlite};

use crate::domain::mcp::context::McpContext;
use crate::domain::mcp::tools::audit::record_read_tool_audit;
use crate::domain::mcp::tools::helpers::{error_result, require_i64, text_result};
use crate::domain::mcp::tools::messages::{
    cap_message_content, fts_literal_query, messages_json, MessageRow,
    DEFAULT_MAX_RETURNED_MESSAGE_CHARS,
};
use crate::domain::mcp::tools::project_compare;
use crate::domain::mcp::tools::project_control;
use crate::domain::mcp::tools::project_links;
use crate::domain::mcp::tools::project_list;
use crate::domain::mcp::tools::project_providers;
use crate::domain::mcp::tools::project_search;
use crate::domain::mcp::tools::project_tail;
use crate::domain::mcp::tools::project_worktree;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 50;

#[derive(FromRow, serde::Serialize)]
struct ProjectSummary {
    id: i64,
    name: String,
    path: String,
}

#[derive(FromRow)]
struct SessionScopeRow {
    session_id: i64,
    project_id: i64,
}

#[derive(FromRow, serde::Serialize)]
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

pub async fn run_project_tool(
    name: &str,
    args: serde_json::Value,
    ctx: Arc<McpContext>,
) -> CallToolResult {
    let started_at = std::time::Instant::now();
    let result = match name {
        "project_list_sessions" => project_list::list_sessions(&ctx, &args).await,
        "project_read_session" => read_session(&ctx, &args).await,
        "project_get_session_status" => get_session_status(&ctx, &args).await,
        "project_find_related_sessions" => project_search::find_related_sessions(&ctx, &args).await,
        "project_read_session_tail" => project_tail::read_session_tail(&ctx, &args).await,
        "project_link_sessions" => project_links::link_sessions(&ctx, &args).await,
        "project_get_worktree_status" => project_worktree::get_worktree_status(&ctx, &args).await,
        "project_compare_sessions" => project_compare::compare_sessions(&ctx, &args).await,
        "project_list_agent_providers" => project_providers::list_agent_providers(&ctx).await,
        "project_send_session_message" => project_control::send_session_message(&args, &ctx).await,
        "project_spawn_session" => project_control::spawn_session(&args, &ctx).await,
        "project_list_pending_gates" => project_control::list_pending_gates(&args, &ctx).await,
        "project_respond_gate" => project_control::respond_gate(&args, &ctx).await,
        _ => Err(format!("Unknown tool: {name}")),
    };
    let result = if is_project_read_tool(name) {
        record_read_tool_audit("cadencr-project", name, &args, &ctx, &result, started_at)
            .await
            .map_or_else(Err, |_| result)
    } else {
        result
    };

    match result {
        Ok(value) => text_result(&value.to_string()),
        Err(error) => error_result(&error),
    }
}

fn is_project_read_tool(name: &str) -> bool {
    matches!(
        name,
        "project_list_sessions"
            | "project_read_session"
            | "project_get_session_status"
            | "project_find_related_sessions"
            | "project_read_session_tail"
            | "project_link_sessions"
            | "project_get_worktree_status"
            | "project_compare_sessions"
            | "project_list_agent_providers"
    )
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

async fn session_scope(ctx: &McpContext, session_id: i64) -> Result<SessionScopeRow, String> {
    sqlx::query_as(
        "SELECT s.id AS session_id, f.project_id
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_optional(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to resolve session scope: {e}"))?
    .ok_or_else(|| format!("Session {session_id} was not found"))
}

async fn ensure_current_project_session(
    ctx: &McpContext,
    session_id: i64,
    project_id: i64,
) -> Result<(), String> {
    let scope = session_scope(ctx, session_id).await?;
    if scope.project_id != project_id {
        return Err(format!(
            "Session {} does not belong to current project {}",
            scope.session_id, project_id
        ));
    }
    Ok(())
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

fn limit_from_args(args: &serde_json::Value) -> i64 {
    args.get("limit")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
}

fn string_array(args: &serde_json::Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn trimmed_string(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn push_string_filter(builder: &mut QueryBuilder<Sqlite>, column: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    builder.push(" AND ").push(column).push(" IN (");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            builder.push(", ");
        }
        builder.push_bind(value.clone());
    }
    builder.push(")");
}

async fn read_session(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let project = current_project(ctx).await?;
    let session_id = require_i64(args, "session_id")?;
    ensure_current_project_session(ctx, session_id, project.id).await?;

    let limit = limit_from_args(args);
    let after_message_id = args
        .get("after_message_id")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let before_message_id = args
        .get("before_message_id")
        .and_then(serde_json::Value::as_i64);
    let include_metadata = args
        .get("include_metadata")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let include_tool_details = args
        .get("include_tool_details")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let query = trimmed_string(args, "query").and_then(|value| fts_literal_query(&value));
    let roles = string_array(args, "roles");
    let message_types = string_array(args, "message_types");

    let session = sqlx::query_as::<_, ProjectSessionRow>(
        "SELECT
             s.id,
             s.status,
             s.agent_type,
             s.runtime_provider,
             s.model,
             s.started_at,
             f.id AS feature_id,
             f.title AS feature_title,
             wt.value AS worktree_path,
             rb.value AS worktree_reuse_branch
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         LEFT JOIN feature_settings wt
             ON wt.feature_id = f.id AND wt.key = 'worktree_path'
         LEFT JOIN feature_settings rb
             ON rb.feature_id = f.id AND rb.key = 'worktree_reuse_branch'
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_one(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to read session metadata: {e}"))?;

    let messages = query_session_messages(
        ctx,
        session_id,
        after_message_id,
        before_message_id,
        limit,
        query.as_deref(),
        &roles,
        &message_types,
    )
    .await?;
    let (messages, message_chars_returned, content_truncated) =
        cap_message_content(messages, DEFAULT_MAX_RETURNED_MESSAGE_CHARS);

    let next_after = messages.last().map(|message| message.id);
    Ok(json!({
        "project": project,
        "source_session_id": ctx.source_session_id,
        "session": session_json(session),
        "metadata_included": include_metadata,
        "tool_details_included": include_tool_details,
        "message_chars_returned": message_chars_returned,
        "content_truncated": content_truncated,
        "messages": messages_json(&messages, include_metadata, include_tool_details),
        "next_cursor": next_after.map(|id| json!({ "after_message_id": id }))
    }))
}

async fn query_session_messages(
    ctx: &McpContext,
    session_id: i64,
    after_message_id: i64,
    before_message_id: Option<i64>,
    limit: i64,
    query: Option<&str>,
    roles: &[String],
    message_types: &[String],
) -> Result<Vec<MessageRow>, String> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT m.id, m.role, m.message_type, m.content, m.tool_name, m.created_at,
                o.origin_kind, o.source_session_id, o.source_feature_id, o.source_project_id,
                o.source_message_id, o.note AS origin_note, o.created_at AS origin_created_at
         FROM ",
    );
    if query.is_some() {
        builder.push("agent_messages_fts JOIN agent_messages m ON m.id = agent_messages_fts.rowid");
    } else {
        builder.push("agent_messages m");
    }
    builder
        .push(" LEFT JOIN agent_message_origins o ON o.message_id = m.id")
        .push(" WHERE m.session_id = ")
        .push_bind(session_id)
        .push(" AND m.id > ")
        .push_bind(after_message_id);
    if let Some(before_message_id) = before_message_id {
        builder.push(" AND m.id < ").push_bind(before_message_id);
    }
    if let Some(query) = query {
        builder
            .push(" AND agent_messages_fts MATCH ")
            .push_bind(query);
    }
    push_string_filter(&mut builder, "m.role", roles);
    push_string_filter(&mut builder, "m.message_type", message_types);
    builder.push(" ORDER BY m.id ASC LIMIT ").push_bind(limit);
    builder
        .build_query_as()
        .fetch_all(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to read session messages: {e}"))
}

async fn get_session_status(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let project = current_project(ctx).await?;
    let session_id = require_i64(args, "session_id")?;
    ensure_current_project_session(ctx, session_id, project.id).await?;

    let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to read session status: {e}"))?;
    let pending_queue_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_session_message_queue
         WHERE target_session_id = ? AND status = 'pending'",
    )
    .bind(session_id)
    .fetch_one(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to read pending queue count: {e}"))?;

    Ok(json!({
        "session_id": session_id,
        "project_id": project.id,
        "source_session_id": ctx.source_session_id,
        "status": status,
        "pending_queue_count": pending_queue_count,
        "has_pending_queue": pending_queue_count > 0
    }))
}
