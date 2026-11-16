use crate::app_state::AppState;
use crate::domain::mcp::settings_tool::SettingsTool;
use crate::error::AppError;
use axum::{
    extract::{Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

mod agent_providers;
mod archive_session;
pub(crate) mod audit;
mod create_schedule;
mod gate_envelope;
pub(crate) mod gate_notify;
pub(crate) mod gate_policy;
pub(crate) mod gate_respond;
mod generated_message;
mod link_sessions;
mod manage_schedule;
pub mod message_queue;
mod read_audit;
mod reply_audit;
mod reply_envelope;
pub(crate) mod reply_wait;
mod reply_wait_delivery;
mod requester_delivery;
mod schedule_scope;
mod scope;
mod send_message;
mod send_message_modes;
mod settings;
mod settings_policy;
pub mod side_question;
mod spawn_follow;
mod spawn_persist;
mod spawn_resolve;
mod spawn_session;
mod spawn_thinking;

pub(crate) use scope::is_active_db_state;

/// Trim a borrowed optional string, treating whitespace-only values as absent.
/// Shared by the spawn submodules (`spawn_session`, `spawn_resolve`, `spawn_persist`).
fn trimmed_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Debug, Deserialize)]
struct ProjectContextQuery {
    feature_id: i64,
    source_session_id: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct ProjectContextRow {
    project_id: i64,
    project_name: String,
    project_path: String,
    feature_id: i64,
    feature_title: String,
    source_session_id: i64,
    source_session_status: String,
}

#[derive(Debug, Serialize)]
struct ProjectContextResponse {
    project: IdNamePath,
    feature: IdTitle,
    #[serde(rename = "sourceSession")]
    source_session: IdStatus,
}

#[derive(Debug, Serialize)]
struct IdNamePath {
    id: i64,
    name: String,
    path: String,
}

#[derive(Debug, Serialize)]
struct IdTitle {
    id: i64,
    title: String,
}

#[derive(Debug, Serialize)]
struct IdStatus {
    id: i64,
    status: String,
}

pub fn control_router() -> Router<AppState> {
    Router::new()
        .route(
            "/internal/mcp/project/context",
            get(project_context_handler),
        )
        .route(
            "/internal/mcp/project/send-message",
            post(send_message::project_send_message_handler),
        )
        .route(
            "/internal/mcp/workspace/send-message",
            post(send_message::workspace_send_message_handler),
        )
        .route(
            "/internal/mcp/project/spawn-session",
            post(spawn_session::spawn_session_handler),
        )
        .route(
            "/internal/mcp/project/create-schedule",
            post(create_schedule::create_schedule_handler),
        )
        .route(
            "/internal/mcp/project/update-schedule",
            post(manage_schedule::update_schedule_handler),
        )
        .route(
            "/internal/mcp/project/delete-schedule",
            post(manage_schedule::delete_schedule_handler),
        )
        .route(
            "/internal/mcp/project/agent-providers",
            post(agent_providers::agent_providers_handler),
        )
        .route(
            "/internal/mcp/project/archive-session",
            post(archive_session::archive_session_handler),
        )
        .route(
            "/internal/mcp/project/link-sessions",
            post(link_sessions::link_sessions_handler),
        )
        .merge(read_audit::routes())
        .merge(settings_routes(SettingsTool::Project))
        .merge(settings_routes(SettingsTool::Workspace))
        .merge(gate_respond::routes())
}

fn settings_routes(tool: SettingsTool) -> Router<AppState> {
    Router::new()
        .route(
            tool.read_endpoint(),
            post(move |state, body| settings::read_handler(state, body, tool)),
        )
        .route(
            tool.update_endpoint(),
            post(move |state, body| settings::update_handler(state, body, tool)),
        )
}

async fn project_context_handler(
    State(state): State<AppState>,
    Query(query): Query<ProjectContextQuery>,
) -> Result<Json<ProjectContextResponse>, AppError> {
    let row: ProjectContextRow = sqlx::query_as(
        "SELECT p.id AS project_id, p.name AS project_name, p.path AS project_path,
                f.id AS feature_id, f.title AS feature_title,
                s.id AS source_session_id, s.status AS source_session_status
         FROM features f
         JOIN projects p ON p.id = f.project_id
         JOIN agent_sessions s ON s.feature_id = f.id
         WHERE f.id = ? AND s.id = ?",
    )
    .bind(query.feature_id)
    .bind(query.source_session_id)
    .fetch_optional(&state.read_pool)
    .await?
    .ok_or_else(|| AppError::NotFound("mcp project context".to_string()))?;
    Ok(Json(ProjectContextResponse::from(row)))
}

impl From<ProjectContextRow> for ProjectContextResponse {
    fn from(row: ProjectContextRow) -> Self {
        Self {
            project: IdNamePath {
                id: row.project_id,
                name: row.project_name,
                path: row.project_path,
            },
            feature: IdTitle {
                id: row.feature_id,
                title: row.feature_title,
            },
            source_session: IdStatus {
                id: row.source_session_id,
                status: row.source_session_status,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::api::middleware::MCP_CONTROL_HEADER;
    use crate::app_state::AppState;
    use axum::{body::Body, http::Request, http::StatusCode};
    use tower::ServiceExt;

    use super::control_router;

    #[tokio::test]
    async fn project_context_returns_source_scope_metadata() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
            CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL);
            CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, status TEXT NOT NULL);
            INSERT INTO projects (id, name, path) VALUES (7, 'Proj', '/tmp/proj');
            INSERT INTO features (id, project_id, title) VALUES (42, 7, 'Source feature');
            INSERT INTO agent_sessions (id, feature_id, status) VALUES (777, 42, 'running');
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let app = control_router().with_state(AppState::with_pool(pool));
        let request = Request::builder()
            .uri("/internal/mcp/project/context?feature_id=42&source_session_id=777")
            .header(MCP_CONTROL_HEADER, "test-mcp-token")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["project"]["id"], 7);
        assert_eq!(body["feature"]["id"], 42);
        assert_eq!(body["sourceSession"]["id"], 777);
    }
}
