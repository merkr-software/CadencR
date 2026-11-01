//! MCP servers across CLIs: the inventory (matched to the registry for
//! updates) and install, update and removal through each CLI.

use std::collections::BTreeMap;

use sqlx::SqlitePool;

use super::installed_package::with_version;
use super::mcp_match::{installations, newer_version, package_of, registry_match, update_blocker};
use super::mcp_spec::build_spec;
use super::service::{service, Cached, ExtensionHost, FAILED_TTL, MCP_TTL};
use super::types::{
    ExtensionCliError, McpInstallRequest, McpInventoryResponse, McpListing, McpServerRequest,
    McpServerSpec, McpTransport,
};
use super::{CliRunner, ExtensionCli, ExtensionError, ExtensionSupport, McpDefinition};

/// Everything every CLI has installed, grouped per registry server. Cached:
/// listing health-checks every server; `refresh` re-lists anyway.
pub async fn inventory(read_pool: &SqlitePool, refresh: bool) -> McpInventoryResponse {
    let service = service();
    // Held while listing, so concurrent requests share one run of each CLI.
    let mut cached = service.mcp.lock().await;
    if !refresh {
        if let Some(inventory) = cached.as_ref().and_then(Cached::fresh) {
            return inventory;
        }
    }
    let inventory = list_everything(read_pool).await;
    let ttl = if inventory.errors.is_empty() {
        MCP_TTL
    } else {
        FAILED_TTL
    };
    *cached = Some(Cached::new(inventory.clone(), ttl));
    inventory
}

async fn list_everything(read_pool: &SqlitePool) -> McpInventoryResponse {
    let service = service();
    let hosts: Vec<ExtensionHost> = service
        .hosts(read_pool)
        .await
        .into_iter()
        .filter(|host| host.cli.is_some() && !host.support().mcp_transports.is_empty())
        .collect();
    let reports = futures::future::join_all(hosts.iter().map(|host| async move {
        let listed = match host.runner() {
            Ok(cli) => host.extensions.list_mcp(&cli).await,
            Err(error) => Err(error),
        };
        (host.provider_id.clone(), host.label.clone(), listed)
    }))
    .await;
    let mut errors = Vec::new();
    let mut servers = Vec::new();
    for (provider_id, label, report) in reports {
        match report {
            Ok(listed) => servers.extend(
                listed
                    .into_iter()
                    .map(|server| (provider_id.clone(), label.clone(), server)),
            ),
            Err(error) => errors.push(ExtensionCliError {
                provider_id,
                message: error.to_string(),
            }),
        }
    }
    let mut listings: BTreeMap<String, McpListing> = BTreeMap::new();
    for (installation, entry) in installations(service, servers).await {
        let (key, name, registry) = match entry {
            Some(entry) => (
                format!("registry:{}", entry.server.name),
                entry
                    .server
                    .title
                    .clone()
                    .unwrap_or_else(|| entry.server.name.clone()),
                Some(entry.server),
            ),
            None => (
                format!("local:{}", installation.server.name),
                installation.server.name.clone(),
                None,
            ),
        };
        listings
            .entry(key.clone())
            .or_insert_with(|| McpListing {
                key,
                name,
                registry,
                installations: Vec::new(),
            })
            .installations
            .push(installation);
    }
    let mut listings: Vec<McpListing> = listings.into_values().collect();
    listings.sort_by_key(|listing| listing.name.to_lowercase());
    McpInventoryResponse { listings, errors }
}

/// Names every CLI accepts as a server key.
fn valid_server_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|ch| ch.is_ascii_alphanumeric())
        && name.len() <= 64
        && chars.all(|ch| ch.is_ascii_alphanumeric() || "-_.".contains(ch))
}

fn check_support(
    support: &ExtensionSupport,
    spec: &McpServerSpec,
    label: &str,
) -> Result<(), ExtensionError> {
    if !support.mcp_transports.contains(&spec.transport) {
        let transport = match spec.transport {
            McpTransport::Stdio => "local (stdio)",
            McpTransport::Http => "streamable HTTP",
            McpTransport::Sse => "SSE",
        };
        return Err(ExtensionError::Unsupported(format!(
            "{label} cannot add {transport} MCP servers from its command line."
        )));
    }
    if !spec.headers.is_empty() && !support.mcp_headers {
        return Err(ExtensionError::Unsupported(format!(
            "{label} cannot attach HTTP headers to an MCP server from its command line."
        )));
    }
    Ok(())
}

/// A server Cadencr may change: the user's own, not one a plugin, a
/// connector account or a project file owns.
fn changeable(definition: &McpDefinition, label: &str) -> Result<(), ExtensionError> {
    let name = &definition.server.name;
    if let Some(owner) = &definition.server.managed_by {
        return Err(ExtensionError::Unsupported(format!(
            "{name} comes from {owner}; change it there."
        )));
    }
    if let Some(scope) = &definition.other_scope {
        return Err(ExtensionError::Unsupported(format!(
            "{name} is in {label}'s {scope}, not your user config; change it there."
        )));
    }
    Ok(())
}

