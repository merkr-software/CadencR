use serde_json::json;

use crate::domain::mcp::context::McpContext;
pub(crate) use crate::domain::mcp::control_client::McpControlClient;
use crate::domain::mcp::tools::helpers::require_i64;

mod agent_providers;
mod archive_session;
mod create_schedule;
mod link_sessions;
mod manage_schedule;
mod send_message;
mod settings;

pub(crate) use agent_providers::list_agent_providers;
pub(crate) use archive_session::archive_session;
pub(crate) use create_schedule::create_schedule;
pub(crate) use link_sessions::link_sessions;
pub(crate) use manage_schedule::{delete_schedule, update_schedule};
pub(crate) use send_message::{send_session_message, send_workspace_session_message};
pub(crate) use settings::{get_settings, update_settings};

pub async fn spawn_session(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    spawn_session_with_client(args, ctx, ctx.control()?.clone()).await
}

pub async fn list_pending_gates(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    let source_session_id = require_source_session(ctx, "project_list_pending_gates")?;
    let session_id = require_i64(args, "session_id")?;
    ctx.control()?
        .post_json(
            "/internal/mcp/project/pending-gates",
            json!({"source_session_id": source_session_id, "session_id": session_id}),
        )
        .await
}

pub async fn respond_gate(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    let source_session_id = require_source_session(ctx, "project_respond_gate")?;
    let session_id = require_i64(args, "session_id")?;
    let request_id = args
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Missing required parameter: request_id".to_string())?;
    let decision = args
        .get("decision")
        .cloned()
        .ok_or_else(|| "Missing required parameter: decision".to_string())?;
    ctx.control()?
        .post_json(
            "/internal/mcp/project/respond-gate",
            json!({
                "source_session_id": source_session_id,
                "session_id": session_id,
                "request_id": request_id,
                "decision": decision
            }),
        )
        .await
}

pub(crate) fn require_source_session(ctx: &McpContext, tool: &str) -> Result<i64, String> {
    ctx.source_session_id
        .ok_or_else(|| format!("{tool} requires a source session id"))
}

/// The caller's identity every control request starts from.
fn source_request(ctx: &McpContext, tool: &str) -> Result<serde_json::Value, String> {
    let source_session_id = require_source_session(ctx, tool)?;
    Ok(json!({
        "source_feature_id": ctx.feature_id,
        "source_session_id": source_session_id,
    }))
}

/// Copy the optional `fields` the agent passed, as it sent them: the service's
/// typed request rejects a wrong type instead of reading it as absent.
fn relay_fields(args: &serde_json::Value, request: &mut serde_json::Value, fields: &[&str]) {
    for field in fields {
        if let Some(value) = args.get(*field) {
            request[*field] = value.clone();
        }
    }
}

pub async fn spawn_session_with_client(
    args: &serde_json::Value,
    ctx: &McpContext,
    client: McpControlClient,
) -> Result<serde_json::Value, String> {
    let source_session_id = require_source_session(ctx, "project_spawn_session")?;
    client
        .post_json(
            "/internal/mcp/project/spawn-session",
            json!({
                "source_feature_id": ctx.feature_id,
                "source_session_id": source_session_id,
                "title": optional_string(args, "title"),
                "initial_message": optional_string(args, "initial_message"),
                "branch": args.get("branch").cloned().unwrap_or_else(|| json!({})),
                "provider": optional_string(args, "provider"),
                "model": optional_string(args, "model"),
                "thinking_level": optional_string(args, "thinking_level"),
                "permission_mode": optional_string(args, "permission_mode"),
                "codex_permission_mode": optional_string(args, "codex_permission_mode"),
                "source_note": optional_string(args, "source_note"),
                "follow": args.get("follow").cloned(),
                "link_to_current_session": optional_bool(args, "link_to_current_session"),
                "await_result": optional_bool(args, "await_result"),
                "target_project_id": optional_i64(args, "project_id"),
                "target_project_path": optional_string(args, "project_path")
            }),
        )
        .await
}

