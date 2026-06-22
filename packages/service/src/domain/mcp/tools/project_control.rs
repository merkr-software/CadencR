use reqwest::Url;
use serde_json::json;

use crate::api::middleware::MCP_CONTROL_HEADER;
use crate::domain::mcp::context::McpContext;
use crate::domain::mcp::tools::helpers::require_i64;

const SERVICE_URL_ENV: &str = "CADENCR_SERVICE_URL";
const CONTROL_TOKEN_ENV: &str = "CADENCR_MCP_CONTROL_TOKEN";

#[derive(Debug, Clone)]
pub struct McpControlClient {
    client: reqwest::Client,
    service_url: Url,
    token: String,
}

impl McpControlClient {
    pub fn from_env() -> Result<Self, String> {
        Self::from_env_values(
            std::env::var(SERVICE_URL_ENV).ok(),
            std::env::var(CONTROL_TOKEN_ENV).ok(),
        )
    }

    pub fn from_env_values(
        service_url: Option<String>,
        token: Option<String>,
    ) -> Result<Self, String> {
        let service_url = service_url.ok_or_else(|| format!("{SERVICE_URL_ENV} is not set"))?;
        let token = token.ok_or_else(|| format!("{CONTROL_TOKEN_ENV} is not set"))?;
        if token.trim().is_empty() {
            return Err(format!("{CONTROL_TOKEN_ENV} must not be blank"));
        }
        let service_url = Url::parse(service_url.trim())
            .map_err(|e| format!("{SERVICE_URL_ENV} is invalid: {e}"))?;
        Ok(Self {
            client: reqwest::Client::new(),
            service_url,
            token,
        })
    }

    async fn post_json(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let url = self
            .service_url
            .join(path.trim_start_matches('/'))
            .map_err(|e| format!("Control endpoint URL is invalid: {e}"))?;
        let response = self
            .client
            .post(url)
            .header(MCP_CONTROL_HEADER, &self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Control endpoint request failed: {e}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("Control endpoint response read failed: {e}"))?;
        if !status.is_success() {
            return Err(format!("Control endpoint returned {status}: {text}"));
        }
        serde_json::from_str(&text)
            .map_err(|e| format!("Control endpoint response was invalid JSON: {e}"))
    }
}

pub async fn send_session_message(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    send_session_message_with_client(args, ctx, McpControlClient::from_env()?).await
}

pub async fn spawn_session(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    spawn_session_with_client(args, ctx, McpControlClient::from_env()?).await
}

pub async fn spawn_session_with_client(
    args: &serde_json::Value,
    ctx: &McpContext,
    client: McpControlClient,
) -> Result<serde_json::Value, String> {
    let source_session_id = ctx
        .source_session_id
        .ok_or_else(|| "project_spawn_session requires a source session id".to_string())?;
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
                "permission_mode": optional_string(args, "permission_mode"),
                "codex_permission_mode": optional_string(args, "codex_permission_mode"),
                "source_note": optional_string(args, "source_note"),
                "link_to_current_session": optional_bool(args, "link_to_current_session")
            }),
        )
        .await
}

pub async fn send_session_message_with_client(
    args: &serde_json::Value,
    ctx: &McpContext,
    client: McpControlClient,
) -> Result<serde_json::Value, String> {
    let source_session_id = ctx
        .source_session_id
        .ok_or_else(|| "project_send_session_message requires a source session id".to_string())?;
    let target_session_id = require_i64(args, "target_session_id")?;
    let message = args
        .get("message")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Missing required parameter: message".to_string())?;
    let source_note = args.get("source_note").and_then(serde_json::Value::as_str);
    let delivery = args.get("delivery").and_then(serde_json::Value::as_str);
    client
        .post_json(
            "/internal/mcp/project/send-message",
            json!({
                "source_feature_id": ctx.feature_id,
                "source_session_id": source_session_id,
                "target_session_id": target_session_id,
                "message": message,
                "delivery": delivery,
                "source_note": source_note,
                "link_to_current_session": optional_bool(args, "link_to_current_session")
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

    use super::{send_session_message_with_client, spawn_session_with_client, McpControlClient};

    #[tokio::test]
    async fn send_session_message_posts_source_context_to_control_plane() {
        let captured = Arc::new(Mutex::new(None));
        let url = spawn_send_message_route(captured.clone()).await;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let ctx = McpContext::new_with_source_session(pool.clone(), pool, 42, Some(777));
        let client = McpControlClient::from_env_values(Some(url), Some("secret".to_string()))
            .expect("control client");

        let result = send_session_message_with_client(
            &json!({
                "target_session_id": 888,
                "message": "Please verify provenance.",
                "source_note": "delegated by project MCP"
            }),
            &ctx,
            client,
        )
        .await
        .expect("send message result");

        assert_eq!(result["messageId"], 321);
        let request = captured.lock().await.take().expect("captured request");
        assert_eq!(request["source_feature_id"], 42);
        assert_eq!(request["source_session_id"], 777);
        assert_eq!(request["target_session_id"], 888);
        assert_eq!(request["message"], "Please verify provenance.");
        assert_eq!(request["source_note"], "delegated by project MCP");
    }

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
        let ctx = McpContext::new_with_source_session(pool.clone(), pool, 42, Some(777));
        let client = McpControlClient::from_env_values(Some(url), Some("secret".to_string()))
            .expect("control client");

        let result = spawn_session_with_client(
            &json!({
                "title": "Investigate flaky login test",
                "initial_message": "Please investigate and report findings.",
                "branch": { "mode": "none" },
                "provider": "codex_cli",
                "model": "openai/gpt-5.4",
                "permission_mode": "default",
                "codex_permission_mode": "auto_review",
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
    }

    async fn spawn_send_message_route(captured: Arc<Mutex<Option<serde_json::Value>>>) -> String {
        spawn_project_route(
            "/internal/mcp/project/send-message",
            json!({ "messageId": 321, "targetSessionId": 888 }),
            captured,
        )
        .await
    }

    async fn spawn_project_route(
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }
}