pub async fn install(
    read_pool: SqlitePool,
    request: McpInstallRequest,
) -> Result<(), ExtensionError> {
    let secrets: Vec<String> = request.values.values().cloned().collect();
    install_server(&read_pool, request)
        .await
        .map_err(|error| error.redacted(secrets.iter().map(String::as_str)))
}

async fn install_server(
    read_pool: &SqlitePool,
    request: McpInstallRequest,
) -> Result<(), ExtensionError> {
    let service = service();
    let host = service.host(read_pool, &request.provider_id).await?;
    let name = request.server_name.trim();
    if !valid_server_name(name) {
        return Err(ExtensionError::Invalid(
            "Use letters, digits, dots, dashes or underscores for the server name.".into(),
        ));
    }
    let entry = service
        .registry
        .latest(&request.registry_name)
        .await?
        .ok_or_else(|| {
            ExtensionError::Invalid(format!(
                "{} is not in the MCP Registry",
                request.registry_name
            ))
        })?;
    let launch = entry
        .launches
        .get(request.option)
        .ok_or_else(|| ExtensionError::Invalid("Unknown install option".into()))?;
    let spec = build_spec(launch, name, &request.values)?;
    check_support(&host.support(), &spec, &host.label)?;
    let _guard = service.lock_cli(&host.provider_id).await;
    let cli = host.runner()?;
    // Some CLIs overwrite an existing name silently.
    if host.extensions.get_mcp(&cli, name).await.is_ok() {
        return Err(ExtensionError::Invalid(format!(
            "{} already has an MCP server named {name}. Pick another name.",
            host.label
        )));
    }
    let result = host.extensions.add_mcp(&cli, &spec).await;
    service.invalidate_mcp().await;
    result
}

pub async fn remove(
    read_pool: SqlitePool,
    request: McpServerRequest,
) -> Result<(), ExtensionError> {
    let service = service();
    let host = service.host(&read_pool, &request.provider_id).await?;
    let _guard = service.lock_cli(&host.provider_id).await;
    let cli = host.runner()?;
    let definition = host.extensions.get_mcp(&cli, &request.server_name).await?;
    changeable(&definition, &host.label)?;
    let result = host
        .extensions
        .remove_mcp(&cli, &definition.server.name)
        .await;
    service.invalidate_mcp().await;
    result
}

/// Move a pinned package to the registry's newest version: the same launch,
/// environment and name, re-added through the CLI.
pub async fn update(
    read_pool: SqlitePool,
    request: McpServerRequest,
) -> Result<String, ExtensionError> {
    let service = service();
    let host = service.host(&read_pool, &request.provider_id).await?;
    let _guard = service.lock_cli(&host.provider_id).await;
    let cli = host.runner()?;
    let definition = host.extensions.get_mcp(&cli, &request.server_name).await?;
    let secrets: Vec<String> = definition.env.values().cloned().collect();
    let result = replace_server(&host, &cli, definition).await;
    service.invalidate_mcp().await;
    result.map_err(|error| error.redacted(secrets.iter().map(String::as_str)))
}

async fn replace_server(
    host: &ExtensionHost,
    cli: &CliRunner,
    definition: McpDefinition,
) -> Result<String, ExtensionError> {
    changeable(&definition, &host.label)?;
    let server = &definition.server;
    let (index, package) = package_of(server)
        .filter(|(_, package)| package.version.is_some())
        .ok_or_else(|| {
            ExtensionError::Unsupported(format!(
                "{} does not pin a package version; its launcher already runs the newest one.",
                server.name
            ))
        })?;
    if let Some(reason) = update_blocker(server, index, &host.label) {
        return Err(ExtensionError::Unsupported(reason));
    }
    let entry = registry_match(service(), server, Some(&package))
        .await
        .ok_or_else(|| {
            ExtensionError::Invalid(format!("{} is not in the MCP Registry", server.name))
        })?;
    let latest = newer_version(&entry, &package)
        .ok_or_else(|| ExtensionError::Invalid(format!("{} is already up to date", server.name)))?;
    let original = McpServerSpec {
        name: server.name.clone(),
        transport: McpTransport::Stdio,
        command: server.command.clone(),
        args: server.args.clone(),
        env: definition.env.clone(),
        url: None,
        headers: BTreeMap::new(),
    };
    let updated = McpServerSpec {
        args: with_version(&server.args, index, &package, &latest),
        ..original.clone()
    };
    swap(host.extensions.as_ref(), cli, &original, &updated).await?;
    Ok(latest)
}

