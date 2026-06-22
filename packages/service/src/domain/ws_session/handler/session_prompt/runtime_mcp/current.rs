use super::attach::{
    attach_cadencr_browser_mcp, attach_cadencr_orchestration_mcps, attach_cadencr_project_mcp,
    attach_cadencr_workspace_mcp,
};
use crate::app_state::BrowserBridgeConfig;
use crate::domain::agents::adapter::RuntimeSpawnConfig;

pub(in crate::domain::ws_session::handler::session_prompt) fn attach_current_cadencr_browser_mcp(
    config: &mut RuntimeSpawnConfig,
    db_path: &str,
    feature_id: i64,
    browser_bridge: Option<BrowserBridgeConfig>,
) -> Result<(), String> {
    let command = current_service_command()?;
    attach_cadencr_browser_mcp(config, db_path, feature_id, &command, browser_bridge)
}

pub(in crate::domain::ws_session::handler::session_prompt) fn attach_current_cadencr_orchestration_mcps(
    config: &mut RuntimeSpawnConfig,
    db_path: &str,
    feature_id: i64,
    source_session_id: i64,
    browser_bridge: Option<BrowserBridgeConfig>,
    service_url: &str,
    control_token: &str,
) -> Result<(), String> {
    let command = current_service_command()?;
    attach_cadencr_orchestration_mcps(
        config,
        db_path,
        feature_id,
        source_session_id,
        &command,
        browser_bridge,
        service_url,
        control_token,
    )
}

pub(in crate::domain::ws_session::handler::session_prompt) fn attach_current_cadencr_project_mcp(
    config: &mut RuntimeSpawnConfig,
    db_path: &str,
    feature_id: i64,
    source_session_id: i64,
    service_url: &str,
    control_token: &str,
) -> Result<(), String> {
    let command = current_service_command()?;
    attach_cadencr_project_mcp(
        config,
        db_path,
        feature_id,
        source_session_id,
        &command,
        service_url,
        control_token,
    )
}

pub(in crate::domain::ws_session::handler::session_prompt) fn attach_current_cadencr_workspace_mcp(
    config: &mut RuntimeSpawnConfig,
    db_path: &str,
    feature_id: i64,
    source_session_id: i64,
    service_url: &str,
    control_token: &str,
) -> Result<(), String> {
    let command = current_service_command()?;
    attach_cadencr_workspace_mcp(
        config,
        db_path,
        feature_id,
        source_session_id,
        &command,
        service_url,
        control_token,
    )
}

fn current_service_command() -> Result<String, String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Could not resolve Cadencr service executable: {error}"))?;
    Ok(current_exe.to_string_lossy().into_owned())
}
