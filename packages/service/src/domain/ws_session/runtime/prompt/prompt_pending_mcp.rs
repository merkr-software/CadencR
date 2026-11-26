use super::prompt_pending::PendingPromptContext;
use super::runtime_mcp::{
    attach_current_cadencr_browser_mcp, attach_current_cadencr_orchestration_mcps,
    attach_current_cadencr_project_mcp, attach_current_cadencr_workspace_mcp, McpSettings,
};
use crate::domain::mcp::control_grant::{McpControlGrant, McpControlServer};
use crate::error::AppError;

pub(in crate::domain::ws_session) fn attach_cadencr_mcp(
    context: &mut PendingPromptContext,
) -> Result<(), AppError> {
    attach_enabled_mcps(context, McpSettings::read()?).map_err(|error| {
        AppError::coded(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "MCP_ATTACH_ERROR",
            error,
        )
    })
}

fn attach_enabled_mcps(
    context: &mut PendingPromptContext,
    settings: McpSettings,
) -> Result<(), String> {
    let db_path = &context.app_state.db_path;
    let feature_id = context.feature_id;
    let session_id = context.db_session_id;
    let service_url = format!("http://127.0.0.1:{}", context.app_state.port);
    // One grant per subprocess, bound to this conversation, session and server.
    let grant = |server| {
        McpControlGrant {
            server,
            feature_id,
            session_id,
        }
        .mint(&context.app_state.mcp_control_secret)
    };
    let project_token = grant(McpControlServer::Project);
    let workspace_token = grant(McpControlServer::Workspace);
    let options = &mut context.options;
    match (settings.browser, settings.project) {
        (true, true) => attach_current_cadencr_orchestration_mcps(
            options,
            db_path,
            feature_id,
            session_id,
            context.app_state.browser_bridge_config()?,
            &service_url,
            &project_token,
        )?,
        (true, false) => attach_current_cadencr_browser_mcp(
            options,
            db_path,
            feature_id,
            context.app_state.browser_bridge_config()?,
        )?,
        (false, true) => attach_current_cadencr_project_mcp(
            options,
            db_path,
            feature_id,
            session_id,
            &service_url,
            &project_token,
        )?,
        (false, false) => {}
    }
    if settings.workspace {
        attach_current_cadencr_workspace_mcp(
            options,
            db_path,
            feature_id,
            session_id,
            &service_url,
            &workspace_token,
        )?;
    }
    Ok(())
}
