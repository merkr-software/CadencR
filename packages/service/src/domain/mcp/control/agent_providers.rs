//! `project_list_agent_providers`, answered by the service: its catalog
//! caches (last known catalogs and their `refresh_error` included) and the CLI
//! paths chosen in settings are what the picker shows, and the MCP subprocess
//! has neither.

use axum::{extract::State, Json};
use serde::Deserialize;

use super::scope::resolve_session_scope;
use crate::app_state::AppState;
use crate::domain::mcp::tools::project_providers::agent_providers_doc;
use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub(super) struct AgentProvidersRequest {
    source_session_id: i64,
}

/// The providers of the caller's project, read at the project path.
pub(super) async fn agent_providers_handler(
    State(state): State<AppState>,
    Json(body): Json<AgentProvidersRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let source = resolve_session_scope(&state.read_pool, body.source_session_id).await?;
    let project_path: String = sqlx::query_scalar("SELECT path FROM projects WHERE id = ?")
        .bind(source.project_id)
        .fetch_optional(&state.read_pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("project {}", source.project_id)))?;
    Ok(Json(
        agent_providers_doc(&state.read_pool, std::path::Path::new(&project_path)).await,
    ))
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request, http::StatusCode};
    use tower::ServiceExt;

    use crate::app_state::AppState;
    use crate::domain::mcp::control::control_router;

    #[tokio::test]
    async fn an_unknown_source_session_is_not_found_before_any_probe() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
            CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL);
            CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, status TEXT NOT NULL,
                pending_permission TEXT, pending_questions TEXT);
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let app = control_router().with_state(AppState::with_pool(pool));
        let request = Request::builder()
            .method("POST")
            .uri("/internal/mcp/project/agent-providers")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"source_feature_id":42,"source_session_id":777}"#,
            ))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
