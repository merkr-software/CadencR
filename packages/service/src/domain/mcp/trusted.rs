//! Auto-approval of the built-in MCP servers attached to a runtime.
//!
//! A permission request only carries a server and tool *name*, and any MCP
//! config the agent CLI reads (a project `.mcp.json`, `opencode.json`, the
//! user's CLI config, a marketplace install) can register a server under
//! Cadencr's names. So a name alone never earns trust: a
//! [`CadencrMcpTrust`] exists only when Cadencr itself attached the
//! server to the runtime, and each provider adapter revokes it when it cannot
//! rule out a foreign server answering under that name.

use std::collections::HashMap;

use super::servers::{mcp_server_name, AgentType, AGENT_TYPE_FLAG, MCP_SERVE_SUBCOMMAND};
use super::tools::browser::is_auto_trusted_browser_tool;
use crate::domain::agents::adapter::RuntimeMcpServerConfig;

/// Cadencr owns every MCP server name in this namespace (`cadencr-browser`,
/// `cadencr_project`, `Cadencr.workspace`…), compared after
/// [`normalized_server_name`].
const RESERVED_SERVER_PREFIX: &str = "cadencr";

/// The built-in servers attached to this runtime, minus any shadowed names.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CadencrMcpTrust {
    browser: bool,
    project: bool,
    workspace: bool,
}

impl CadencrMcpTrust {
    pub fn injected_in(servers: Option<&HashMap<String, RuntimeMcpServerConfig>>) -> Self {
        let attached = |agent| {
            servers
                .and_then(|servers| servers.get(&mcp_server_name(agent)))
                .is_some_and(|config| is_cadencr_server(config, agent))
        };
        Self {
            browser: attached(AgentType::Browser),
            project: attached(AgentType::Project),
            workspace: attached(AgentType::Workspace),
        }
    }

    pub fn shadowed_by<'a>(mut self, foreign_servers: impl IntoIterator<Item = &'a str>) -> Self {
        for name in foreign_servers {
            let foreign = normalized_server_name(name);
            self.browser &= !foreign.starts_with("cadencr_browser");
            self.project &= !foreign.starts_with("cadencr_project");
            self.workspace &= !foreign.starts_with("cadencr_workspace");
        }
        self
    }

    pub fn is_trusted(self) -> bool {
        self.browser || self.project || self.workspace
    }

    pub fn allows_tool_name(self, name: &str) -> bool {
        self.allows_in_mode(name, false)
    }

    pub fn allows_in_mode(self, name: &str, automatic: bool) -> bool {
        name.strip_prefix("mcp__")
            .and_then(|rest| rest.split_once("__"))
            .is_some_and(|(server, tool)| self.allows(server, tool, automatic))
    }

    pub fn allows(self, server: &str, tool: &str, automatic: bool) -> bool {
        match server {
            "cadencr-browser" => self.browser && is_auto_trusted_browser_tool(tool),
            "cadencr-project" => {
                automatic
                    && self.project
                    && AgentType::Project.owns_tool(tool)
                    && tool != "project_respond_gate"
            }
            "cadencr-workspace" => {
                automatic && self.workspace && AgentType::Workspace.owns_tool(tool)
            }
            _ => false,
        }
    }
}

/// Server names Cadencr reserves for its own MCP servers. Writers Cadencr
/// controls (the marketplace MCP install) refuse them.
pub fn is_reserved_mcp_server_name(name: &str) -> bool {
    let normalized = normalized_server_name(name);
    normalized == RESERVED_SERVER_PREFIX
        || normalized
            .strip_prefix(RESERVED_SERVER_PREFIX)
            .is_some_and(|rest| rest.starts_with('_'))
}

pub(super) fn is_cadencr_server(config: &RuntimeMcpServerConfig, agent: AgentType) -> bool {
    let RuntimeMcpServerConfig::Stdio { command, args, .. } = config;
    let own_binary =
        std::env::current_exe().is_ok_and(|exe| std::path::Path::new(command) == exe.as_path());
    let serves_agent = args.as_deref().is_some_and(|args| {
        args.windows(3).any(|window| {
            window[0] == MCP_SERVE_SUBCOMMAND
                && window[1] == AGENT_TYPE_FLAG
                && window[2] == agent.short_name()
        })
    });
    own_binary && serves_agent
}

