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
use crate::domain::mcp::tools::{session_graph, workspace_activity, workspace_projects};

const DEFAULT_LIMIT: i64 = 25;
const MAX_LIMIT: i64 = 50;
const DEFAULT_SNIPPET_CHARS: i64 = 400;
const MAX_SNIPPET_CHARS: i64 = 2_000;
const DEFAULT_UNQUERIED_WINDOW_DAYS: i64 = 30;
const WORKSPACE_MCP_ENABLED_SETTING_KEY: &str = "workspace_mcp_enabled";
const WORKSPACE_MCP_MAX_RESULT_CHARS_SETTING_KEY: &str = "workspace_mcp_max_result_chars";

#[derive(FromRow)]
struct SessionReadRow {
    project_id: i64,
    project_name: String,
    project_path: String,
    feature_id: i64,
    feature_title: String,
    session_id: i64,
    status: String,
    agent_type: Option<String>,
    runtime_provider: Option<String>,
    model: Option<String>,
    started_at: Option<String>,
}

#[derive(FromRow)]
struct SearchRow {
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

pub async fn run_workspace_tool(
    name: &str,
    args: serde_json::Value,
    ctx: Arc<McpContext>,
) -> CallToolResult {
    if !workspace_mcp_enabled() {
        return error_result(
            "cadencr-workspace reads are disabled; set workspace_mcp_enabled=true to allow them",
        );
    }
    let started_at = std::time::Instant::now();
    let result = match name {
        "workspace_list_projects" => workspace_projects::list_projects(&ctx).await,
        "workspace_read_session" => read_session(&ctx, &args).await,
        "workspace_read_sessions" => read_sessions(&ctx, &args).await,
        "workspace_session_graph" => session_graph::session_graph(&ctx, &args).await,
        "workspace_recent_activity" => workspace_activity::recent_activity(&ctx, &args).await,
        _ => Err(format!("Unknown tool: {name}")),
    };
    let audit =
        record_read_tool_audit("cadencr-workspace", name, &args, &ctx, &result, started_at).await;
    let result = audit.map_or_else(Err, |_| result);
    match result {
        Ok(value) => text_result(&value.to_string()),
        Err(error) => error_result(&error),
    }
}

fn workspace_mcp_enabled() -> bool {
    crate::domain::settings_store::global_get(WORKSPACE_MCP_ENABLED_SETTING_KEY).as_deref()
        != Some("false")
}

fn workspace_result_char_cap() -> usize {
    crate::domain::settings_store::global_get(WORKSPACE_MCP_MAX_RESULT_CHARS_SETTING_KEY)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(DEFAULT_MAX_RETURNED_MESSAGE_CHARS))
        .unwrap_or(DEFAULT_MAX_RETURNED_MESSAGE_CHARS)
}

#[cfg(test)]
mod tests {
    use crate::domain::settings_store;
    use std::fs;

    #[test]
    fn workspace_mcp_enabled_defaults_on_and_off_only_for_explicit_false() {
        assert!(super::workspace_mcp_enabled());
        let settings_path = settings_store::global_dir().join("settings.json");
        fs::write(&settings_path, r#"{"workspace_mcp_enabled":"false"}"#).expect("write false");
        assert!(!super::workspace_mcp_enabled());
        fs::write(&settings_path, r#"{"workspace_mcp_enabled":"true"}"#).expect("write true");
        assert!(super::workspace_mcp_enabled());
    }
}

fn limit_from_args(args: &serde_json::Value) -> i64 {
    args.get("limit")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
}

fn snippet_chars_from_args(args: &serde_json::Value) -> i64 {
    args.get("snippet_chars")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_SNIPPET_CHARS)
        .clamp(1, MAX_SNIPPET_CHARS)
}

fn i64_array(args: &serde_json::Value, key: &str) -> Vec<i64> {
    args.get(key)
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_i64)
                .collect()
        })
        .unwrap_or_default()
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

fn cursor_before_message_id(args: &serde_json::Value) -> Option<i64> {
    args.get("cursor")
        .and_then(|cursor| cursor.get("before_message_id"))
        .and_then(serde_json::Value::as_i64)
}

fn push_i64_filter(builder: &mut QueryBuilder<Sqlite>, column: &str, values: &[i64]) {
    if values.is_empty() {
        return;
    }
    builder.push(" AND ").push(column).push(" IN (");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            builder.push(", ");
        }
        builder.push_bind(*value);
    }
    builder.push(")");
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

