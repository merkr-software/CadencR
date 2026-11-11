use serde_json::json;

use super::{optional_bool, optional_string, require_source_session, McpContext, McpControlClient};
use crate::domain::mcp::send_message_tool::SendMessageTool;

pub(crate) async fn send_session_message(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    send_session_message_with_client(args, ctx, ctx.control()?.clone(), SendMessageTool::Project)
        .await
}

pub(crate) async fn send_workspace_session_message(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    send_session_message_with_client(
        args,
        ctx,
        ctx.control()?.clone(),
        SendMessageTool::Workspace,
    )
    .await
}

async fn send_session_message_with_client(
    args: &serde_json::Value,
    ctx: &McpContext,
    client: McpControlClient,
    tool: SendMessageTool,
) -> Result<serde_json::Value, String> {
    let source_session_id = require_source_session(ctx, tool.tool_name())?;
    let target_session_id =
        crate::domain::mcp::tools::helpers::require_i64(args, "target_session_id")?;
    let message = args
        .get("message")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Missing required parameter: message".to_string())?;
    let source_note = args.get("source_note").and_then(serde_json::Value::as_str);
    let delivery = args.get("delivery").and_then(serde_json::Value::as_str);
    let reply = args.get("reply").and_then(serde_json::Value::as_str);
    client
        .post_json_idempotent(
            tool.endpoint(),
            json!({
                "source_feature_id": ctx.feature_id,
                "source_session_id": source_session_id,
                "target_session_id": target_session_id,
                "message": message,
                "message_uuid": optional_string(args, "message_uuid")
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                "delivery": delivery,
                "reply": reply,
                "source_note": source_note,
                "link_to_current_session": optional_bool(args, "link_to_current_session")
            }),
        )
        .await
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::post,
        Json, Router,
    };
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;

    use crate::api::middleware::MCP_CONTROL_HEADER;
    use crate::domain::mcp::context::McpContext;
    use crate::domain::mcp::send_message_tool::SendMessageTool;

    use super::{send_session_message_with_client, McpControlClient};

    #[tokio::test]
    async fn project_message_posts_source_context_to_control_plane() {
        let captured = Arc::new(Mutex::new(None));
        let url = spawn_route(
            "/internal/mcp/project/send-message",
            json!({ "messageId": 321, "targetSessionId": 888 }),
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

        let message_uuid = uuid::Uuid::new_v4().to_string();
        let result = send_session_message_with_client(
            &json!({
                "target_session_id": 888,
                "message": "Please verify provenance.",
                "source_note": "delegated by project MCP",
                "message_uuid": message_uuid
            }),
            &ctx,
            client,
            SendMessageTool::Project,
        )
        .await
        .expect("send message result");

        assert_eq!(result["messageId"], 321);
        let request = captured.lock().await.take().expect("captured request");
        assert_eq!(request["source_feature_id"], 42);
        assert_eq!(request["source_session_id"], 777);
        assert_eq!(request["target_session_id"], 888);
        assert_eq!(request["message"], "Please verify provenance.");
        assert_eq!(request["message_uuid"], message_uuid);
        assert_eq!(request["source_note"], "delegated by project MCP");
        assert!(request["delivery"].is_null());
    }

    #[tokio::test]
    async fn workspace_message_posts_to_workspace_control_endpoint() {
        let captured = Arc::new(Mutex::new(None));
        let url = spawn_route(
            "/internal/mcp/workspace/send-message",
            json!({ "messageId": 654, "targetSessionId": 999 }),
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

        let result = send_session_message_with_client(
            &json!({
                "target_session_id": 999,
                "message": "Correct the cross-project worker."
            }),
            &ctx,
            client,
            SendMessageTool::Workspace,
        )
        .await
        .expect("workspace send result");

        assert_eq!(result["messageId"], 654);
        let request = captured.lock().await.take().expect("captured request");
        assert_eq!(request["source_feature_id"], 42);
        assert_eq!(request["source_session_id"], 777);
        assert_eq!(request["target_session_id"], 999);
        assert_eq!(request["message"], "Correct the cross-project worker.");
    }

    #[tokio::test]
    async fn idempotent_post_does_not_retry_permanent_client_errors() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_handler = attempts.clone();
        let app = Router::new().route(
            "/internal/mcp/project/send-message",
            post(move || {
                let attempts = attempts_for_handler.clone();
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::BAD_REQUEST, "invalid request")
                }
            }),
        );
        let url = spawn_router(app).await;
        let client = McpControlClient::from_env_values(Some(url), Some("secret".to_string()))
            .expect("control client");

        let error = client
            .post_json_idempotent("/internal/mcp/project/send-message", json!({}))
            .await
            .unwrap_err();

        assert!(error.contains("400 Bad Request"));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn transient_retry_reuses_one_generated_message_uuid() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route(
                "/internal/mcp/project/send-message",
                post(
                    |State((attempts, bodies)): State<(
                        Arc<AtomicUsize>,
                        Arc<Mutex<Vec<serde_json::Value>>>,
                    )>,
                     headers: HeaderMap,
                     Json(body): Json<serde_json::Value>| async move {
                        assert_eq!(
                            headers
                                .get(MCP_CONTROL_HEADER)
                                .and_then(|v| v.to_str().ok()),
                            Some("secret")
                        );
                        bodies.lock().await.push(body);
                        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                            (
                                StatusCode::SERVICE_UNAVAILABLE,
                                Json(json!({"error": "retry"})),
                            )
                        } else {
                            (
                                StatusCode::OK,
                                Json(json!({"messageId": 1, "targetSessionId": 888})),
                            )
                        }
                    },
                ),
            )
            .with_state((attempts.clone(), bodies.clone()));
        let url = spawn_router(app).await;
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

        send_session_message_with_client(
            &json!({"target_session_id": 888, "message": "retry safely"}),
            &ctx,
            client,
            SendMessageTool::Project,
        )
        .await
        .unwrap();

        let bodies = bodies.lock().await;
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0]["message_uuid"], bodies[1]["message_uuid"]);
    }

    async fn spawn_route(
        path: &'static str,
        response: serde_json::Value,
        captured: Arc<Mutex<Option<serde_json::Value>>>,
    ) -> String {
        async fn handler(
            State((response, captured)): State<(
                serde_json::Value,
                Arc<Mutex<Option<serde_json::Value>>>,
            )>,
            headers: HeaderMap,
            Json(body): Json<serde_json::Value>,
        ) -> (StatusCode, Json<serde_json::Value>) {
            assert_eq!(
                headers
                    .get(MCP_CONTROL_HEADER)
                    .and_then(|v| v.to_str().ok()),
                Some("secret")
            );
            *captured.lock().await = Some(body);
            (StatusCode::OK, Json(response))
        }
        spawn_router(
            Router::new()
                .route(path, post(handler))
                .with_state((response, captured)),
        )
        .await
    }

    async fn spawn_router(app: Router) -> String {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }
}
