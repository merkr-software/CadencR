use super::prompt_pending::PendingPromptContext;
use super::runtime_mcp::{
    attach_current_cadencr_browser_mcp, attach_current_cadencr_orchestration_mcps,
    attach_current_cadencr_project_mcp, attach_current_cadencr_workspace_mcp, browser_mcp_enabled,
    project_mcp_enabled, workspace_mcp_enabled,
};

pub(in crate::domain::ws_session) async fn attach_cadencr_mcp(
    context: &mut PendingPromptContext,
) -> Result<(), String> {
    let pool = &context.app_state.read_pool;
    let db_path = &context.app_state.db_path;
    let feature_id = context.feature_id;
    let session_id = context.db_session_id;
    let service_url = format!("http://127.0.0.1:{}", context.app_state.port);
    let control_token = context.app_state.mcp_control_token.clone();
    let options = &mut context.options;
    match (
        browser_mcp_enabled(pool).await,
        project_mcp_enabled(pool).await,
    ) {
        (true, true) => attach_current_cadencr_orchestration_mcps(
            options,
            db_path,
            feature_id,
            session_id,
            context.app_state.browser_bridge_config()?,
            &service_url,
            &control_token,
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
            &control_token,
        )?,
        (false, false) => {}
    }
    if workspace_mcp_enabled(pool).await {
        attach_current_cadencr_workspace_mcp(
            options,
            db_path,
            feature_id,
            session_id,
            &service_url,
            &control_token,
        )?;
    }
    Ok(())
}
