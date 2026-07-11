use crate::app_state::AppState;
use crate::error::AppError;
use axum::{
    extract::{Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
mod audit;
mod gate_envelope;
pub(crate) mod gate_notify;
mod gate_policy;
mod gate_respond;
pub(crate) mod message_queue;
mod reply_audit;
mod reply_envelope;
pub(crate) mod reply_wait;
mod requester_delivery;
mod scope;
mod send_message;
mod spawn_persist;
mod spawn_resolve;
mod spawn_session;
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
            post(send_message::send_message_handler),
        )
        .route(
            "/internal/mcp/project/spawn-session",
            post(spawn_session::spawn_session_handler),
        )
        .merge(gate_respond::routes())
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
    use axum::{body::Body, http::Request, http::StatusCode};
    use tower::ServiceExt;

    use crate::api::middleware::MCP_CONTROL_HEADER;
    use crate::app_state::AppState;

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
        let state = AppState::with_pool(pool);
        let app = control_router().with_state(state);
        let req = Request::builder()
            .uri("/internal/mcp/project/context?feature_id=42&source_session_id=777")
            .header(MCP_CONTROL_HEADER, "test-mcp-token")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(req).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["project"]["id"], 7);
        assert_eq!(body["feature"]["id"], 42);
        assert_eq!(body["sourceSession"]["id"], 777);
    }

    #[tokio::test]
    async fn send_message_persists_generated_message_origin_and_link() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        seed_send_message_schema(&pool, "paused").await;
        let state = AppState::with_pool(pool.clone());
        let app = control_router().with_state(state);
        let body = serde_json::json!({
            "source_feature_id": 42,
            "source_session_id": 777,
            "target_session_id": 888,
            "message": "Please verify the migration provenance path.",
            "source_note": "delegated by project MCP"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/internal/mcp/project/send-message")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();

        let response = app.oneshot(req).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let message_id: i64 = sqlx::query_scalar(
            "SELECT id FROM agent_messages WHERE session_id = 888 AND role = 'user'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let message: (String, String, String) =
            sqlx::query_as("SELECT role, message_type, content FROM agent_messages WHERE id = ?")
                .bind(message_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            message,
            (
                "user".into(),
                "user_message".into(),
                "Please verify the migration provenance path.".into()
            )
        );
        let origin: (String, i64, i64, i64, String) = sqlx::query_as(
            "SELECT origin_kind, source_session_id, source_feature_id, source_project_id, note FROM agent_message_origins WHERE message_id = ?",
        )
        .bind(message_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            origin,
            (
                "session_generated".into(),
                777,
                42,
                7,
                "delegated by project MCP".into()
            )
        );
        let link: (i64, i64, String) = sqlx::query_as(
            "SELECT source_session_id, target_session_id, link_type FROM agent_session_links",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(link, (777, 888, "messaged".into()));
        let audit: (String, i64, i64, i64, i64, String) = sqlx::query_as(
            "SELECT tool_name, source_session_id, source_feature_id, source_project_id, target_session_id, status
             FROM mcp_tool_audit_log
             WHERE tool_name = 'project_send_session_message'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            audit,
            (
                "project_send_session_message".into(),
                777,
                42,
                7,
                888,
                "ok".into()
            )
        );
    }

    #[tokio::test]
    async fn send_message_queue_if_busy_persists_queue_item_without_user_message() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        seed_send_message_schema(&pool, "running").await;
        let state = AppState::with_pool(pool.clone());
        let app = control_router().with_state(state);
        let body = serde_json::json!({
            "source_feature_id": 42,
            "source_session_id": 777,
            "target_session_id": 888,
            "message": "Please queue while busy.",
            "delivery": "queue_if_busy",
            "source_note": "delegated by project MCP"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/internal/mcp/project/send-message")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();

        let response = app.oneshot(req).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let queue_id = body["queueId"].as_i64().expect("queue id");
        let queued: (i64, i64, String, String) = sqlx::query_as(
            "SELECT target_session_id, source_session_id, content, status
             FROM agent_session_message_queue WHERE id = ?",
        )
        .bind(queue_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            queued,
            (
                888,
                777,
                "Please queue while busy.".into(),
                "pending".into()
            )
        );
        let message_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 888")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(message_count, 0);
    }

    #[tokio::test]
    async fn send_message_rejects_targets_awaiting_user_resolution_without_persisting() {
        for target_status in ["awaiting_permission", "awaiting_question"] {
            let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
            seed_send_message_schema(&pool, target_status).await;
            let app = control_router().with_state(AppState::with_pool(pool.clone()));
            let body = serde_json::json!({
                "source_feature_id": 42,
                "source_session_id": 777,
                "target_session_id": 888,
                "message": "Please continue once user resolution is complete.",
                "delivery": "send_now"
            });
            let req = Request::builder()
                .method("POST")
                .uri("/internal/mcp/project/send-message")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();

            let response = app.oneshot(req).await.unwrap();

            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let message_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 888")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(message_count, 0);
        }
    }

    #[tokio::test]
    async fn send_message_rejects_unknown_delivery_without_persisting() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        seed_send_message_schema(&pool, "paused").await;
        let app = control_router().with_state(AppState::with_pool(pool.clone()));
        let body = serde_json::json!({
            "source_feature_id": 42,
            "source_session_id": 777,
            "target_session_id": 888,
            "message": "Please do not silently send this.",
            "delivery": "teleport"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/internal/mcp/project/send-message")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();

        let response = app.oneshot(req).await.unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let message_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 888")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(message_count, 0);
    }

    async fn seed_send_message_schema(pool: &sqlx::SqlitePool, target_status: &'static str) {
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"
            CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
            CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL);
            CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, status TEXT NOT NULL, runtime_provider TEXT, runtime_session_id TEXT, model TEXT, profile TEXT, permission_mode TEXT, codex_permission_mode TEXT DEFAULT 'default', pending_permission TEXT, pending_questions TEXT, input_tokens INTEGER, output_tokens INTEGER, context_window INTEGER, thinking_effort TEXT);
            CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, message_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE agent_message_origins (message_id INTEGER PRIMARY KEY, origin_kind TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, source_message_id INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE agent_session_links (id INTEGER PRIMARY KEY AUTOINCREMENT, source_session_id INTEGER NOT NULL, target_session_id INTEGER NOT NULL, link_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), note TEXT);
            CREATE TABLE agent_session_message_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, target_session_id INTEGER NOT NULL, source_session_id INTEGER, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT, error TEXT);
            CREATE TABLE mcp_tool_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT NOT NULL, tool_name TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, target_session_id INTEGER, target_feature_id INTEGER, target_project_id INTEGER, status TEXT NOT NULL, result_size_bytes INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
            INSERT INTO projects (id, name, path) VALUES (7, 'Proj', '/tmp/proj');
            INSERT INTO features (id, project_id, title) VALUES (42, 7, 'Source'), (43, 7, 'Target');
            INSERT INTO agent_sessions (id, feature_id, status, runtime_provider, model)
            VALUES (777, 42, 'running', NULL, NULL), (888, 43, '{target_status}', 'missing_provider', 'missing-model');
            "#
        )))
        .execute(pool)
        .await
        .unwrap();
    }
}
