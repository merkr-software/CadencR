use serde_json::json;

use super::{
    relay_fields, require_i64, require_source_session, source_request, McpContext, McpControlClient,
};

/// The fields `project_update_schedule` may patch; an absent one keeps the
/// stored value.
const PATCH_FIELDS: [&str; 9] = [
    "name",
    "prompt",
    "recurrence",
    "condition",
    "remove_condition",
    "enabled",
    "model",
    "thinking_level",
    "permission_mode",
];

/// Relay `project_update_schedule` to the service. Like creation, the write
/// has to happen there: it owns the broadcast that refreshes open windows.
pub(crate) async fn update_schedule(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    update_schedule_with_client(args, ctx, ctx.control()?.clone()).await
}

pub(crate) async fn delete_schedule(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    delete_schedule_with_client(args, ctx, ctx.control()?.clone()).await
}

async fn update_schedule_with_client(
    args: &serde_json::Value,
    ctx: &McpContext,
    client: McpControlClient,
) -> Result<serde_json::Value, String> {
    let mut request = source_request(ctx, "project_update_schedule")?;
    request["schedule_id"] = json!(require_i64(args, "schedule_id")?);
    relay_fields(args, &mut request, &PATCH_FIELDS);
    client
        .post_json("/internal/mcp/project/update-schedule", request)
        .await
}

async fn delete_schedule_with_client(
    args: &serde_json::Value,
    ctx: &McpContext,
    client: McpControlClient,
) -> Result<serde_json::Value, String> {
    let source_session_id = require_source_session(ctx, "project_delete_schedule")?;
    let schedule_id = require_i64(args, "schedule_id")?;
    client
        .post_json(
            "/internal/mcp/project/delete-schedule",
            json!({
                "source_feature_id": ctx.feature_id,
                "source_session_id": source_session_id,
                "schedule_id": schedule_id,
            }),
        )
        .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use tokio::sync::Mutex;

    use super::super::tests::spawn_project_route;
    use super::{delete_schedule_with_client, update_schedule_with_client, McpControlClient};
    use crate::domain::mcp::context::McpContext;

    type Captured = Arc<Mutex<Option<serde_json::Value>>>;

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

    async fn control_plane(path: &'static str, captured: Captured) -> McpControlClient {
        let url = spawn_project_route(path, json!({ "id": 5 }), captured).await;
        McpControlClient::from_env_values(Some(url), Some("secret".into())).unwrap()
    }

    #[tokio::test]
    async fn an_update_relays_only_the_fields_the_agent_passed() {
        let captured = Captured::default();
        let client = control_plane("/internal/mcp/project/update-schedule", captured.clone()).await;

        update_schedule_with_client(
            &json!({
                "schedule_id": 5,
                "recurrence": { "kind": "interval", "interval_seconds": 1800 },
                "remove_condition": true,
                "enabled": false,
                "model": 0
            }),
            &*context().await,
            client,
        )
        .await
        .unwrap();

        let request = captured.lock().await.take().unwrap();
        assert_eq!(request["source_feature_id"], 42);
        assert_eq!(request["source_session_id"], 777);
        assert_eq!(request["schedule_id"], 5);
        assert_eq!(request["recurrence"]["interval_seconds"], 1800);
        assert_eq!(request["remove_condition"], true);
        assert_eq!(request["enabled"], false);
        // A wrong type goes through for the service to refuse, rather than
        // being dropped and read as "keep the stored model".
        assert_eq!(request["model"], 0);
        assert!(request.get("prompt").is_none(), "{request}");
        assert!(request.get("condition").is_none(), "{request}");
    }

    #[tokio::test]
    async fn a_delete_names_the_calling_conversation_and_the_schedule() {
        let captured = Captured::default();
        let client = control_plane("/internal/mcp/project/delete-schedule", captured.clone()).await;

        delete_schedule_with_client(&json!({ "schedule_id": 5 }), &*context().await, client)
            .await
            .unwrap();

        let request = captured.lock().await.take().unwrap();
        assert_eq!(request["source_feature_id"], 42);
        assert_eq!(request["source_session_id"], 777);
        assert_eq!(request["schedule_id"], 5);
    }

    #[tokio::test]
    async fn a_missing_schedule_id_is_refused_before_any_request() {
        let client =
            McpControlClient::from_env_values(Some("http://127.0.0.1:9".into()), Some("s".into()))
                .unwrap();
        let ctx = context().await;
        let error = update_schedule_with_client(&json!({ "enabled": false }), &ctx, client.clone())
            .await
            .unwrap_err();
        assert!(error.contains("schedule_id"), "{error}");
        let error = delete_schedule_with_client(&json!({}), &ctx, client)
            .await
            .unwrap_err();
        assert!(error.contains("schedule_id"), "{error}");
    }
}
