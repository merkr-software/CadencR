use std::fmt::Display;

use opencode_sdk_rs::OpenCodeMcpServerStatus;

use crate::domain::agents::adapter::RuntimeMcpServerStatus;
use crate::domain::agents::mcp_tool_names::McpToolNameResolver;

/// The MCP statuses OpenCode listed, completed by the servers Cadencr
/// configured (all of them when the listing failed or was empty), and
/// remembered for MCP tool-name normalization.
pub(super) fn opencode_mcp_statuses<'a, E: Display>(
    listed: Result<impl IntoIterator<Item = &'a OpenCodeMcpServerStatus>, E>,
    configured: Vec<RuntimeMcpServerStatus>,
    names: &McpToolNameResolver,
) -> Vec<RuntimeMcpServerStatus> {
    let listed: Vec<RuntimeMcpServerStatus> = match listed {
        Ok(listed) => listed
            .into_iter()
            .map(|server| RuntimeMcpServerStatus {
                name: server.name.clone(),
                status: server.status.clone(),
            })
            .collect(),
        Err(error) => {
            tracing::warn!(%error, "failed to read OpenCode MCP server statuses");
            Vec::new()
        }
    };
    let servers = if listed.is_empty() {
        configured
    } else {
        merge_configured_mcp_servers(listed, configured)
    };
    names.remember(&servers);
    servers
}

pub(super) fn merge_configured_mcp_servers(
    mut listed: Vec<RuntimeMcpServerStatus>,
    configured: Vec<RuntimeMcpServerStatus>,
) -> Vec<RuntimeMcpServerStatus> {
    for server in configured {
        if listed
            .iter()
            .any(|listed_server| listed_server.name == server.name)
        {
            continue;
        }
        listed.push(server);
    }
    listed
}

#[cfg(test)]
mod tests {
    use super::merge_configured_mcp_servers;
    use crate::domain::agents::adapter::RuntimeMcpServerStatus;

    #[test]
    fn keeps_cadencr_browser_when_cli_lists_other_servers() {
        let listed = vec![RuntimeMcpServerStatus {
            name: "project-server".to_string(),
            status: "connected".to_string(),
        }];
        let configured = vec![RuntimeMcpServerStatus {
            name: "cadencr-browser".to_string(),
            status: "unknown".to_string(),
        }];

        let merged = merge_configured_mcp_servers(listed, configured);

        assert!(merged.iter().any(|server| server.name == "project-server"));
        assert!(merged.iter().any(|server| server.name == "cadencr-browser"));
    }
}
