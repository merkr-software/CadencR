mod attach;
mod current;
mod settings;

pub(super) use current::{
    attach_current_cadencr_browser_mcp, attach_current_cadencr_orchestration_mcps,
    attach_current_cadencr_project_mcp, attach_current_cadencr_workspace_mcp,
};
pub(super) use settings::workspace_mcp_enabled;
pub(crate) use settings::McpSettings;

#[cfg(test)]
mod tests {
    use super::attach_current_cadencr_browser_mcp;
    use crate::domain::agents::adapter::RuntimeSpawnConfig;
    use crate::domain::mcp::trusted::CadencrMcpTrust;

    /// The browser trust recognizes exactly what the prompt pipeline attaches.
    #[test]
    fn attached_browser_server_is_the_one_the_browser_trust_recognizes() {
        let mut config = RuntimeSpawnConfig::default();
        assert!(!CadencrMcpTrust::injected_in(config.mcp_servers.as_ref()).is_trusted());

        attach_current_cadencr_browser_mcp(&mut config, "/tmp/cadencr.db", 42, None)
            .expect("attach browser mcp");

        let trust = CadencrMcpTrust::injected_in(config.mcp_servers.as_ref());
        assert!(trust.is_trusted());
        assert!(trust.allows_tool_name("mcp__cadencr-browser__browser_open_url"));
    }
}
