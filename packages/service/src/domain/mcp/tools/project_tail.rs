use serde_json::json;
use sqlx::FromRow;

use crate::domain::mcp::context::McpContext;
use crate::domain::mcp::tools::messages::{
    cap_message_content, messages_json, MessageRow, DEFAULT_MAX_RETURNED_MESSAGE_CHARS,
};

const DEFAULT_LIMIT: i64 = 25;
const MAX_LIMIT: i64 = 50;

#[derive(FromRow)]
struct SessionScope {
    session_id: i64,
    project_id: i64,
}

pub async fn read_session_tail(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let project_id = current_project_id(ctx).await?;
    let session_id = args
        .get("session_id")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "session_id is required".to_string())?;
    ensure_current_project_session(ctx, session_id, project_id).await?;

    let include_metadata = args
        .get("include_metadata")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let include_tool_details = args
        .get("include_tool_details")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let messages = query_tail(ctx, session_id, after_message_id(args), limit(args)).await?;
    let (messages, message_chars_returned, content_truncated) =
        cap_message_content(messages, DEFAULT_MAX_RETURNED_MESSAGE_CHARS);
    Ok(json!({
        "session_id": session_id,
        "project_id": project_id,
        "source_session_id": ctx.source_session_id,
        "message_chars_returned": message_chars_returned,
        "content_truncated": content_truncated,
        "messages": messages_json(&messages, include_metadata, include_tool_details),
        "next_cursor": messages.last().map(|message| json!({ "after_message_id": message.id }))
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

async fn ensure_current_project_session(
    ctx: &McpContext,
    session_id: i64,
    project_id: i64,
) -> Result<(), String> {
    let scope: SessionScope = sqlx::query_as(
        "SELECT s.id AS session_id, f.project_id
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_optional(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to resolve session scope: {e}"))?
    .ok_or_else(|| format!("Session {session_id} was not found"))?;
    if scope.project_id != project_id {
        return Err(format!(
            "Session {} does not belong to current project {}",
            scope.session_id, project_id
        ));
    }
    Ok(())
}

async fn query_tail(
    ctx: &McpContext,
    session_id: i64,
    after_message_id: i64,
    limit: i64,
) -> Result<Vec<MessageRow>, String> {
    sqlx::query_as(
        "SELECT m.id, m.role, m.message_type, m.content, m.tool_name, m.created_at,
                o.origin_kind, o.source_session_id, o.source_feature_id, o.source_project_id,
                o.source_message_id, o.note AS origin_note, o.created_at AS origin_created_at
         FROM agent_messages m
         LEFT JOIN agent_message_origins o ON o.message_id = m.id
         WHERE m.session_id = ? AND m.id > ?
         ORDER BY m.id ASC LIMIT ?",
    )
    .bind(session_id)
    .bind(after_message_id)
    .bind(limit)
    .fetch_all(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to read session tail: {e}"))
}

fn after_message_id(args: &serde_json::Value) -> i64 {
    args.get("after_message_id")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0)
}

fn limit(args: &serde_json::Value) -> i64 {
    args.get("limit")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
}