fn optional_string(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn optional_bool(args: &serde_json::Value, key: &str) -> Option<bool> {
    args.get(key).and_then(serde_json::Value::as_bool)
}

fn optional_i64(args: &serde_json::Value, key: &str) -> Option<i64> {
    args.get(key).and_then(serde_json::Value::as_i64)
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::Arc;

    use axum::{
        extract::State, http::HeaderMap, response::IntoResponse, routing::post, Json, Router,
    };
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;

    use crate::api::middleware::MCP_CONTROL_HEADER;
    use crate::domain::mcp::context::McpContext;

    use super::{spawn_session_with_client, McpControlClient};

    #[tokio::test]
    async fn spawn_session_posts_source_context_to_control_plane() {
        let captured = Arc::new(Mutex::new(None));
        let url = spawn_project_route(
            "/internal/mcp/project/spawn-session",
            json!({ "featureId": 43, "sessionId": 888, "messageId": 999 }),
            captured.clone(),
        )
        .await;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let ctx = std::sync::Arc::new(
            McpContext::builder()
                .read_pool(pool)
                .feature_id(42)
                .source_session_id(777)
                .build(),
        );
        let client = McpControlClient::from_env_values(Some(url), Some("secret".to_string()))
            .expect("control client");

        let result = spawn_session_with_client(
            &json!({
                "title": "Investigate flaky login test",
                "initial_message": "Please investigate and report findings.",
                "branch": { "mode": "none" },
                "provider": "codex_cli",
                "model": "openai/gpt-5.4",
                "thinking_level": "high",
                "permission_mode": "default",
                "codex_permission_mode": "auto_review",
                "follow": { "gates": true, "completion": true },
                "source_note": "delegated by project MCP"
            }),
            &ctx,
            client,
        )
        .await
        .expect("spawn result");

        assert_eq!(result["featureId"], 43);
        let request = captured.lock().await.take().expect("captured request");
        assert_eq!(request["source_feature_id"], 42);
        assert_eq!(request["source_session_id"], 777);
        assert_eq!(request["title"], "Investigate flaky login test");
        assert_eq!(
            request["initial_message"],
            "Please investigate and report findings."
        );
        assert_eq!(request["branch"]["mode"], "none");
        assert_eq!(request["thinking_level"], "high");
        assert_eq!(request["follow"]["completion"], true);
        assert!(request["target_project_id"].is_null());
        assert!(request["target_project_path"].is_null());
    }

    #[tokio::test]
    async fn spawn_session_forwards_target_project_selectors() {
        let captured = Arc::new(Mutex::new(None));
        let url = spawn_project_route(
            "/internal/mcp/project/spawn-session",
            json!({ "featureId": 51, "sessionId": 900, "crossProject": true }),
            captured.clone(),
        )
        .await;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let ctx = std::sync::Arc::new(
            McpContext::builder()
                .read_pool(pool)
                .feature_id(42)
                .source_session_id(777)
                .build(),
        );
        let client = McpControlClient::from_env_values(Some(url), Some("secret".to_string()))
            .expect("control client");

        spawn_session_with_client(
            &json!({
                "title": "Ship the shared API change",
                "project_id": 9,
                "project_path": "/repos/api"
            }),
            &ctx,
            client,
        )
        .await
        .expect("spawn result");

        let request = captured.lock().await.take().expect("captured request");
        assert_eq!(request["target_project_id"], 9);
        assert_eq!(request["target_project_path"], "/repos/api");
    }

    pub(super) async fn spawn_project_route(
        path: &'static str,
        response: serde_json::Value,
        captured: Arc<Mutex<Option<serde_json::Value>>>,
    ) -> String {
        async fn spawn_handler(
            State((captured, response)): State<(
                Arc<Mutex<Option<serde_json::Value>>>,
                serde_json::Value,
            )>,
            headers: HeaderMap,
            Json(body): Json<serde_json::Value>,
        ) -> impl IntoResponse {
            assert_eq!(headers.get(MCP_CONTROL_HEADER).unwrap(), "secret");
            *captured.lock().await = Some(body);
            Json(response)
        }
        let app = Router::new()
            .route(path, post(spawn_handler))
            .with_state((captured, response));
        spawn_router(app).await
    }

    async fn spawn_router(app: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }
}
