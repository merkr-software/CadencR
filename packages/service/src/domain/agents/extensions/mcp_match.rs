//! Which registry server an installed one runs, and whether the registry has
//! a newer version of the package it pins.

use futures::StreamExt;

use super::installed_package::package_in_launch;
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

fn same_url(a: &str, b: &str) -> bool {
    a.trim_end_matches('/')
        .eq_ignore_ascii_case(b.trim_end_matches('/'))
}

/// Every server matched to the registry, a few lookups at a time, in order.
pub async fn installations(
    service: &ExtensionsService,
    servers: Vec<(String, CliMcpServer)>,
) -> Vec<(McpInstallation, Option<RegistryEntry>)> {
    futures::stream::iter(servers)
        .map(|(provider_id, server)| installation(service, provider_id, server))
        .buffered(MATCH_CONCURRENCY)
        .collect()
        .await
}

async fn installation(
    service: &ExtensionsService,
    provider_id: String,
    server: CliMcpServer,
) -> (McpInstallation, Option<RegistryEntry>) {
    let package = package_of(&server).map(|(_, package)| package);
    let entry = if server.managed_by.is_none() {
        registry_match(service, &server, package.as_ref()).await
    } else {
        None
    };
    let update = match (&package, &entry) {
        (Some(package), Some(entry)) => newer_version(entry, package),
        _ => None,
    };
    (
        McpInstallation {
            provider_id,
            server,
            package,
            update,
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
