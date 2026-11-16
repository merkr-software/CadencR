//! Records the audit row of an orchestration read tool. The subprocess ran the
//! read on its read-only connection; the service writes the row, resolving the
//! source and target projects itself. Nothing is broadcast: no client shows
//! the audit log, and the send budget reads it on demand.

use axum::{extract::State, Json};
use serde::Serialize;

use super::audit::{record_tool_audit, ToolAudit};
use crate::app_state::AppState;
use crate::domain::mcp::control_grant::McpControlServer;
use crate::domain::mcp::read_audit::{endpoint, is_read_tool, ReadAuditRequest};
use crate::error::AppError;

#[derive(Debug, Serialize)]
pub(super) struct ReadAuditResponse {
    recorded: bool,
}

#[derive(sqlx::FromRow)]
struct TargetScope {
    feature_id: i64,
    project_id: i64,
}

pub(super) fn routes() -> axum::Router<AppState> {
    let route =
        |server| axum::routing::post(move |state, body| read_audit_handler(state, body, server));
    axum::Router::new()
        .route(
            endpoint(McpControlServer::Project),
            route(McpControlServer::Project),
        )
        .route(
            endpoint(McpControlServer::Workspace),
            route(McpControlServer::Workspace),
        )
}

async fn read_audit_handler(
    State(state): State<AppState>,
    Json(body): Json<ReadAuditRequest>,
    server: McpControlServer,
) -> Result<Json<ReadAuditResponse>, AppError> {
    if !is_read_tool(server, &body.tool_name) {
        return Err(AppError::BadRequest(format!(
            "{} is not a {} read tool",
            body.tool_name,
            server.server_name()
        )));
    }
    // Rows that predate the call: read them without holding the write
    // connection, which this route takes on every read tool call.
    let source_project_id: Option<i64> =
        sqlx::query_scalar("SELECT project_id FROM features WHERE id = ?")
            .bind(body.source_feature_id)
            .fetch_optional(&state.read_pool)
            .await?;
    let target = match body.target_session_id {
        Some(session_id) => target_scope(&state, session_id).await?,
        None => None,
    };
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: server.server_name(),
            tool_name: &body.tool_name,
            source_session_id: Some(body.source_session_id),
            source_feature_id: Some(body.source_feature_id),
            source_project_id,
            // The id the agent asked for, even when no such session exists.
            target_session_id: body.target_session_id,
            target_feature_id: target.as_ref().map(|target| target.feature_id),
            target_project_id: target.as_ref().map(|target| target.project_id),
            status: body.status.as_str(),
            result_size_bytes: body.result_size_bytes,
            latency_ms: body.latency_ms,
            error: body.error.as_deref(),
        },
    )
    .await?;
    Ok(Json(ReadAuditResponse { recorded: true }))
}

async fn target_scope(state: &AppState, session_id: i64) -> Result<Option<TargetScope>, AppError> {
    Ok(sqlx::query_as(
        "SELECT f.id AS feature_id, f.project_id
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_optional(&state.read_pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::{json, Value};

    use super::super::schedule_scope::test_support::{post, session};
    use crate::app_state::AppState;
    use crate::domain::schedules::repository::test_support::fixture;

    fn audit(source_feature: i64, source_session: i64, tool: &str, target: i64) -> Value {
        json!({
            "source_feature_id": source_feature, "source_session_id": source_session,
            "tool_name": tool, "target_session_id": target, "status": "error",
            "result_size_bytes": 0, "latency_ms": 3, "error": "boom"
        })
    }

    #[tokio::test]
    async fn a_read_is_recorded_with_scopes_the_service_resolves() {
        let (pool, project, feature) = fixture().await;
        let source = session(&pool, feature).await;
        let other_project: i64 = sqlx::query_scalar(
            "INSERT INTO projects (name, path) VALUES ('Other', '/tmp/other') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let other_feature: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, 'Elsewhere') RETURNING id",
        )
        .bind(other_project)
        .fetch_one(&pool)
        .await
        .unwrap();
        let target = session(&pool, other_feature).await;
        let state = AppState::with_pool(pool.clone());
        let read = |tool| audit(feature, source, tool, target);

        let workspace = "/internal/mcp/workspace/read-audit";
        let project_route = "/internal/mcp/project/read-audit";
        assert_eq!(
            post(state.clone(), workspace, read("workspace_read_session"))
                .await
                .0,
            StatusCode::OK
        );
        // A write, or another server's tool, is not a read this route records.
        for tool in ["project_link_sessions", "workspace_read_session"] {
            assert_eq!(
                post(state.clone(), project_route, read(tool)).await.0,
                StatusCode::BAD_REQUEST
            );
        }

        let rows: Vec<(String, String, i64, i64, i64, String, String)> = sqlx::query_as(
            "SELECT server_name, tool_name, source_project_id, target_feature_id, target_project_id,
                    status, error FROM mcp_tool_audit_log",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            [(
                "cadencr-workspace".into(),
                "workspace_read_session".into(),
                project,
                other_feature,
                other_project,
                "error".into(),
                "boom".into()
            )]
        );
    }
}