async fn read_sessions(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let limit = limit_from_args(args);
    let snippet_chars = snippet_chars_from_args(args);
    let project_ids = i64_array(args, "project_ids");
    let roles = string_array(args, "roles");
    let message_types = string_array(args, "message_types");
    let providers = string_array(args, "providers");
    let models = string_array(args, "models");
    let statuses = string_array(args, "statuses");
    let tool_names = string_array(args, "tool_names");
    let mut created_after = trimmed_string(args, "created_after");
    let created_before = trimmed_string(args, "created_before");
    let before_message_id = cursor_before_message_id(args);
    let query = trimmed_string(args, "query").and_then(|value| fts_literal_query(&value));
    let applied_recent_window_days = if query.is_none() && created_after.is_none() {
        created_after = Some(
            (chrono::Utc::now() - chrono::Duration::days(DEFAULT_UNQUERIED_WINDOW_DAYS))
                .to_rfc3339(),
        );
        Some(DEFAULT_UNQUERIED_WINDOW_DAYS)
    } else {
        None
    };

    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT m.id AS message_id, m.role, m.message_type, substr(m.content, 1, ",
    );
    builder.push_bind(snippet_chars).push(
        ") AS snippet, m.created_at, p.id AS project_id, p.name AS project_name,
         p.path AS project_path, f.id AS feature_id, f.title AS feature_title,
         s.id AS session_id, s.status, s.runtime_provider, s.model
         FROM ",
    );
    if query.as_deref().is_some() {
        builder.push("agent_messages_fts JOIN agent_messages m ON m.id = agent_messages_fts.rowid");
    } else {
        builder.push("agent_messages m");
    }
    builder.push(
        " JOIN agent_sessions s ON s.id = m.session_id
          JOIN features f ON f.id = s.feature_id
          JOIN projects p ON p.id = f.project_id
          WHERE 1 = 1",
    );
    if let Some(query) = query.as_deref() {
        builder
            .push(" AND agent_messages_fts MATCH ")
            .push_bind(query);
    }
    if let Some(before_message_id) = before_message_id {
        builder.push(" AND m.id < ").push_bind(before_message_id);
    }
    if let Some(created_after) = created_after {
        builder
            .push(" AND m.created_at >= ")
            .push_bind(created_after);
    }
    if let Some(created_before) = created_before {
        builder
            .push(" AND m.created_at < ")
            .push_bind(created_before);
    }
    push_i64_filter(&mut builder, "p.id", &project_ids);
    push_string_filter(&mut builder, "m.role", &roles);
    push_string_filter(&mut builder, "m.message_type", &message_types);
    push_string_filter(&mut builder, "m.tool_name", &tool_names);
    push_string_filter(&mut builder, "s.runtime_provider", &providers);
    push_string_filter(&mut builder, "s.model", &models);
    push_string_filter(&mut builder, "s.status", &statuses);
    builder.push(" ORDER BY m.id DESC LIMIT ").push_bind(limit);

    let rows: Vec<SearchRow> = builder
        .build_query_as()
        .fetch_all(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to search workspace sessions: {e}"))?;
    let next_cursor = rows
        .last()
        .map(|row| json!({ "before_message_id": row.message_id }));
    Ok(json!({
        "results": rows.into_iter().map(search_json).collect::<Vec<_>>(),
        "applied_recent_window_days": applied_recent_window_days,
        "next_cursor": next_cursor
    }))
}

fn search_json(row: SearchRow) -> serde_json::Value {
    json!({
        "message": { "id": row.message_id, "role": row.role, "message_type": row.message_type, "created_at": row.created_at },
        "snippet": row.snippet,
        "project": { "id": row.project_id, "name": row.project_name, "path": row.project_path },
        "feature": { "id": row.feature_id, "title": row.feature_title },
        "session": { "id": row.session_id, "status": row.status, "provider": row.runtime_provider, "model": row.model }
    })
}

async fn read_session(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_id = require_i64(args, "session_id")?;
    let limit = limit_from_args(args);
    let after_message_id = args
        .get("after_message_id")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let before_message_id = args
        .get("before_message_id")
        .and_then(serde_json::Value::as_i64);
    let query = trimmed_string(args, "query").and_then(|value| fts_literal_query(&value));
    let roles = string_array(args, "roles");
    let message_types = string_array(args, "message_types");
    let include_metadata = args
        .get("include_metadata")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let session: SessionReadRow = sqlx::query_as(
        "SELECT p.id AS project_id, p.name AS project_name, p.path AS project_path,
                f.id AS feature_id, f.title AS feature_title, s.id AS session_id,
                s.status, s.agent_type, s.runtime_provider, s.model, s.started_at
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         JOIN projects p ON p.id = f.project_id
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_optional(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to read workspace session: {e}"))?
    .ok_or_else(|| format!("Session {session_id} was not found"))?;
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
        cap_message_content(messages, workspace_result_char_cap());
    Ok(json!({
        "project": { "id": session.project_id, "name": session.project_name, "path": session.project_path },
        "feature": { "id": session.feature_id, "title": session.feature_title },
        "session": {
            "id": session.session_id, "status": session.status,
            "agent_type": session.agent_type, "provider": session.runtime_provider,
            "model": session.model, "started_at": session.started_at
        },
        "metadata_included": include_metadata,
        "message_chars_returned": message_chars_returned,
        "content_truncated": content_truncated,
        "messages": messages_json(&messages, include_metadata, true),
        "next_cursor": messages.last().map(|message| json!({ "after_message_id": message.id }))
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
        .map_err(|e| format!("Failed to read workspace session messages: {e}"))
}