/// Remove `original` and add `updated` in its place; when the add fails,
/// put `original` back.
async fn swap(
    extensions: &dyn ExtensionCli,
    cli: &CliRunner,
    original: &McpServerSpec,
    updated: &McpServerSpec,
) -> Result<(), ExtensionError> {
    extensions.remove_mcp(cli, &original.name).await?;
    let Err(error) = extensions.add_mcp(cli, updated).await else {
        return Ok(());
    };
    Err(match extensions.add_mcp(cli, original).await {
        Ok(()) => ExtensionError::failed(format!(
            "Update failed, the previous version was kept: {error}"
        )),
        Err(restore) => ExtensionError::failed(format!(
            "Update failed ({error}) and the previous version could not be restored ({restore})."
        )),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::domain::agents::extensions::types::{CliMcpServer, SkillInventory};

    /// Records every call; `add` fails for the args listed in `failing_adds`.
    #[derive(Debug, Default)]
    struct FakeCli {
        calls: Mutex<Vec<String>>,
        failing_adds: Vec<Vec<String>>,
    }

    #[async_trait]
    impl ExtensionCli for FakeCli {
        fn support(&self) -> ExtensionSupport {
            ExtensionSupport::default()
        }
        async fn list_mcp(&self, _: &CliRunner) -> Result<Vec<CliMcpServer>, ExtensionError> {
            unreachable!()
        }
        async fn get_mcp(&self, _: &CliRunner, _: &str) -> Result<McpDefinition, ExtensionError> {
            unreachable!()
        }
        async fn add_mcp(&self, _: &CliRunner, spec: &McpServerSpec) -> Result<(), ExtensionError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("add {}", spec.args.join(" ")));
            if self.failing_adds.contains(&spec.args) {
                return Err(ExtensionError::failed(format!(
                    "cannot add {}",
                    spec.args[0]
                )));
            }
            Ok(())
        }
        async fn remove_mcp(&self, _: &CliRunner, name: &str) -> Result<(), ExtensionError> {
            self.calls.lock().unwrap().push(format!("remove {name}"));
            Ok(())
        }
        async fn skills(&self, _: &CliRunner) -> Result<SkillInventory, ExtensionError> {
            unreachable!()
        }
        async fn install_skill(&self, _: &CliRunner, _: &str) -> Result<(), ExtensionError> {
            unreachable!()
        }
        async fn remove_skill(&self, _: &CliRunner, _: &str) -> Result<(), ExtensionError> {
            unreachable!()
        }
    }

    fn spec(version: &str) -> McpServerSpec {
        McpServerSpec {
            name: "acme".into(),
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec![format!("acme@{version}")],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
        }
    }

    async fn run_swap(failing: &[&str]) -> (Result<(), ExtensionError>, Vec<String>) {
        let fake = FakeCli {
            failing_adds: failing.iter().map(|args| vec![args.to_string()]).collect(),
            ..FakeCli::default()
        };
        let cli = CliRunner::for_binary("/bin/false");
        let result = swap(&fake, &cli, &spec("1.0.0"), &spec("2.0.0")).await;
        (result, fake.calls.into_inner().unwrap())
    }

    #[tokio::test]
    async fn an_update_removes_then_adds_the_new_version() {
        let (result, calls) = run_swap(&[]).await;
        assert!(result.is_ok());
        assert_eq!(calls, ["remove acme", "add acme@2.0.0"]);
    }

    #[tokio::test]
    async fn a_failed_add_puts_the_previous_version_back() {
        let (result, calls) = run_swap(&["acme@2.0.0"]).await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("previous version was kept"));
        assert_eq!(calls, ["remove acme", "add acme@2.0.0", "add acme@1.0.0"]);
    }

    #[tokio::test]
    async fn a_failed_restore_says_so() {
        let (result, _) = run_swap(&["acme@2.0.0", "acme@1.0.0"]).await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("could not be restored"));
    }

    #[test]
    fn only_the_users_own_servers_change() {
        let mut definition = McpDefinition {
            server: CliMcpServer {
                name: "acme".into(),
                transport: McpTransport::Stdio,
                command: Some("npx".into()),
                args: vec![],
                url: None,
                enabled: true,
                status: None,
                managed_by: None,
                args_space_joined: false,
                unsupported_settings: vec![],
            },
            env: BTreeMap::new(),
            other_scope: None,
        };
        assert!(changeable(&definition, "Claude Code").is_ok());
        definition.other_scope = Some("Project config".into());
        assert!(changeable(&definition, "Claude Code").is_err());
        definition.other_scope = None;
        definition.server.managed_by = Some("a Claude Code plugin".into());
        assert!(changeable(&definition, "Claude Code").is_err());
    }

    #[test]
    fn server_names_stay_safe_for_every_cli() {
        assert!(valid_server_name("chrome-devtools"));
        assert!(valid_server_name("acme.mcp_2"));
        assert!(!valid_server_name("-flag"));
        assert!(!valid_server_name("has space"));
        assert!(!valid_server_name(""));
    }

    #[test]
    fn support_refuses_transports_and_headers_a_cli_lacks() {
        let support = ExtensionSupport {
            mcp_transports: vec![McpTransport::Stdio, McpTransport::Http],
            ..ExtensionSupport::default()
        };
        let mut spec = McpServerSpec {
            name: "x".into(),
            transport: McpTransport::Sse,
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: Some("https://x".into()),
            headers: BTreeMap::new(),
        };
        assert!(check_support(&support, &spec, "Codex").is_err());
        spec.transport = McpTransport::Http;
        assert!(check_support(&support, &spec, "Codex").is_ok());
        spec.headers.insert("X-Key".into(), "v".into());
        assert!(check_support(&support, &spec, "Codex").is_err());
    }
}
