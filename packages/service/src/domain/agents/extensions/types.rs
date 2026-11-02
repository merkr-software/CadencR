//! Wire types for agent skills and MCP servers. Provider-neutral: a provider
//! is only ever named by its catalog id.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// How an agent CLI reaches an MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// What a provider's CLI can install, list and update for Cadencr.
#[derive(Debug, Clone, Default, Serialize, utoipa::ToSchema)]
pub struct ExtensionSupport {
    /// Transports `mcp add` accepts. Empty: the CLI cannot add MCP servers.
    pub mcp_transports: Vec<McpTransport>,
    /// The CLI can attach arbitrary HTTP headers to a remote server.
    pub mcp_headers: bool,
    /// The CLI installs skill packs from its own plugin marketplaces.
    pub skills: bool,
    /// The CLI has a command that updates an installed skill pack.
    pub skill_update: bool,
}

/// One agent CLI that can carry skills and MCP servers.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ExtensionCliSummary {
    pub provider_id: String,
    pub label: String,
    /// The CLI binary was found on this computer.
    pub installed: bool,
    pub version: Option<String>,
    pub support: ExtensionSupport,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ExtensionClisResponse {
    pub clis: Vec<ExtensionCliSummary>,
}

/// A server definition as Cadencr hands it to a CLI's `mcp add`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerSpec {
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub headers: BTreeMap<String, String>,
}

/// One MCP server as an agent CLI reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct CliMcpServer {
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub enabled: bool,
    /// Health as the CLI reported it (`Connected`, `Needs authentication`…).
    pub status: Option<String>,
    /// Set when the server is owned by something else (a connector account,
    /// a plugin) and cannot be removed or updated from here.
    pub managed_by: Option<String>,
    /// The CLI prints arguments joined by spaces, so one containing a space
    /// reads back as two.
    #[serde(skip)]
    pub args_space_joined: bool,
    /// Settings the CLI's `add` has no flag for, which a re-add would drop.
    #[serde(skip)]
    pub unsupported_settings: Vec<String>,
}

/// A package an installed server runs, read from its launch command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct McpPackageRef {
    /// `npm` or `pypi`.
    pub registry_type: String,
    pub identifier: String,
    /// Pinned version. `None`: the launcher resolves the newest one each run.
    pub version: Option<String>,
}

/// Where one value the user provides at install time goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpInputKind {
    Env,
    Header,
    Argument,
    UrlVariable,
}

/// A value the registry entry asks for (API key, path, header…).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct McpInput {
    /// Stable key the install request uses, e.g. `env:GITHUB_TOKEN`.
    pub key: String,
    pub kind: McpInputKind,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub secret: bool,
    pub default: Option<String>,
    /// Format hint from the registry, e.g. `Bearer {api_key}`.
    pub placeholder: Option<String>,
}

/// One way to run a registry server: a package launched locally or a remote endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct McpInstallOption {
    /// `npm`, `pypi`, `oci` or `remote`.
    pub kind: String,
    pub transport: McpTransport,
    /// What the agent will run or reach, e.g. `npx -y pkg@1.2.0`.
    pub summary: String,
    pub identifier: Option<String>,
    pub version: Option<String>,
    pub url: Option<String>,
    pub inputs: Vec<McpInput>,
}

/// A server listed in the official MCP Registry (latest version).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct McpRegistryServer {
    /// Reverse-DNS registry name, e.g. `io.github.owner/server`.
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub version: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub published_at: Option<String>,
    pub updated_at: Option<String>,
    pub options: Vec<McpInstallOption>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct McpRegistryPage {
    pub servers: Vec<McpRegistryServer>,
    pub next_cursor: Option<String>,
}

/// One server installed in one CLI.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct McpInstallation {
    pub provider_id: String,
    pub server: CliMcpServer,
    pub package: Option<McpPackageRef>,
    /// Newer registry version this pinned installation can move to.
    pub update: Option<String>,
    /// Why Cadencr cannot apply `update` itself: the CLI could not re-add the
    /// server exactly as it is. The user updates it in the CLI's config.
    pub update_blocked: Option<String>,
}

/// Installed servers grouped by what they are: one registry server (or one
/// unmatched name) across every CLI that carries it.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct McpListing {
    /// `registry:<name>` or `local:<server name>`.
    pub key: String,
    pub name: String,
    pub registry: Option<McpRegistryServer>,
    pub installations: Vec<McpInstallation>,
}

/// A CLI that could not report its extensions; the others still answer.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ExtensionCliError {
    pub provider_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct McpInventoryResponse {
    pub listings: Vec<McpListing>,
    pub errors: Vec<ExtensionCliError>,
}

#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct McpInstallRequest {
    pub provider_id: String,
    pub registry_name: String,
    /// Index into the registry server's `options`.
    pub option: usize,
    /// Name the CLI registers the server under.
    pub server_name: String,
    /// Values keyed by [`McpInput::key`].
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct McpServerRequest {
    pub provider_id: String,
    pub server_name: String,
}

/// A skill pack as a CLI's plugin marketplace offers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct SkillOffer {
    pub provider_id: String,
    /// The CLI's own selector, e.g. `name@marketplace`.
    pub plugin_id: String,
    pub marketplace: String,
    pub version: Option<String>,
    pub install_count: Option<u64>,
}

/// Where an installed skill came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    /// A plugin installed from one of the CLI's marketplaces.
    Plugin,
    /// A skill folder placed in the CLI's skills directory by hand or a tool.
    Local,
}

/// A skill or skill pack installed in one CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct InstalledSkill {
    pub provider_id: String,
    /// Plugin selector, or the skill folder name for a local skill.
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub source: SkillSource,
    pub version: Option<String>,
    /// Newer marketplace version, when the CLI's catalog shows one.
    pub update: Option<String>,
    pub enabled: Option<bool>,
    pub scope: Option<String>,
    pub path: Option<String>,
    pub installed_at: Option<String>,
    pub updated_at: Option<String>,
}

/// What a provider's CLI reports about skills: installed and installable.
#[derive(Debug, Clone, Default)]
pub struct SkillInventory {
    pub installed: Vec<InstalledSkill>,
    pub available: Vec<AvailableSkill>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvailableSkill {
    pub name: String,
    pub description: Option<String>,
    pub offer: SkillOffer,
}

/// One skill name across every CLI: what each offers and what each has installed.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct SkillListing {
    /// Lowercased name: the same skill pack in two CLIs shares it.
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub offers: Vec<SkillOffer>,
    pub installed: Vec<InstalledSkill>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct SkillCatalogResponse {
    pub skills: Vec<SkillListing>,
    /// Matches before `offset`/`limit` were applied.
    pub total: usize,
    pub errors: Vec<ExtensionCliError>,
}

#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct SkillRequest {
    pub provider_id: String,
    /// The CLI's plugin selector (`name@marketplace`).
    pub plugin_id: String,
}
