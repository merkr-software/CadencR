use super::{source_request, McpContext, McpControlClient};

/// Where the service answers `project_list_agent_providers`.
pub(crate) const AGENT_PROVIDERS_ENDPOINT: &str = "/internal/mcp/project/agent-providers";

/// Relay `project_list_agent_providers` to the service. This subprocess has
/// neither the service's catalog caches nor the CLI paths chosen in settings,
/// so a catalog probed here could disagree with the picker (another CLI, no
/// `refresh_error` for a catalog the service serves as the last known one).
pub(crate) async fn list_agent_providers(ctx: &McpContext) -> Result<serde_json::Value, String> {
    list_agent_providers_with_client(ctx, McpControlClient::from_env()?).await
}

async fn list_agent_providers_with_client(
    ctx: &McpContext,
    client: McpControlClient,
) -> Result<serde_json::Value, String> {
    let request = source_request(ctx, "project_list_agent_providers")?;
    client
        .post_json_idempotent(AGENT_PROVIDERS_ENDPOINT, request)
        .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{extract::State, routing::post, Json, Router};
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;

    use super::{list_agent_providers_with_client, McpControlClient, AGENT_PROVIDERS_ENDPOINT};
    use crate::domain::mcp::context::McpContext;

    #[tokio::test]
    async fn the_service_answers_for_the_callers_session() {
        let captured = Arc::new(Mutex::new(None));
        let app = Router::new()
            .route(
                AGENT_PROVIDERS_ENDPOINT,
                post(
                    |State(captured): State<Arc<Mutex<Option<serde_json::Value>>>>,
                     Json(body): Json<serde_json::Value>| async move {
                        *captured.lock().await = Some(body);
                        Json(json!({ "providers": [{ "id": "codex_cli", "refresh_error": "boom" }] }))
                    },
                ),
            )
            .with_state(captured.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = McpControlClient::from_env_values(Some(url), Some("secret".into())).unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let ctx = McpContext::new_with_source_session(pool.clone(), pool, 42, Some(777));

        let result = list_agent_providers_with_client(&ctx, client)
            .await
            .unwrap();

        assert_eq!(result["providers"][0]["refresh_error"], "boom");
        let request = captured.lock().await.take().unwrap();
        assert_eq!(
            request,
            json!({ "source_feature_id": 42, "source_session_id": 777 })
        );
    }
}
