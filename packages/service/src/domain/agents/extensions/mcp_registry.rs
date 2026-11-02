//! Client for the official MCP Registry (registry.modelcontextprotocol.io):
//! the community-owned list every MCP client reads. Cadencr only reads it and
//! turns each entry's packages and remotes into install options.

use serde::Deserialize;

use super::mcp_options::{launch_options, LaunchOption};
use super::types::{McpRegistryPage, McpRegistryServer};
use super::ExtensionError;

const REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io/v0.1";
const OFFICIAL_META: &str = "io.modelcontextprotocol.registry/official";
pub const PAGE_SIZE: u32 = 48;

#[derive(Debug, Deserialize)]
struct RawPage {
    #[serde(default)]
    servers: Vec<RawEntry>,
    #[serde(default)]
    metadata: RawMetadata,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMetadata {
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    server: RawServer,
    #[serde(rename = "_meta", default)]
    meta: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawServer {
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: String,
    version: String,
    #[serde(default)]
    repository: Option<RawRepository>,
    #[serde(default)]
    website_url: Option<String>,
    #[serde(default)]
    packages: Vec<serde_json::Value>,
    #[serde(default)]
    remotes: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RawRepository {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialMeta {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct McpRegistry {
    http: reqwest::Client,
    base: String,
}

impl McpRegistry {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            base: REGISTRY_BASE.to_string(),
        }
    }

    /// Latest versions whose name contains `query`, in registry order.
    pub async fn search(
        &self,
        query: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<McpRegistryPage, ExtensionError> {
        let (entries, next_cursor) = self.search_entries(query, cursor, limit).await?;
        Ok(McpRegistryPage {
            servers: entries.into_iter().map(|entry| entry.server).collect(),
            next_cursor,
        })
    }

    /// [`Self::search`] with each entry's launch templates kept.
    pub async fn search_entries(
        &self,
        query: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<(Vec<RegistryEntry>, Option<String>), ExtensionError> {
        let mut params = vec![
            ("version", "latest".to_string()),
            ("limit", limit.to_string()),
        ];
        if !query.trim().is_empty() {
            params.push(("search", query.trim().to_string()));
        }
        if let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) {
            params.push(("cursor", cursor.to_string()));
        }
        let page: RawPage = self
            .get_json(&format!("{}/servers", self.base), &params)
            .await?;
        Ok((
            page.servers.into_iter().filter_map(convert_entry).collect(),
            page.metadata.next_cursor,
        ))
    }

    /// The latest version of one server with its launch templates. `None`:
    /// not (or no longer) listed.
    pub async fn latest(&self, name: &str) -> Result<Option<RegistryEntry>, ExtensionError> {
        let url = format!(
            "{}/servers/{}/versions/latest",
            self.base,
            percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC)
        );
        let response = self.send(&url, &[]).await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let entry: RawEntry = read_json(response).await?;
        Ok(convert_entry(entry))
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        params: &[(&str, String)],
    ) -> Result<T, ExtensionError> {
        read_json(self.send(url, params).await?).await
    }

    async fn send(
        &self,
        url: &str,
        params: &[(&str, String)],
    ) -> Result<reqwest::Response, ExtensionError> {
        self.http
            .get(url)
            .query(params)
            .send()
            .await
            .map_err(|error| ExtensionError::failed(format!("MCP Registry unreachable: {error}")))
    }
}

async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, ExtensionError> {
    let status = response.status();
    if !status.is_success() {
        return Err(ExtensionError::failed(format!(
            "MCP Registry answered {status}"
        )));
    }
    response
        .json()
        .await
        .map_err(|error| ExtensionError::failed(format!("MCP Registry reply unreadable: {error}")))
}

/// A registry server and the templates its install options are built from.
#[derive(Debug, Clone)]
pub struct RegistryEntry {
    pub server: McpRegistryServer,
    pub launches: Vec<LaunchOption>,
}

/// Registry entry → listing. Deleted entries and entries with no way to run
/// them through an agent CLI are dropped.
fn convert_entry(entry: RawEntry) -> Option<RegistryEntry> {
    let meta: OfficialMeta = entry
        .meta
        .get(OFFICIAL_META)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    if meta.status.as_deref() == Some("deleted") {
        return None;
    }
    let server = entry.server;
    let launches = launch_options(&server.packages, &server.remotes);
    if launches.is_empty() {
        return None;
    }
    let options = launches
        .iter()
        .map(|launch| launch.option.clone())
        .collect();
    let server = McpRegistryServer {
        name: server.name,
        title: server.title.filter(|title| !title.trim().is_empty()),
        description: server.description,
        version: server.version,
        repository: server
            .repository
            .and_then(|repository| repository.url)
            .filter(|url| url.starts_with("https://")),
        website: server.website_url.filter(|url| url.starts_with("https://")),
        published_at: meta.published_at,
        updated_at: meta.updated_at,
        options,
    };
    Some(RegistryEntry { server, launches })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(value: serde_json::Value) -> Option<McpRegistryServer> {
        convert_entry(serde_json::from_value(value).unwrap()).map(|entry| entry.server)
    }

    #[test]
    fn keeps_runnable_entries_with_their_metadata() {
        let server = entry(serde_json::json!({
            "server": {
                "name": "io.github.ChromeDevTools/chrome-devtools-mcp",
                "title": "Chrome DevTools MCP",
                "description": "MCP server for Chrome DevTools",
                "version": "1.12.0",
                "repository": {"url": "https://github.com/ChromeDevTools/chrome-devtools-mcp"},
                "packages": [{
                    "registryType": "npm",
                    "identifier": "chrome-devtools-mcp",
                    "version": "1.12.0",
                    "transport": {"type": "stdio"}
                }]
            },
            "_meta": {OFFICIAL_META: {"status": "active", "publishedAt": "2026-10-22T13:50:56Z"}}
        }))
        .unwrap();
        assert_eq!(server.title.as_deref(), Some("Chrome DevTools MCP"));
        assert_eq!(
            server.options[0].summary,
            "npx -y chrome-devtools-mcp@1.12.0"
        );
        assert_eq!(server.published_at.as_deref(), Some("2026-10-22T13:50:56Z"));
    }

    #[test]
    fn drops_deleted_and_unrunnable_entries() {
        let deleted = serde_json::json!({
            "server": {"name": "a/b", "version": "1.0.0", "remotes": [
                {"type": "streamable-http", "url": "https://example.com/mcp"}
            ]},
            "_meta": {OFFICIAL_META: {"status": "deleted"}}
        });
        assert!(entry(deleted).is_none());
        let bundle_only = serde_json::json!({
            "server": {"name": "a/c", "version": "1.0.0", "packages": [
                {"registryType": "mcpb", "identifier": "https://x/y.mcpb", "transport": {"type": "stdio"}}
            ]}
        });
        assert!(entry(bundle_only).is_none());
    }
}
