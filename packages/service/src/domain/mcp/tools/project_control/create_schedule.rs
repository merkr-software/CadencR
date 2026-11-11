use serde_json::json;

use super::{optional_string, require_source_session, McpContext, McpControlClient};

/// Relay `project_create_schedule` to the service, which owns the write and
/// the broadcast that makes the new schedule appear in open windows. The
/// subprocess could insert the row itself, but nothing would tell the UI.
pub(crate) async fn create_schedule(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    create_schedule_with_client(args, ctx, ctx.control()?.clone()).await
}

async fn create_schedule_with_client(
    args: &serde_json::Value,
    ctx: &McpContext,
    client: McpControlClient,
) -> Result<serde_json::Value, String> {
    let source_session_id = require_source_session(ctx, "project_create_schedule")?;
    let prompt = optional_string(args, "prompt")
        .filter(|prompt| !prompt.trim().is_empty())
        .ok_or_else(|| "Missing required parameter: prompt".to_string())?;
    let recurrence = args
        .get("recurrence")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| "Missing required parameter: recurrence".to_string())?;
    client
        .post_json(
            "/internal/mcp/project/create-schedule",
            json!({
                "source_feature_id": ctx.feature_id,
                "source_session_id": source_session_id,
                "name": optional_string(args, "name"),
                "prompt": prompt,
                "recurrence": recurrence,
                "condition": args.get("condition").cloned(),
                "model": optional_string(args, "model"),
                "thinking_level": optional_string(args, "thinking_level"),
                "permission_mode": optional_string(args, "permission_mode"),
            }),
        )
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

    use super::{create_schedule_with_client, McpControlClient};
    use crate::domain::mcp::context::McpContext;

    async fn context() -> Arc<McpContext> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        std::sync::Arc::new(
            McpContext::builder()
                .read_pool(pool)
                .feature_id(42)
                .source_session_id(777)
                .build(),
        )
    }

    #[tokio::test]
    async fn the_calling_conversation_and_the_full_rule_reach_the_control_plane() {
        let captured = Arc::new(Mutex::new(None));
        let app = Router::new()
            .route(
                "/internal/mcp/project/create-schedule",
                post(
                    |State(captured): State<Arc<Mutex<Option<serde_json::Value>>>>,
                     Json(body): Json<serde_json::Value>| async move {
                        *captured.lock().await = Some(body);
                        Json(json!({ "id": 5 }))
                    },
                ),
            )
            .with_state(captured.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = McpControlClient::from_env_values(Some(url), Some("secret".into())).unwrap();

        let result = create_schedule_with_client(
            &json!({
                "prompt": "Fix the build.",
                "recurrence": { "kind": "interval", "interval_seconds": 600 },
                "condition": { "command": "pnpm build" },
                "model": "haiku"
            }),
            &*context().await,
            client,
        )
        .await
        .unwrap();

        assert_eq!(result["id"], 5);
        let request = captured.lock().await.take().unwrap();
        assert_eq!(request["source_feature_id"], 42);
        assert_eq!(request["source_session_id"], 777);
        assert_eq!(request["recurrence"]["interval_seconds"], 600);
        assert_eq!(request["condition"]["command"], "pnpm build");
        assert_eq!(request["model"], "haiku");
        assert!(request["name"].is_null());
    }

    #[tokio::test]
    async fn a_missing_prompt_or_rule_is_refused_before_any_request() {
        let client =
            McpControlClient::from_env_values(Some("http://127.0.0.1:9".into()), Some("s".into()))
                .unwrap();
        let ctx = context().await;
        let ctx = &*ctx;
        let error = create_schedule_with_client(
            &json!({ "recurrence": { "kind": "once" } }),
            ctx,
            client.clone(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("prompt"), "{error}");
        let error = create_schedule_with_client(&json!({ "prompt": "p" }), ctx, client)
            .await
            .unwrap_err();
        assert!(error.contains("recurrence"), "{error}");
    }
}
