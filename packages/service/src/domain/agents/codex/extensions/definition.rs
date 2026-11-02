//! A server as `codex mcp get <name> --json` and `codex mcp list --json`
//! print it: every setting, so an update knows what `codex mcp add` could not
//! put back. `list` leaves out `enabled_tools` and `disabled_tools` (codex-cli
//! 0.165), so a server limited by those alone is only refused at update time.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::domain::agents::extensions::{CliMcpServer, McpDefinition, McpTransport};

#[derive(Debug, Deserialize)]
pub struct RawDefinition {
    name: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
    #[serde(default)]
    disabled_reason: Option<String>,
    transport: RawTransport,
    #[serde(default)]
    enabled_tools: Option<Vec<String>>,
    #[serde(default)]
    disabled_tools: Option<Vec<String>>,
    #[serde(default)]
    startup_timeout_sec: Option<f64>,
    #[serde(default)]
    tool_timeout_sec: Option<f64>,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RawTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: Option<BTreeMap<String, String>>,
        #[serde(default)]
        env_vars: Option<Vec<String>>,
        #[serde(default)]
        cwd: Option<String>,
    },
    StreamableHttp {
        url: String,
    },
    #[serde(other)]
    Other,
}

impl RawDefinition {
    /// Whether Cadencr knows the transport; a newer one is left out of lists.
    pub fn known_transport(&self) -> bool {
        !matches!(self.transport, RawTransport::Other)
    }

    pub fn into_definition(self, managed_by: impl Fn(&str) -> Option<String>) -> McpDefinition {
        let mut unsupported = Vec::new();
        let mut note = |present: bool, setting: &str| {
            if present {
                unsupported.push(setting.to_string());
            }
        };
        note(!self.enabled, "disabled");
        note(self.enabled_tools.is_some(), "enabled_tools");
        note(self.disabled_tools.is_some(), "disabled_tools");
        note(self.startup_timeout_sec.is_some(), "startup_timeout_sec");
        note(self.tool_timeout_sec.is_some(), "tool_timeout_sec");
        let mut server = CliMcpServer {
            name: self.name,
            transport: McpTransport::Stdio,
            command: None,
            args: Vec::new(),
            url: None,
            enabled: self.enabled,
            status: self.disabled_reason,
            managed_by: None,
            args_space_joined: false,
            unsupported_settings: Vec::new(),
        };
        let mut env = BTreeMap::new();
        match self.transport {
            RawTransport::Stdio {
                command,
                args,
                env: values,
                env_vars,
                cwd,
            } => {
                note(env_vars.is_some_and(|vars| !vars.is_empty()), "env_vars");
                note(cwd.is_some(), "cwd");
                server.managed_by = managed_by(&command);
                server.command = Some(command);
                server.args = args;
                env = values.unwrap_or_default();
            }
            RawTransport::StreamableHttp { url } => {
                server.transport = McpTransport::Http;
                server.url = Some(url);
            }
            RawTransport::Other => note(true, "transport"),
        }
        server.unsupported_settings = unsupported;
        McpDefinition {
            server,
            env,
            other_scope: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from `codex mcp get --json` (codex-cli 0.165).
    fn definition(value: serde_json::Value) -> McpDefinition {
        serde_json::from_value::<RawDefinition>(value)
            .unwrap()
            .into_definition(|_| None)
    }

    #[test]
    fn a_plain_server_round_trips_with_its_env() {
        let definition = definition(serde_json::json!({
            "name": "plain", "enabled": true, "disabled_reason": null,
            "transport": {"type": "stdio", "command": "npx", "args": ["-y", "pkg@1.0.0", "/My Path"],
                "env": {"TOKEN": "s3cret"}, "env_vars": [], "cwd": null},
            "enabled_tools": null, "disabled_tools": null,
            "startup_timeout_sec": null, "tool_timeout_sec": null
        }));
        assert_eq!(definition.server.args, ["-y", "pkg@1.0.0", "/My Path"]);
        assert_eq!(definition.env["TOKEN"], "s3cret");
        assert!(definition.server.unsupported_settings.is_empty());
    }

    #[test]
    fn settings_add_cannot_set_are_named() {
        let definition = definition(serde_json::json!({
            "name": "extra", "enabled": false,
            "transport": {"type": "stdio", "command": "npx", "args": [],
                "env": null, "env_vars": ["HOME_TOKEN"], "cwd": "/tmp"},
            "enabled_tools": ["a"], "startup_timeout_sec": 30.0
        }));
        assert_eq!(
            definition.server.unsupported_settings,
            [
                "disabled",
                "enabled_tools",
                "startup_timeout_sec",
                "env_vars",
                "cwd"
            ]
        );
    }

    #[test]
    fn the_list_output_names_what_it_carries() {
        // `codex mcp list --json` (codex-cli 0.165) for a server with tool
        // filters, timeouts and env_vars: no `enabled_tools`/`disabled_tools`.
        let definition = definition(serde_json::json!({
            "name": "tools-limited", "enabled": true, "disabled_reason": null,
            "transport": {"type": "stdio", "command": "npx", "args": ["-y", "fs@1.0.0"],
                "env": null, "env_vars": ["HOME_TOKEN"], "cwd": null},
            "startup_timeout_sec": 30.0, "tool_timeout_sec": 60.0,
            "auth_status": "unsupported"
        }));
        assert_eq!(
            definition.server.unsupported_settings,
            ["startup_timeout_sec", "tool_timeout_sec", "env_vars"]
        );
    }

    #[test]
    fn null_env_vars_read_as_none() {
        let definition = definition(serde_json::json!({
            "name": "plain",
            "transport": {"type": "stdio", "command": "npx", "env_vars": null}
        }));
        assert!(definition.server.unsupported_settings.is_empty());
    }
}
