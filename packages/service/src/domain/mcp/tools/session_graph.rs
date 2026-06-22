use std::collections::BTreeMap;

use serde_json::json;
use sqlx::{FromRow, QueryBuilder, Sqlite};

use crate::domain::mcp::context::McpContext;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 100;

#[derive(FromRow, serde::Serialize)]
struct SessionLinkRow {
    id: i64,
    source_session_id: i64,
    target_session_id: i64,
    link_type: String,
    created_at: String,
    note: Option<String>,
}

#[derive(FromRow)]
struct SessionNodeRow {
    session_id: i64,
    status: String,
    runtime_provider: Option<String>,
    model: Option<String>,
    feature_id: i64,
    feature_title: String,
    project_id: i64,
    project_name: String,
    project_path: String,
}

pub async fn session_graph(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let links = query_links(ctx, filter_session_id(args), limit_from_args(args)).await?;
    let session_ids = linked_session_ids(&links);
    let nodes = query_nodes(ctx, &session_ids).await?;
    Ok(json!({
        "nodes": nodes.into_iter().map(|node| (node.session_id.to_string(), node_json(node))).collect::<BTreeMap<_, _>>(),
        "links": links
    }))
}

async fn query_links(
    ctx: &McpContext,
    session_id: Option<i64>,
    limit: i64,
) -> Result<Vec<SessionLinkRow>, String> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT id, source_session_id, target_session_id, link_type, created_at, note
         FROM agent_session_links WHERE 1 = 1",
    );
    if let Some(session_id) = session_id {
        builder
            .push(" AND (source_session_id = ")
            .push_bind(session_id)
            .push(" OR target_session_id = ")
            .push_bind(session_id)
            .push(")");
    }
    builder
        .push(" ORDER BY created_at ASC, id ASC LIMIT ")
        .push_bind(limit);
    builder
        .build_query_as()
        .fetch_all(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to read workspace session graph: {e}"))
}

fn linked_session_ids(links: &[SessionLinkRow]) -> Vec<i64> {
    let mut ids = Vec::with_capacity(links.len() * 2);
    for link in links {
        ids.push(link.source_session_id);
        ids.push(link.target_session_id);
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

async fn query_nodes(ctx: &McpContext, session_ids: &[i64]) -> Result<Vec<SessionNodeRow>, String> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.id AS session_id, s.status, s.runtime_provider, s.model,
                f.id AS feature_id, f.title AS feature_title,
                p.id AS project_id, p.name AS project_name, p.path AS project_path
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         JOIN projects p ON p.id = f.project_id
         WHERE s.id IN (",
    );
    for (index, session_id) in session_ids.iter().enumerate() {
        if index > 0 {
            builder.push(", ");
        }
        builder.push_bind(*session_id);
    }
    builder.push(") ORDER BY s.id ASC");
    builder
        .build_query_as()
        .fetch_all(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to read workspace session graph nodes: {e}"))
}

fn node_json(row: SessionNodeRow) -> serde_json::Value {
    json!({
        "session": {
            "id": row.session_id,
            "status": row.status,
            "provider": row.runtime_provider,
            "model": row.model
        },
        "feature": { "id": row.feature_id, "title": row.feature_title },
        "project": { "id": row.project_id, "name": row.project_name, "path": row.project_path }
    })
}

fn filter_session_id(args: &serde_json::Value) -> Option<i64> {
    args.get("session_id").and_then(serde_json::Value::as_i64)
}

fn limit_from_args(args: &serde_json::Value) -> i64 {
    args.get("limit")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
}
