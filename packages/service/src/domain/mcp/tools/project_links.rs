use serde_json::json;

use crate::domain::mcp::context::McpContext;

const LINK_TYPES: &[&str] = &["spawned", "messaged", "referenced", "handoff"];

#[derive(sqlx::FromRow)]
struct SessionScope {
    session_id: i64,
    feature_id: i64,
    project_id: i64,
}

pub async fn link_sessions(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let source_session_id = ctx
        .source_session_id
        .ok_or_else(|| "source_session_id is required for project_link_sessions".to_string())?;
    let source = session_scope(ctx, source_session_id).await?;
    if source.feature_id != ctx.feature_id {
        return Err("source_session_id does not belong to current feature".to_string());
    }

    let target_session_id = args
        .get("target_session_id")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "target_session_id is required".to_string())?;
    let target = session_scope(ctx, target_session_id).await?;
    if target.project_id != source.project_id {
        return Err("target session does not belong to current project".to_string());
    }

    let link_type = link_type(args)?;
    let note = args
        .get("note")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let link_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type, note)
         VALUES (?, ?, ?, ?)
         RETURNING id",
    )
    .bind(source.session_id)
    .bind(target.session_id)
    .bind(link_type)
    .bind(note)
    .fetch_one(&ctx.write_pool)
    .await
    .map_err(|e| format!("Failed to link project sessions: {e}"))?;

    Ok(json!({
        "link_id": link_id,
        "source_session_id": source.session_id,
        "target_session_id": target.session_id,
        "link_type": link_type
    }))
}

async fn session_scope(ctx: &McpContext, session_id: i64) -> Result<SessionScope, String> {
    sqlx::query_as(
        "SELECT s.id AS session_id, f.id AS feature_id, f.project_id
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

fn link_type(args: &serde_json::Value) -> Result<&str, String> {
    let link_type = args
        .get("link_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("referenced");
    if LINK_TYPES.contains(&link_type) {
        Ok(link_type)
    } else {
        Err(format!("unsupported link_type '{link_type}'"))
    }
}
