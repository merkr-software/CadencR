//! Claude Code skills and MCP servers, through `claude mcp` and `claude plugin`.

mod mcp_list;
mod plugins;
mod profile;

use async_trait::async_trait;

use crate::domain::agents::extensions::{
    args, local_skills, positional, CliMcpServer, CliRunner, ExtensionCli, ExtensionError,
    ExtensionSupport, McpDefinition, McpServerSpec, McpTransport, SkillInventory,
};

#[derive(Debug, Clone, Copy)]
pub struct ClaudeExtensions;

/// The JSON `claude mcp add-json` takes for `spec`.
fn server_json(spec: &McpServerSpec) -> serde_json::Value {
    match spec.transport {
        McpTransport::Stdio => serde_json::json!({
            "type": "stdio",
            "command": spec.command,
            "args": spec.args,
            "env": spec.env,
        }),
        McpTransport::Http | McpTransport::Sse => serde_json::json!({
            "type": if spec.transport == McpTransport::Sse { "sse" } else { "http" },
            "url": spec.url,
            "headers": spec.headers,
        }),
    }
}

/// `claude plugin <verb>` on the user-scope copy (the one Cadencr manages).
async fn plugin_command(
    cli: &CliRunner,
    verb: &str,
    plugin_id: &str,
) -> Result<(), ExtensionError> {
    cli.run(&args![
        "plugin",
        verb,
        "--json",
        "--scope",
        "user",
        positional(plugin_id)?
    ])
    .await
    .map(drop)
}

#[async_trait]
impl ExtensionCli for ClaudeExtensions {
    fn support(&self) -> ExtensionSupport {
        ExtensionSupport {
            mcp_transports: vec![McpTransport::Stdio, McpTransport::Http, McpTransport::Sse],
            mcp_headers: true,
            skills: true,
            skill_update: true,
        }
    }

    fn for_active_profile(&self, cli: &CliRunner) -> Result<CliRunner, ExtensionError> {
        Ok(profile::active(cli))
    }

    async fn list_mcp(&self, cli: &CliRunner) -> Result<Vec<CliMcpServer>, ExtensionError> {
        Ok(mcp_list::parse_list(&cli.run(&args!["mcp", "list"]).await?))
    }

    async fn get_mcp(&self, cli: &CliRunner, name: &str) -> Result<McpDefinition, ExtensionError> {
        let output = cli.run(&args!["mcp", "get", positional(name)?]).await?;
        Ok(mcp_list::parse_get(name, &output))
    }

    async fn add_mcp(&self, cli: &CliRunner, spec: &McpServerSpec) -> Result<(), ExtensionError> {
        let json = server_json(spec).to_string();
        cli.run(&args![
            "mcp",
            "add-json",
            "--scope",
            "user",
            spec.name.as_str(),
            json
        ])
        .await
        .map(drop)
    }

    async fn remove_mcp(&self, cli: &CliRunner, name: &str) -> Result<(), ExtensionError> {
        cli.run(&args![
            "mcp",
            "remove",
            "--scope",
            "user",
            positional(name)?
        ])
        .await
        .map(drop)
    }

    async fn skills(&self, cli: &CliRunner) -> Result<SkillInventory, ExtensionError> {
        let list_args = args!["plugin", "list", "--json", "--available"];
        let marketplace_args = args!["plugin", "marketplace", "list", "--json"];
        let (list, marketplaces): (plugins::PluginList, Vec<plugins::Marketplace>) =
            tokio::try_join!(cli.run_json(&list_args), cli.run_json(&marketplace_args))?;
        let catalog = plugins::catalog_entries(&marketplaces).await;
        let mut inventory = plugins::inventory(super::PROVIDER_ID, list, &catalog);
        // Where Claude Code reads user skills: `<config dir>/skills`.
        if let Some(root) = cli.config_home().map(|dir| dir.join("skills")) {
            inventory
                .installed
                .extend(local_skills::scan(super::PROVIDER_ID, &root).await);
        }
        Ok(inventory)
    }

    async fn refresh_skill_catalog(&self, cli: &CliRunner) -> Result<(), ExtensionError> {
        cli.run(&args!["plugin", "marketplace", "update"])
            .await
            .map(drop)
    }

    async fn install_skill(&self, cli: &CliRunner, plugin_id: &str) -> Result<(), ExtensionError> {
        plugin_command(cli, "install", plugin_id).await
    }

    async fn remove_skill(&self, cli: &CliRunner, plugin_id: &str) -> Result<(), ExtensionError> {
        plugin_command(cli, "uninstall", plugin_id).await
    }

    async fn update_skill(&self, cli: &CliRunner, plugin_id: &str) -> Result<(), ExtensionError> {
        plugin_command(cli, "update", plugin_id).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn add_json_carries_the_whole_definition() {
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
            server_json(&spec),
            serde_json::json!({"type": "stdio", "command": "npx", "args": ["-y", "acme@1.0.0"], "env": {"TOKEN": "t"}})
        );
        let remote = McpServerSpec {
            transport: McpTransport::Sse,
            url: Some("https://x/sse".into()),
            command: None,
            args: vec![],
            ..spec
        };
        assert_eq!(server_json(&remote)["type"], "sse");
    }
}
