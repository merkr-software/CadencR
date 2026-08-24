pub mod browser;
pub mod project;
mod project_gate_schema;
mod project_schema;
mod send_message_schema;
pub mod workspace;

use std::borrow::Cow;
use std::sync::Arc;

use rmcp::model::{Implementation, ProtocolVersion, ServerCapabilities, ServerInfo};

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
/// considered healthy. Check the orchestration-critical tools so a client
/// cannot report a partially loaded server as connected.
pub fn cadencr_mcp_required_tools(server_name: &str) -> &'static [&'static str] {
    match server_name {
        "cadencr-project" => &["project_spawn_session", "project_link_sessions"],
        "cadencr-workspace" => &["workspace_list_projects", "workspace_send_session_message"],
        _ => &[],
    }
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

/// Highest MCP protocol version the Cadencr servers negotiate.
///
/// `2026-07-28` is deliberately excluded from negotiation: rmcp 3.1.1 tags
/// results for that version with `resultType` but omits the `ttlMs` and
/// `cacheScope` fields that SEP-2549 makes mandatory on `tools/list`, so
/// spec-conformant clients (Claude Code >= 2.1.232) reject the response and
/// the session ends up with zero tools (issue #208). Re-allow it only once
/// rmcp emits conformant cacheable results.
const PINNED_PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V_2025_11_25;

fn supported_protocol_versions() -> Cow<'static, [ProtocolVersion]> {
    const SUPPORTED: &[ProtocolVersion] = &[
        ProtocolVersion::V_2024_11_05,
        ProtocolVersion::V_2025_03_26,
        ProtocolVersion::V_2025_06_18,
        ProtocolVersion::V_2025_11_25,
    ];
    Cow::Borrowed(SUPPORTED)
}

fn server_info(name: &str) -> ServerInfo {
    let caps = ServerCapabilities::builder().enable_tools().build();
    let mut info = ServerInfo::new(caps).with_server_info(Implementation::new(name, "1.0.0"));
    info.protocol_version = PINNED_PROTOCOL_VERSION;
    if name == "cadencr-project" {
        return info.with_instructions(
            "CadencR project orchestration is reactive. Inter-agent messages, gates, and awaited replies steer active turns by default. After spawning with follow or requesting a reply, wait for automatically delivered <cadencr-gate> and <cadencr-reply> events; do not poll session tails, status, or pending gates. Queueing is opt-in through delivery=next_turn only.",
        );
    }
    info
}

#[cfg(test)]
mod tests {
    use super::{cadencr_mcp_required_tools, mcp_server_name, server_info, AgentType};

    #[test]
    fn mcp_server_name_uses_current_cadencr_prefix() {
        assert_eq!(mcp_server_name(AgentType::Browser), "cadencr-browser");
        assert_eq!(mcp_server_name(AgentType::Project), "cadencr-project");
        assert_eq!(mcp_server_name(AgentType::Workspace), "cadencr-workspace");
    }

    #[test]
    fn required_tools_match_each_cadencr_server_contract() {
        assert_eq!(
            cadencr_mcp_required_tools("cadencr-browser"),
            &[] as &[&str]
        );
        assert_eq!(
            cadencr_mcp_required_tools("cadencr-project"),
            &["project_spawn_session", "project_link_sessions"]
        );
        assert_eq!(
            cadencr_mcp_required_tools("cadencr-workspace"),
            &["workspace_list_projects", "workspace_send_session_message"]
        );
    }

    #[test]
    fn required_tools_rejects_legacy_prefix() {
        assert!(cadencr_mcp_required_tools("legacy-session").is_empty());
    }

    #[test]
    fn negotiation_never_offers_2026_07_28() {
        let versions = super::supported_protocol_versions();
        assert!(!versions.contains(&rmcp::model::ProtocolVersion::V_2026_07_28));
        assert!(versions.contains(&super::PINNED_PROTOCOL_VERSION));
        assert!(
            server_info("cadencr-project").protocol_version
                < rmcp::model::ProtocolVersion::V_2026_07_28
        );
    }

    #[test]
    fn project_server_instructions_define_reactive_delivery() {
        let instructions = server_info("cadencr-project").instructions.unwrap();
        assert!(instructions.contains("steer active turns by default"));
        assert!(instructions.contains("do not poll"));
        assert!(instructions.contains("delivery=next_turn"));
    }
}
