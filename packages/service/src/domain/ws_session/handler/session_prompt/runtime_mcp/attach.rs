use crate::app_state::BrowserBridgeConfig;
use crate::domain::agents::adapter::{RuntimeMcpServerConfig, RuntimeSpawnConfig};
use crate::domain::mcp::servers::{mcp_server_name, AgentType};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(in crate::domain::ws_session::handler::session_prompt) fn attach_cadencr_browser_mcp(
    config: &mut RuntimeSpawnConfig,
    db_path: &str,
    feature_id: i64,
    command: &str,
    browser_bridge: Option<BrowserBridgeConfig>,
) -> Result<(), String> {
    attach_stdio_mcp(
        config,
        db_path,
        feature_id,
        command,
        AgentType::Browser,
        None,
        browser_bridge_env(browser_bridge),
    )
}

pub(in crate::domain::ws_session::handler::session_prompt) fn attach_cadencr_project_mcp(
    config: &mut RuntimeSpawnConfig,
    db_path: &str,
    feature_id: i64,
    source_session_id: i64,
    command: &str,
    service_url: &str,
    control_token: &str,
) -> Result<(), String> {
    attach_stdio_mcp(
        config,
        db_path,
        feature_id,
        command,
        AgentType::Project,
        Some(source_session_id),
        Some(mcp_control_env(
            feature_id,
            source_session_id,
            service_url,
            control_token,
        )),
    )
}

pub(in crate::domain::ws_session::handler::session_prompt) fn attach_cadencr_workspace_mcp(
    config: &mut RuntimeSpawnConfig,
    db_path: &str,
    feature_id: i64,
    source_session_id: i64,
    command: &str,
    service_url: &str,
    control_token: &str,
) -> Result<(), String> {
    attach_stdio_mcp(
        config,
        db_path,
        feature_id,
        command,
        AgentType::Workspace,
        Some(source_session_id),
        Some(mcp_control_env(
            feature_id,
            source_session_id,
            service_url,
            control_token,
        )),
    )
}

pub(in crate::domain::ws_session::handler::session_prompt) fn attach_cadencr_orchestration_mcps(
    config: &mut RuntimeSpawnConfig,
    db_path: &str,
    feature_id: i64,
    source_session_id: i64,
    command: &str,
    browser_bridge: Option<BrowserBridgeConfig>,
    service_url: &str,
    control_token: &str,
) -> Result<(), String> {
    attach_cadencr_browser_mcp(config, db_path, feature_id, command, browser_bridge)?;
    attach_cadencr_project_mcp(
        config,
        db_path,
        feature_id,
        source_session_id,
        command,
        service_url,
        control_token,
    )
}

fn attach_stdio_mcp(
    config: &mut RuntimeSpawnConfig,
    db_path: &str,
    feature_id: i64,
    command: &str,
    agent_type: AgentType,
    source_session_id: Option<i64>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let db_path = absolute_db_path(db_path)?;
    let mut args = vec![
        "--db-path".to_string(),
        db_path,
        "mcp-serve".to_string(),
        "--agent-type".to_string(),
        agent_type.short_name().to_string(),
        "--feature-id".to_string(),
        feature_id.to_string(),
    ];
    if let Some(session_id) = source_session_id {
        args.extend(["--session-id".to_string(), session_id.to_string()]);
    }
    config.mcp_servers.get_or_insert_with(HashMap::new).insert(
        mcp_server_name(agent_type),
        RuntimeMcpServerConfig::Stdio {
            command: command.to_string(),
            args: Some(args),
            env,
        },
    );
    Ok(())
}

fn absolute_db_path(db_path: &str) -> Result<String, String> {
    let path = Path::new(db_path);
    let absolute = if path.is_absolute() {
        PathBuf::from(path)
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Could not resolve service current directory: {error}"))?
            .join(path)
    };
    Ok(absolute.to_string_lossy().into_owned())
}

fn browser_bridge_env(config: Option<BrowserBridgeConfig>) -> Option<HashMap<String, String>> {
    if let Some(config) = config {
        return Some(HashMap::from(config.as_env()));
    }
    let env_config = BrowserBridgeConfig::from_env()?;
    Some(HashMap::from(env_config.as_env()))
}

