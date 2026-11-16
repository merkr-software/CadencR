use serde_json::json;

use super::{optional_string, source_request, McpContext};

/// Relay `project_link_sessions` to the service: it records the link and tells
/// open windows, whose sidebar nests a conversation under the one that spawned
/// or handed off to it.
pub(crate) async fn link_sessions(
    args: &serde_json::Value,
    ctx: &McpContext,
) -> Result<serde_json::Value, String> {
    let mut request = source_request(ctx, "project_link_sessions")?;
    request["target_session_id"] = json!(args
        .get("target_session_id")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "target_session_id is required".to_string())?);
    request["link_type"] = json!(optional_string(args, "link_type"));
    request["note"] = json!(optional_string(args, "note"));
    // Not retried: a link is a new row each time.
    ctx.control()?
        .post_json_quick("/internal/mcp/project/link-sessions", request)
        .await
        .map_err(String::from)
}