/// Lowercase, with every non-alphanumeric character folded to `_`: the
/// strictest of the providers' own server-name sanitizations.
pub(crate) fn normalized_server_name(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashMap;

    use crate::domain::agents::adapter::RuntimeMcpServerConfig;

    /// The browser server exactly as the prompt pipeline attaches it.
    pub(crate) fn injected_browser_servers() -> HashMap<String, RuntimeMcpServerConfig> {
        injected_servers(&["browser"])
    }

    pub(crate) fn injected_servers(agents: &[&str]) -> HashMap<String, RuntimeMcpServerConfig> {
        let command = std::env::current_exe().expect("test binary path");
        agents
            .iter()
            .map(|agent| {
                (
                    format!("cadencr-{agent}"),
                    RuntimeMcpServerConfig::Stdio {
                        command: command.to_string_lossy().into_owned(),
                        args: Some(
                            [
                                "--db-path",
                                "/tmp/cadencr.db",
                                "mcp-serve",
                                "--agent-type",
                                *agent,
                                "--feature-id",
                                "42",
                            ]
                            .map(String::from)
                            .to_vec(),
                        ),
                        env: None,
                    },
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::test_support::injected_browser_servers;
    use super::{is_reserved_mcp_server_name, CadencrMcpTrust};
    use crate::domain::agents::adapter::RuntimeMcpServerConfig;

    fn trusted() -> CadencrMcpTrust {
        CadencrMcpTrust::injected_in(Some(&injected_browser_servers()))
    }

    fn stdio(command: &str, args: &[&str]) -> RuntimeMcpServerConfig {
        RuntimeMcpServerConfig::Stdio {
            command: command.to_string(),
            args: Some(args.iter().map(|arg| arg.to_string()).collect()),
            env: None,
        }
    }

    #[test]
    fn nothing_is_trusted_unless_cadencr_attached_its_browser_server() {
        for trust in [
            CadencrMcpTrust::default(),
            CadencrMcpTrust::injected_in(None),
            CadencrMcpTrust::injected_in(Some(&HashMap::new())),
        ] {
            assert!(!trust.is_trusted());
            assert!(!trust.allows_tool_name("mcp__cadencr-browser__browser_open_url"));
            assert!(!trust.allows("cadencr-browser", "browser_open_url", false));
        }
    }

    #[test]
    fn a_same_named_server_cadencr_did_not_launch_is_not_trusted() {
        let exe = std::env::current_exe().expect("test binary path");
        let exe = exe.to_string_lossy();
        for config in [
            stdio("npx", &["evil-mcp", "mcp-serve", "--agent-type", "browser"]),
            stdio(&exe, &["mcp-serve", "--agent-type", "project"]),
            stdio(&exe, &[]),
        ] {
            let servers = HashMap::from([("cadencr-browser".to_string(), config)]);
            assert!(!CadencrMcpTrust::injected_in(Some(&servers)).is_trusted());
        }
    }

    #[test]
    fn cadencr_attached_browser_server_trusts_only_its_canonical_names() {
        let trust = trusted();
        assert!(trust.is_trusted());
        assert!(trust.allows_tool_name("mcp__cadencr-browser__browser_open_url"));
        assert!(trust.allows("cadencr-browser", "browser_screenshot", false));
        for name in [
            "mcp__cadencr_browser__browser_open_url",
            "mcp__cadencr_browser____browser_open_url",
            "cadencr-browser_browser_open_url",
            "mcp__cadencr-browser-x__browser_open_url",
            "mcp__cadencr-workspace__read_conversation",
            "Bash",
        ] {
            assert!(!trust.allows_tool_name(name), "{name}");
        }
        assert!(!trust.allows("cadencr_browser", "browser_screenshot", false));
    }

    #[test]
    fn untrusted_browser_tools_stay_untrusted_for_cadencr_own_server() {
        let trust = trusted();
        for tool in [
            "browser_evaluate",
            "browser_open_external_url",
            "read_conversation",
        ] {
            assert!(!trust.allows_tool_name(&format!("mcp__cadencr-browser__{tool}")));
            assert!(!trust.allows("cadencr-browser", tool, false));
        }
    }

    #[test]
    fn foreign_servers_that_alias_the_browser_name_revoke_trust() {
        for foreign in [
            "cadencr-browser",
            "cadencr_browser",
            "Cadencr.Browser",
            "cadencr-browser_browser",
        ] {
            assert!(!trusted().shadowed_by([foreign]).is_trusted(), "{foreign}");
        }
        let unrelated = trusted().shadowed_by(["chrome-devtools", "cadencr-project", "browser"]);
        assert!(unrelated.is_trusted());
    }

    #[test]
    fn auto_applies_to_attached_catalog_tools_except_the_three_native_decisions() {
        let servers = super::test_support::injected_servers(&["browser", "project", "workspace"]);
        let trust = CadencrMcpTrust::injected_in(Some(&servers));
        for name in [
            "mcp__cadencr-project__project_list_sessions",
            "mcp__cadencr-workspace__workspace_list_projects",
        ] {
            assert!(trust.allows_in_mode(name, true), "{name}");
            assert!(!trust.allows_in_mode(name, false), "{name}");
        }
        for name in [
            "mcp__cadencr-browser__browser_evaluate",
            "mcp__cadencr-browser__browser_open_external_url",
            "mcp__cadencr-project__project_respond_gate",
            "mcp__cadencr-workspace__unknown",
            "mcp__foreign__workspace_list_projects",
        ] {
            assert!(!trust.allows_in_mode(name, true), "{name}");
        }
        let shadowed = trust.shadowed_by(["Cadencr.Workspace"]);
        assert!(!shadowed.allows("cadencr-workspace", "workspace_list_projects", true));
        assert!(shadowed.allows("cadencr-project", "project_list_sessions", true));
    }

    #[test]
    fn cadencr_namespace_is_reserved_for_server_names() {
        for name in [
            "cadencr",
            "cadencr-browser",
            "cadencr_browser",
            "Cadencr-Project",
            "cadencr.workspace",
        ] {
            assert!(is_reserved_mcp_server_name(name), "{name}");
        }
        for name in [
            "cadencrx",
            "my-cadencr-browser",
            "chrome-devtools",
            "browser",
        ] {
            assert!(!is_reserved_mcp_server_name(name), "{name}");
        }
    }
}
