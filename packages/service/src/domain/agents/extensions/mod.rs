//! Agent skills and MCP servers, installed through each provider's own CLI.
//!
//! Cadencr never writes an agent's configuration itself: every install,
//! update and removal runs the provider CLI's own command (`claude mcp
//! add-json`, `codex plugin add`…), and every inventory comes from what the
//! CLI reports. What can be installed comes from registries that already
//! exist — the official MCP Registry for servers and each CLI's own plugin
//! marketplaces for skills — so nothing is ever submitted to Cadencr.
//!
//! Providers opt in by implementing [`ExtensionCli`] in their adapter folder
//! and attaching it to their registration metadata; this module never
//! branches on a provider id.

mod cli;
mod installed_package;
pub(crate) mod local_skills;
mod mcp_match;
mod mcp_options;
mod mcp_registry;
mod mcp_service;
mod mcp_spec;
pub mod routes;
mod service;
mod skills_service;
mod types;

use std::collections::BTreeMap;

use async_trait::async_trait;

pub(crate) use cli::{args, positional, CliRunner, ExtensionError};
pub use types::*;

/// A profile change may have moved the config an agent CLI reads: list
/// everything again next time. Returns at once; queued behind any listing in
/// flight, the reset still lands before the next one starts.
pub fn forget_inventories() {
    tokio::spawn(async {
        let service = service::service();
        service.invalidate_mcp().await;
        service.invalidate_skills().await;
    });
}

/// An installed server as its CLI's `mcp get` reports it.
#[derive(Debug, Clone)]
pub struct McpDefinition {
    pub server: CliMcpServer,
    pub env: BTreeMap<String, String>,
    /// Where the server lives when that is not the user's own config (a
    /// project file…): Cadencr only changes user-level servers.
    pub other_scope: Option<String>,
}

/// One provider's CLI, as the extension manager drives it.
#[async_trait]
pub trait ExtensionCli: Send + Sync + std::fmt::Debug {
    fn support(&self) -> ExtensionSupport;

    /// The CLI as the provider's active profile runs it (its environment and
    /// config home). Resolved once per operation, after taking the CLI's lock,
    /// so every step of an update reads and writes the same config.
    fn for_active_profile(&self, cli: &CliRunner) -> Result<CliRunner, ExtensionError> {
        Ok(cli.clone())
    }

    /// Servers the CLI loads for the user (not one project).
    async fn list_mcp(&self, cli: &CliRunner) -> Result<Vec<CliMcpServer>, ExtensionError>;

    /// One installed server in full (`mcp get`), so an update can re-add it
    /// as it was. Fails, with the CLI's explanation, when there is none.
    async fn get_mcp(&self, cli: &CliRunner, name: &str) -> Result<McpDefinition, ExtensionError>;

    /// Register `spec` for the user. Only called with a transport and
    /// features [`ExtensionCli::support`] declares.
    async fn add_mcp(&self, cli: &CliRunner, spec: &McpServerSpec) -> Result<(), ExtensionError>;

    async fn remove_mcp(&self, cli: &CliRunner, name: &str) -> Result<(), ExtensionError>;

    /// Installed skills (plugins and local folders) plus installable ones.
    async fn skills(&self, cli: &CliRunner) -> Result<SkillInventory, ExtensionError>;

    async fn install_skill(&self, cli: &CliRunner, plugin_id: &str) -> Result<(), ExtensionError>;

    async fn remove_skill(&self, cli: &CliRunner, plugin_id: &str) -> Result<(), ExtensionError>;

    /// Re-read the CLI's marketplaces from their sources, so new versions show.
    async fn refresh_skill_catalog(&self, _cli: &CliRunner) -> Result<(), ExtensionError> {
        Ok(())
    }

    async fn update_skill(&self, _cli: &CliRunner, _plugin_id: &str) -> Result<(), ExtensionError> {
        Err(ExtensionError::Unsupported(
            "This CLI has no command that updates a skill pack.".to_string(),
        ))
    }
}
