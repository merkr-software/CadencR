//! Auto-approval of Cadencr's own browser MCP tools.
//!
//! A permission request only carries a server and tool *name*, and any MCP
//! config the agent CLI reads (a project `.mcp.json`, `opencode.json`, the
//! user's CLI config, a marketplace install) can register a server under
//! Cadencr's names. So a name alone never earns trust: a
//! [`CadencrBrowserTrust`] exists only when Cadencr itself attached its browser
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

/// Whether Cadencr may auto-approve its browser tools for one runtime.
///
/// The default is untrusted: every browser tool then follows the provider's
/// normal permission prompt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CadencrBrowserTrust {
    injected: bool,
}

impl CadencrBrowserTrust {
    /// Trusted only when `servers` (the spawn config Cadencr built) holds
    /// Cadencr's browser server: this service binary running
    /// `mcp-serve --agent-type browser`.
    pub fn injected_in(servers: Option<&HashMap<String, RuntimeMcpServerConfig>>) -> Self {
        let injected = servers
            .and_then(|servers| servers.get(&browser_server_name()))
            .is_some_and(is_cadencr_browser_server);
        Self { injected }
    }

    /// Revoked when any server the agent loads besides Cadencr's own could
    /// answer under the browser server's name: the same name, a spelling the
    /// provider folds into it (`cadencr_browser`), or a prefix that flattened
    /// tool names cannot tell apart (`cadencr-browser_x` + tool `y`).
    pub fn shadowed_by<'a>(self, foreign_servers: impl IntoIterator<Item = &'a str>) -> Self {
        let shadowed = foreign_servers.into_iter().any(aliases_browser_server);
        Self {
            injected: self.injected && !shadowed,
        }
    }

    pub fn is_trusted(self) -> bool {
        self.injected
    }

    /// `name` is the provider-neutral `mcp__cadencr-browser__<tool>` form and
    /// `<tool>` is auto-trusted. Providers translate their own spellings to
    /// this form first, inside their adapter.
    pub fn allows_tool_name(self, name: &str) -> bool {
        name.strip_prefix("mcp__")
            .and_then(|rest| rest.split_once("__"))
            .is_some_and(|(server, tool)| self.allows_server_tool(server, tool))
    }

    /// `server` is exactly Cadencr's browser server name and `tool` is
    /// auto-trusted.
    pub fn allows_server_tool(self, server: &str, tool: &str) -> bool {
        self.injected && server == browser_server_name() && is_auto_trusted_browser_tool(tool)
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

fn browser_server_name() -> String {
    mcp_server_name(AgentType::Browser)
}

fn is_cadencr_browser_server(config: &RuntimeMcpServerConfig) -> bool {
    let RuntimeMcpServerConfig::Stdio { command, args, .. } = config;
    let own_binary =
        std::env::current_exe().is_ok_and(|exe| std::path::Path::new(command) == exe.as_path());
    let serves_browser = args.as_deref().is_some_and(|args| {
        args.windows(3).any(|window| {
            window[0] == MCP_SERVE_SUBCOMMAND
                && window[1] == AGENT_TYPE_FLAG
                && window[2] == AgentType::Browser.short_name()
        })
    });
    own_binary && serves_browser
}

fn aliases_browser_server(name: &str) -> bool {
    let browser = normalized_server_name(&browser_server_name());
    normalized_server_name(name).starts_with(&browser)
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
        let command = std::env::current_exe().expect("test binary path");
        HashMap::from([(
            "cadencr-browser".to_string(),
            RuntimeMcpServerConfig::Stdio {
                command: command.to_string_lossy().into_owned(),
                args: Some(
                    [
                        "--db-path",
                        "/tmp/cadencr.db",
                        "mcp-serve",
                        "--agent-type",
                        "browser",
                        "--feature-id",
                        "42",
                    ]
                    .map(String::from)
                    .to_vec(),
                ),
                env: None,
            },
        )])
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::test_support::injected_browser_servers;
    use super::{is_reserved_mcp_server_name, CadencrBrowserTrust};
    use crate::domain::agents::adapter::RuntimeMcpServerConfig;

    fn trusted() -> CadencrBrowserTrust {
        CadencrBrowserTrust::injected_in(Some(&injected_browser_servers()))
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
            CadencrBrowserTrust::default(),
            CadencrBrowserTrust::injected_in(None),
            CadencrBrowserTrust::injected_in(Some(&HashMap::new())),
        ] {
            assert!(!trust.is_trusted());
            assert!(!trust.allows_tool_name("mcp__cadencr-browser__browser_open_url"));
            assert!(!trust.allows_server_tool("cadencr-browser", "browser_open_url"));
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
            assert!(!CadencrBrowserTrust::injected_in(Some(&servers)).is_trusted());
        }
    }

    #[test]
    fn cadencr_attached_browser_server_trusts_only_its_canonical_names() {
        let trust = trusted();
        assert!(trust.is_trusted());
        assert!(trust.allows_tool_name("mcp__cadencr-browser__browser_open_url"));
        assert!(trust.allows_server_tool("cadencr-browser", "browser_screenshot"));
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
        assert!(!trust.allows_server_tool("cadencr_browser", "browser_screenshot"));
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
            assert!(!trust.allows_server_tool("cadencr-browser", tool));
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
