use serde_json::{json, Value};

use super::{relay_fields, source_request, McpContext, McpControlClient};
use crate::domain::mcp::settings_tool::SettingsTool;

/// Relay `*_get_settings` to the service, which owns the settings directory
/// the app actually reads (this subprocess only derives one from the DB path).
pub(crate) async fn get_settings(
    args: &Value,
    ctx: &McpContext,
    tool: SettingsTool,
) -> Result<Value, String> {
    get_settings_with_client(args, ctx, tool, ctx.control()?.clone()).await
}

/// Relay `*_update_settings` to the service, which validates every value,
/// writes the document atomically and refreshes open windows.
pub(crate) async fn update_settings(
    args: &Value,
    ctx: &McpContext,
    tool: SettingsTool,
) -> Result<Value, String> {
    update_settings_with_client(args, ctx, tool, ctx.control()?.clone()).await
}

async fn get_settings_with_client(
    args: &Value,
    ctx: &McpContext,
    tool: SettingsTool,
    client: McpControlClient,
) -> Result<Value, String> {
    let mut request = source_request(ctx, tool.get_tool_name())?;
    request["scope"] = args
        .get("scope")
        .cloned()
        .unwrap_or_else(|| json!(tool.default_read_scope()));
    relay_fields(args, &mut request, &["keys", "include_catalog"]);
    relay_target_project(args, &mut request, tool);
    client
        .post_json_idempotent(tool.read_endpoint(), request)
        .await
}

/// Not retried: a write whose response was lost has already landed, and a
/// retry would report the new values as the previous ones.
async fn update_settings_with_client(
    args: &Value,
    ctx: &McpContext,
    tool: SettingsTool,
    client: McpControlClient,
) -> Result<Value, String> {
    let mut request = source_request(ctx, tool.update_tool_name())?;
    relay_fields(args, &mut request, &["scope", "values"]);
    relay_target_project(args, &mut request, tool);
    client.post_json(tool.update_endpoint(), request).await
}

/// Only workspace tools name a project; project tools always mean their own.
fn relay_target_project(args: &Value, request: &mut Value, tool: SettingsTool) {
    if tool.allows_cross_project() {
        relay_fields(args, request, &["project_id"]);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use tokio::sync::Mutex;

    use super::super::tests::spawn_project_route;
    use super::{get_settings_with_client, update_settings_with_client, McpControlClient};
    use crate::domain::mcp::context::McpContext;
    use crate::domain::mcp::settings_tool::SettingsTool;

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
        let url = spawn_project_route(path, json!({ "ok": true }), captured).await;
        McpControlClient::from_env_values(Some(url), Some("secret".into())).unwrap()
    }

    #[tokio::test]
    async fn reads_default_to_the_servers_natural_scope() {
        let ctx = context().await;
        let captured = Captured::default();
        let client = control_plane("/internal/mcp/project/settings", captured.clone()).await;
        get_settings_with_client(&json!({}), &ctx, SettingsTool::Project, client)
            .await
            .unwrap();
        let request = captured.lock().await.take().unwrap();
        assert_eq!(request["scope"], "project");
        assert_eq!(request["source_feature_id"], 42);
        assert_eq!(request["source_session_id"], 777);

        let client = control_plane("/internal/mcp/workspace/settings", captured.clone()).await;
        get_settings_with_client(
            &json!({ "keys": ["theme_current"], "include_catalog": true }),
            &ctx,
            SettingsTool::Workspace,
            client,
        )
        .await
        .unwrap();
        let request = captured.lock().await.take().unwrap();
        assert_eq!(request["scope"], "global");
        assert_eq!(request["keys"][0], "theme_current");
        assert_eq!(request["include_catalog"], true);
    }

    #[tokio::test]
    async fn updates_relay_the_target_and_values_verbatim() {
        let captured = Captured::default();
        let client =
            control_plane("/internal/mcp/workspace/update-settings", captured.clone()).await;
        update_settings_with_client(
            &json!({
                "scope": "project",
                "project_id": 9,
                "values": { "setup_worktree": "pnpm install", "branch_prefix": null }
            }),
            &*context().await,
            SettingsTool::Workspace,
            client,
        )
        .await
        .unwrap();
        let request = captured.lock().await.take().unwrap();
        assert_eq!(request["scope"], "project");
        assert_eq!(request["project_id"], 9);
        assert_eq!(request["values"]["setup_worktree"], "pnpm install");
        assert!(request["values"]["branch_prefix"].is_null());
    }

    #[tokio::test]
    async fn project_tools_never_relay_a_project_id() {
        let captured = Captured::default();
        let client = control_plane("/internal/mcp/project/update-settings", captured.clone()).await;
        update_settings_with_client(
            &json!({ "scope": "project", "project_id": 9, "values": { "color": "#fff" } }),
            &*context().await,
            SettingsTool::Project,
            client,
        )
        .await
        .unwrap();
        let request = captured.lock().await.take().unwrap();
        assert!(request.get("project_id").is_none());
    }
}
