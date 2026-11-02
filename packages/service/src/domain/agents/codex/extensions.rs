//! Codex skills and MCP servers, through `codex mcp` and `codex plugin`.

mod definition;
mod profile;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::Deserialize;

use crate::domain::agents::extensions::{
    args, local_skills, positional, AvailableSkill, CliMcpServer, CliRunner, ExtensionCli,
    ExtensionError, ExtensionSupport, InstalledSkill, McpDefinition, McpServerSpec, McpTransport,
    SkillInventory, SkillOffer, SkillSource,
};

#[derive(Debug, Clone, Copy)]
pub struct CodexExtensions;

#[derive(Debug, Deserialize)]
struct PluginList {
    #[serde(default)]
    installed: Vec<RawPlugin>,
    #[serde(default)]
    available: Vec<RawPlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlugin {
    plugin_id: String,
    name: String,
    marketplace_name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    install_policy: Option<String>,
}

/// Plugin-provided servers run from the plugin cache and are not in
/// `config.toml`, so `codex mcp remove` cannot touch them.
fn plugin_owner(command: &str, home: Option<&Path>) -> Option<String> {
    profile::in_plugin_cache(command, home).then(|| "a Codex plugin".to_string())
}

/// Remote marketplace apps listed only by an opaque id (`app-69a8…`).
fn is_opaque_app(name: &str) -> bool {
    name.strip_prefix("app-")
        .is_some_and(|rest| rest.len() >= 16 && rest.chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn inventory(list: PluginList) -> SkillInventory {
    let installed = list
        .installed
        .into_iter()
        .map(|plugin| InstalledSkill {
            provider_id: super::PROVIDER_ID.to_string(),
            id: plugin.plugin_id,
            name: plugin.name,
            description: None,
            source: SkillSource::Plugin,
            version: plugin.version,
            update: None,
            enabled: plugin.enabled,
            scope: Some("user".to_string()),
            path: None,
            installed_at: None,
            updated_at: None,
        })
        .collect();
    let available = list
        .available
        .into_iter()
        .filter(|plugin| {
            plugin
                .install_policy
                .as_deref()
                .is_none_or(|policy| policy == "AVAILABLE")
        })
        .filter(|plugin| !is_opaque_app(&plugin.name))
        .map(|plugin| AvailableSkill {
            name: plugin.name,
            description: None,
            offer: SkillOffer {
                provider_id: super::PROVIDER_ID.to_string(),
                plugin_id: plugin.plugin_id,
                marketplace: plugin.marketplace_name,
                version: plugin.version,
                install_count: None,
            },
        })
        .collect();
    SkillInventory {
        installed,
        available,
    }
}

/// Skill folders Codex reads: `$CODEX_HOME/skills` and the shared `~/.agents/skills`.
fn skill_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = home.map(|home| home.join("skills")).into_iter().collect();
    roots.extend(dirs::home_dir().map(|home| home.join(".agents").join("skills")));
    roots
}

/// What `codex mcp list --json` printed, minus transports Cadencr does not know.
fn listed_servers(raw: Vec<definition::RawDefinition>, home: Option<&Path>) -> Vec<CliMcpServer> {
    raw.into_iter()
        .filter(definition::RawDefinition::known_transport)
        .map(|raw| {
            raw.into_definition(|command| plugin_owner(command, home))
                .server
        })
        .collect()
}

fn add_args(spec: &McpServerSpec) -> Result<Vec<String>, ExtensionError> {
    let mut command = args!["mcp", "add", spec.name.as_str()];
    match spec.transport {
        McpTransport::Stdio => {
            for (key, value) in &spec.env {
                command.extend(args!["--env", format!("{key}={value}")]);
            }
            command.push("--".to_string());
            command.extend(spec.command.clone());
            command.extend(spec.args.iter().cloned());
        }
        McpTransport::Http => command.extend(args!["--url", spec.url.clone().unwrap_or_default()]),
        McpTransport::Sse => {
            return Err(ExtensionError::Unsupported(
                "Codex cannot connect to SSE MCP servers.".to_string(),
            ))
        }
    }
    Ok(command)
}

#[async_trait]
impl ExtensionCli for CodexExtensions {
    fn support(&self) -> ExtensionSupport {
        ExtensionSupport {
            mcp_transports: vec![McpTransport::Stdio, McpTransport::Http],
            mcp_headers: false,
            skills: true,
            skill_update: false,
        }
    }

    fn for_active_profile(&self, cli: &CliRunner) -> Result<CliRunner, ExtensionError> {
        profile::active(cli)
    }

    async fn list_mcp(&self, cli: &CliRunner) -> Result<Vec<CliMcpServer>, ExtensionError> {
        let servers = cli.run_json(&args!["mcp", "list", "--json"]).await?;
        Ok(listed_servers(servers, cli.config_home()))
    }

    async fn get_mcp(&self, cli: &CliRunner, name: &str) -> Result<McpDefinition, ExtensionError> {
        let raw: definition::RawDefinition = cli
            .run_json(&args!["mcp", "get", positional(name)?, "--json"])
            .await?;
        let home = cli.config_home();
        Ok(raw.into_definition(|command| plugin_owner(command, home)))
    }

    async fn add_mcp(&self, cli: &CliRunner, spec: &McpServerSpec) -> Result<(), ExtensionError> {
        cli.run(&add_args(spec)?).await.map(drop)
    }

    async fn remove_mcp(&self, cli: &CliRunner, name: &str) -> Result<(), ExtensionError> {
        cli.run(&args!["mcp", "remove", positional(name)?])
            .await
            .map(drop)
    }

    async fn skills(&self, cli: &CliRunner) -> Result<SkillInventory, ExtensionError> {
        let list: PluginList = cli
            .run_json(&args!["plugin", "list", "--json", "--available"])
            .await?;
        let mut inventory = inventory(list);
        for root in skill_roots(cli.config_home()) {
            inventory
                .installed
                .extend(local_skills::scan(super::PROVIDER_ID, &root).await);
        }
        Ok(inventory)
    }

    async fn refresh_skill_catalog(&self, cli: &CliRunner) -> Result<(), ExtensionError> {
        cli.run(&args!["plugin", "marketplace", "upgrade"])
            .await
            .map(drop)
    }

    async fn install_skill(&self, cli: &CliRunner, plugin_id: &str) -> Result<(), ExtensionError> {
        cli.run(&args!["plugin", "add", "--json", positional(plugin_id)?])
            .await
            .map(drop)
    }

    async fn remove_skill(&self, cli: &CliRunner, plugin_id: &str) -> Result<(), ExtensionError> {
        cli.run(&args!["plugin", "remove", "--json", positional(plugin_id)?])
            .await
            .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn reads_the_json_server_list() {
        let raw: Vec<definition::RawDefinition> = serde_json::from_value(serde_json::json!([
            {"name": "chrome-devtools", "enabled": true, "transport": {
                "type": "stdio", "command": "npx", "args": ["chrome-devtools-mcp@latest"],
                "env": null, "env_vars": [], "cwd": null}},
            {"name": "clickup", "enabled": false, "disabled_reason": "disabled by user",
             "transport": {"type": "streamable_http", "url": "https://mcp.clickup.com/mcp"}},
            {"name": "future", "transport": {"type": "websocket"}}
        ]))
        .unwrap();
        let servers = listed_servers(raw, None);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].managed_by, None);
        assert_eq!(servers[0].args, ["chrome-devtools-mcp@latest"]);
        assert_eq!(servers[1].transport, McpTransport::Http);
        assert!(!servers[1].enabled);
        assert_eq!(servers[1].status.as_deref(), Some("disabled by user"));
        assert_eq!(servers[1].unsupported_settings, ["disabled"]);
    }

    #[test]
    fn add_puts_values_after_the_name_and_the_command_after_a_separator() {
        let spec = McpServerSpec {
            name: "acme".into(),
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec!["-y".into(), "acme@1.0.0".into()],
            env: BTreeMap::from([("TOKEN".into(), "t".into())]),
            url: None,
            headers: BTreeMap::new(),
        };
        assert_eq!(
            add_args(&spec).unwrap(),
            [
                "mcp",
                "add",
                "acme",
                "--env",
                "TOKEN=t",
                "--",
                "npx",
                "-y",
                "acme@1.0.0"
            ]
        );
    }

    #[test]
    fn opaque_remote_apps_are_not_offered() {
        let list: PluginList = serde_json::from_value(serde_json::json!({
            "installed": [],
            "available": [
                {"pluginId": "app-6a057d268ebc81919918d37eec718425@remote", "name": "app-6a057d268ebc81919918d37eec718425", "marketplaceName": "remote"},
                {"pluginId": "linear@remote", "name": "linear", "marketplaceName": "remote", "installPolicy": "AVAILABLE"},
                {"pluginId": "x@remote", "name": "x", "marketplaceName": "remote", "installPolicy": "NOT_AVAILABLE"}
            ]
        }))
        .unwrap();
        let names: Vec<_> = inventory(list)
            .available
            .into_iter()
            .map(|skill| skill.name)
            .collect();
        assert_eq!(names, ["linear"]);
    }
}
