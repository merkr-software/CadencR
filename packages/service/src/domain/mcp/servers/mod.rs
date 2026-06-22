pub mod browser;
pub mod project;
pub mod workspace;

use std::sync::Arc;

use rmcp::model::{Implementation, ServerCapabilities, ServerInfo};

use self::{browser::BrowserServer, project::ProjectServer, workspace::WorkspaceServer};
use super::context::McpContext;

/// MCP server families that can be served.
///
/// `cadencr-browser` owns in-app Browser automation. Workspace/session tools
/// are intentionally not exposed here because they will move to a future
/// `cadencr-workspace` MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentType {
    Browser,
    Project,
    Workspace,
}

impl AgentType {
    pub const ALL: &'static [AgentType] =
        &[AgentType::Browser, AgentType::Project, AgentType::Workspace];

    /// Short identifier used in MCP server names (`cadencr-<short>`).
    pub fn short_name(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Project => "project",
            Self::Workspace => "workspace",
        }
    }
}

impl std::str::FromStr for AgentType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        AgentType::ALL
            .iter()
            .copied()
            .find(|t| t.short_name() == s)
            .ok_or_else(|| format!("Unknown agent type: {s}"))
    }
}

/// Names of tools that the agent must expose for the MCP server to be
/// considered healthy.
pub fn cadencr_mcp_required_tools(_server_name: &str) -> Vec<String> {
    Vec::new()
}

/// Whether the named server runs any tool that requires the elicitation
/// approval flow. After the ws-feature removal no tools require approval
/// elicitation; this always returns `false` but is kept so callers in the
/// codex adapter don't have to be rewritten.
pub fn cadencr_mcp_uses_approval_elicitation(_server_name: &str) -> bool {
    false
}

/// Whether a specific tool requires approval elicitation. Always `false`
/// in the post-cleanup world — see `cadencr_mcp_uses_approval_elicitation`.
#[allow(dead_code)]
pub fn cadencr_mcp_tool_requires_approval_elicitation(
    _server_name: &str,
    _tool_name: &str,
) -> bool {
    false
}

/// A type-erased MCP server wrapper.
pub enum McpServer {
    Browser(BrowserServer),
    Project(ProjectServer),
    Workspace(WorkspaceServer),
}

/// Create the MCP server for the given agent type.
pub fn create_mcp_server(agent_type: AgentType, ctx: Arc<McpContext>) -> McpServer {
    match agent_type {
        AgentType::Browser => McpServer::Browser(BrowserServer::new(ctx)),
        AgentType::Project => McpServer::Project(ProjectServer::new(ctx)),
        AgentType::Workspace => McpServer::Workspace(WorkspaceServer::new(ctx)),
    }
}

/// Returns the MCP server name string for the given agent type.
#[allow(dead_code)]
pub fn mcp_server_name(agent_type: AgentType) -> String {
    format!("cadencr-{}", agent_type.short_name())
}

fn server_info(name: &str) -> ServerInfo {
    let caps = ServerCapabilities::builder().enable_tools().build();
    ServerInfo::new(caps).with_server_info(Implementation::new(name, "1.0.0"))
}

#[cfg(test)]
mod tests {
    use super::{cadencr_mcp_required_tools, mcp_server_name, AgentType};

    #[test]
    fn mcp_server_name_uses_current_cadencr_prefix() {
        assert_eq!(mcp_server_name(AgentType::Browser), "cadencr-browser");
        assert_eq!(mcp_server_name(AgentType::Project), "cadencr-project");
        assert_eq!(mcp_server_name(AgentType::Workspace), "cadencr-workspace");
    }

    #[test]
    fn required_tools_are_empty_for_cadencr_browser() {
        assert_eq!(
            cadencr_mcp_required_tools("cadencr-browser"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn required_tools_rejects_legacy_prefix() {
        assert!(cadencr_mcp_required_tools("legacy-session").is_empty());
    }
}