fn mcp_control_env(
    feature_id: i64,
    source_session_id: i64,
    service_url: &str,
    control_token: &str,
) -> HashMap<String, String> {
    HashMap::from([
        (
            "CADENCR_SOURCE_FEATURE_ID".to_string(),
            feature_id.to_string(),
        ),
        (
            "CADENCR_SOURCE_SESSION_ID".to_string(),
            source_session_id.to_string(),
        ),
        ("CADENCR_SERVICE_URL".to_string(), service_url.to_string()),
        (
            "CADENCR_MCP_CONTROL_TOKEN".to_string(),
            control_token.to_string(),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::{
        attach_cadencr_browser_mcp, attach_cadencr_orchestration_mcps, attach_cadencr_workspace_mcp,
    };
    use crate::app_state::{BrowserBridgeConfig, BROWSER_BRIDGE_TOKEN_ENV, BROWSER_BRIDGE_URL_ENV};
    use crate::domain::agents::adapter::{RuntimeMcpServerConfig, RuntimeSpawnConfig};
    use std::collections::HashMap;

    const COMMAND: &str = "/bin/cadencr-service";
    const SERVICE_URL: &str = "http://127.0.0.1:5005";
    const CONTROL_TOKEN: &str = "control-secret";

    fn test_db_path() -> String {
        std::env::current_dir()
            .expect("cwd")
            .join("cadencr.local.db")
            .to_string_lossy()
            .into_owned()
    }

    fn bridge_config() -> BrowserBridgeConfig {
        BrowserBridgeConfig {
            url: "http://127.0.0.1:4111/browser-bridge".to_string(),
            token: "secret".to_string(),
        }
    }

    fn expected_args(db_path: String, agent_type: &str, session_id: Option<i64>) -> Vec<String> {
        let mut args = vec![
            "--db-path".to_string(),
            db_path,
            "mcp-serve".to_string(),
            "--agent-type".to_string(),
            agent_type.to_string(),
            "--feature-id".to_string(),
            "42".to_string(),
        ];
        if let Some(session_id) = session_id {
            args.extend(["--session-id".to_string(), session_id.to_string()]);
        }
        args
    }

    fn server<'a>(
        config: &'a RuntimeSpawnConfig,
        name: &str,
    ) -> (
        &'a String,
        &'a Option<Vec<String>>,
        &'a Option<HashMap<String, String>>,
    ) {
        let RuntimeMcpServerConfig::Stdio { command, args, env } = config
            .mcp_servers
            .as_ref()
            .expect("mcp servers")
            .get(name)
            .unwrap_or_else(|| panic!("{name} server should exist"));
        (command, args, env)
    }

    #[test]
    fn attach_cadencr_browser_mcp_adds_feature_pinned_stdio_server() {
        let mut config = RuntimeSpawnConfig::default();
        let db_path = test_db_path();
        attach_cadencr_browser_mcp(
            &mut config,
            "cadencr.local.db",
            42,
            COMMAND,
            Some(bridge_config()),
        )
        .expect("attach browser mcp");

        let (command, args, env) = server(&config, "cadencr-browser");
        assert_eq!(command, COMMAND);
        assert_eq!(
            args.as_ref().expect("args"),
            &expected_args(db_path, "browser", None)
        );
        let env = env.as_ref().expect("bridge env");
        assert_eq!(
            env.get(BROWSER_BRIDGE_URL_ENV).map(String::as_str),
            Some("http://127.0.0.1:4111/browser-bridge")
        );
        assert_eq!(
            env.get(BROWSER_BRIDGE_TOKEN_ENV).map(String::as_str),
            Some("secret")
        );
    }

    #[test]
    fn attach_cadencr_orchestration_mcps_adds_browser_and_project_stdio_servers() {
        let mut config = RuntimeSpawnConfig::default();
        let db_path = test_db_path();
        attach_cadencr_orchestration_mcps(
            &mut config,
            "cadencr.local.db",
            42,
            777,
            COMMAND,
            Some(bridge_config()),
            SERVICE_URL,
            CONTROL_TOKEN,
        )
        .expect("attach orchestration mcps");

        assert!(config
            .mcp_servers
            .as_ref()
            .expect("mcp servers")
            .contains_key("cadencr-browser"));
        let (command, args, env) = server(&config, "cadencr-project");
        assert_eq!(command, COMMAND);
        assert_eq!(
            args.as_ref().expect("project args"),
            &expected_args(db_path, "project", Some(777))
        );
        let env = env.as_ref().expect("project control env");
        assert_eq!(
            env.get("CADENCR_SOURCE_SESSION_ID").map(String::as_str),
            Some("777")
        );
        assert_eq!(
            env.get("CADENCR_SOURCE_FEATURE_ID").map(String::as_str),
            Some("42")
        );
        assert_eq!(
            env.get("CADENCR_SERVICE_URL").map(String::as_str),
            Some(SERVICE_URL)
        );
        assert_eq!(
            env.get("CADENCR_MCP_CONTROL_TOKEN").map(String::as_str),
            Some(CONTROL_TOKEN)
        );
    }

    #[test]
    fn attach_cadencr_workspace_mcp_adds_session_pinned_stdio_server() {
        let mut config = RuntimeSpawnConfig::default();
        let db_path = test_db_path();
        attach_cadencr_workspace_mcp(
            &mut config,
            "cadencr.local.db",
            42,
            777,
            COMMAND,
            SERVICE_URL,
            CONTROL_TOKEN,
        )
        .expect("attach workspace mcp");

        let (command, args, env) = server(&config, "cadencr-workspace");
        assert_eq!(command, COMMAND);
        assert_eq!(
            args.as_ref().expect("workspace args"),
            &expected_args(db_path, "workspace", Some(777))
        );
        assert_eq!(
            env.as_ref()
                .and_then(|env| env.get("CADENCR_SOURCE_SESSION_ID"))
                .map(String::as_str),
            Some("777")
        );
    }
}
