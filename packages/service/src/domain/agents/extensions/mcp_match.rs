//! Which registry server an installed one runs, and whether the registry has
//! a newer version of the package it pins.

use futures::StreamExt;

use super::installed_package::{may_hold_spaces, package_in_launch};
use super::mcp_registry::RegistryEntry;
use super::service::{Cached, ExtensionsService, MATCH_TTL};
use super::types::{CliMcpServer, McpInstallOption, McpInstallation, McpPackageRef};
use crate::domain::agents::updates::version::is_newer;

/// Registry lookups in flight at once while building an inventory.
const MATCH_CONCURRENCY: usize = 6;

pub fn package_of(server: &CliMcpServer) -> Option<(usize, McpPackageRef)> {
    package_in_launch(server.command.as_deref()?, &server.args)
}

/// Whether `option` launches `package`.
fn option_runs(option: &McpInstallOption, package: &McpPackageRef) -> bool {
    option.kind == package.registry_type
        && option.identifier.as_deref() == Some(package.identifier.as_str())
}

/// The registry's newer version of the package `package` pins, if any.
pub fn newer_version(entry: &RegistryEntry, package: &McpPackageRef) -> Option<String> {
    let current = package.version.as_deref()?;
    entry
        .server
        .options
        .iter()
        .filter(|option| option_runs(option, package))
        .filter_map(|option| option.version.clone())
        .find(|latest| is_newer(latest, current))
}

/// Why Cadencr cannot re-add `server` exactly as it is, and so cannot update
/// it: `label`'s `add` has no flag for one of its settings, or its arguments
/// were read back joined by spaces and one may have held a space.
pub fn update_blocker(server: &CliMcpServer, package_index: usize, label: &str) -> Option<String> {
    if !server.unsupported_settings.is_empty() {
        return Some(format!(
            "{} has settings {label} cannot re-add from its command line ({}); update it in its config.",
            server.name,
            server.unsupported_settings.join(", ")
        ));
    }
    (server.args_space_joined && may_hold_spaces(&server.args, package_index)).then(|| {
        format!(
            "{label} prints {}'s arguments on one line, so one containing a space cannot be told apart; update it in its config.",
            server.name
        )
    })
}

fn same_url(a: &str, b: &str) -> bool {
    a.trim_end_matches('/')
        .eq_ignore_ascii_case(b.trim_end_matches('/'))
}

/// A server one CLI lists: its provider id, the CLI's label, the server.
pub type ListedServer = (String, String, CliMcpServer);

/// Every server matched to the registry, a few lookups at a time, in order.
pub async fn installations(
    service: &ExtensionsService,
    servers: Vec<ListedServer>,
) -> Vec<(McpInstallation, Option<RegistryEntry>)> {
    futures::stream::iter(servers)
        .map(|(provider_id, label, server)| installation(service, provider_id, label, server))
        .buffered(MATCH_CONCURRENCY)
        .collect()
        .await
}

async fn installation(
    service: &ExtensionsService,
    provider_id: String,
    label: String,
    server: CliMcpServer,
) -> (McpInstallation, Option<RegistryEntry>) {
    let located = package_of(&server);
    let package = located.as_ref().map(|(_, package)| package.clone());
    let entry = if server.managed_by.is_none() {
        registry_match(service, &server, package.as_ref()).await
    } else {
        None
    };
    let update = match (&package, &entry) {
        (Some(package), Some(entry)) => newer_version(entry, package),
        _ => None,
    };
    let update_blocked = match (&update, &located) {
        (Some(_), Some((index, _))) => update_blocker(&server, *index, &label),
        _ => None,
    };
    (
        McpInstallation {
            provider_id,
            server,
            package,
            update,
            update_blocked,
        },
        entry,
    )
}

/// The registry server an installed one runs: same package, or same remote
/// URL. Searched by the installed name, then by the package's own name.
pub async fn registry_match(
    service: &ExtensionsService,
    server: &CliMcpServer,
    package: Option<&McpPackageRef>,
) -> Option<RegistryEntry> {
    let identity = match (package, &server.url) {
        (Some(package), _) => format!("{}:{}", package.registry_type, package.identifier),
        (None, Some(url)) => format!("url:{}", url.trim_end_matches('/')),
        (None, None) => return None,
    };
    if let Some(entry) = service
        .matches
        .lock()
        .await
        .get(&identity)
        .and_then(Cached::fresh)
    {
        return entry;
    }
    let mut queries = vec![server.name.clone()];
    if let Some(package) = package {
        let tail = package
            .identifier
            .rsplit('/')
            .next()
            .unwrap_or(&package.identifier);
        if !queries.iter().any(|query| query == tail) {
            queries.push(tail.to_string());
        }
    }
    let mut found = None;
    let mut reached = false;
    for query in queries {
        // Search results are already the latest versions, launch templates included.
        let Ok((entries, _)) = service.registry.search_entries(&query, None, 30).await else {
            continue;
        };
        reached = true;
        found = entries.into_iter().find(|entry| {
            entry.server.options.iter().any(|option| match package {
                Some(package) => option_runs(option, package),
                None => option
                    .url
                    .as_deref()
                    .zip(server.url.as_deref())
                    .is_some_and(|(a, b)| same_url(a, b)),
            })
        });
        if found.is_some() {
            break;
        }
    }
    // An unreachable registry is retried next time instead of cached as "unlisted".
    if reached {
        service
            .matches
            .lock()
            .await
            .insert(identity, Cached::new(found.clone(), MATCH_TTL));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::extensions::McpTransport;

    fn server(args: &[&str]) -> CliMcpServer {
        CliMcpServer {
            name: "fs".into(),
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            url: None,
            enabled: true,
            status: None,
            managed_by: None,
            args_space_joined: false,
            unsupported_settings: Vec::new(),
        }
    }

    #[test]
    fn a_server_the_cli_can_re_add_is_not_blocked() {
        let plain = server(&["-y", "fs@1.0.0", "/My Path"]);
        assert_eq!(update_blocker(&plain, 1, "Codex"), None);
    }

    #[test]
    fn settings_add_cannot_set_block_the_update() {
        let mut extra = server(&["-y", "fs@1.0.0"]);
        extra.unsupported_settings = vec!["cwd".into()];
        assert!(update_blocker(&extra, 1, "Codex").is_some_and(|reason| reason.contains("(cwd)")));
    }

    #[test]
    fn joined_arguments_block_only_when_a_space_may_hide() {
        let mut spaced = server(&["-y", "fs@1.0.0", "/My", "Path"]);
        spaced.args_space_joined = true;
        assert!(update_blocker(&spaced, 1, "Claude Code").is_some());
        let mut single = server(&["-y", "fs@1.0.0", "/tmp"]);
        single.args_space_joined = true;
        assert_eq!(update_blocker(&single, 1, "Claude Code"), None);
    }
}
