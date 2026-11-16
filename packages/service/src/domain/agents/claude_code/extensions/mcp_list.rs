//! Reading `claude mcp list` and `claude mcp get`, which only print text.

use std::collections::BTreeMap;

use crate::domain::agents::extensions::{CliMcpServer, McpDefinition, McpTransport};

/// One `name: target - status` line per server, after a "Checking…" banner.
pub fn parse_list(output: &str) -> Vec<CliMcpServer> {
    output.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<CliMcpServer> {
    let line = line.trim();
    let (name, rest) = line.split_once(": ")?;
    let (target, status) = match rest.rsplit_once(" - ") {
        Some((target, status)) => (target.trim(), Some(status.trim())),
        None => (rest.trim(), None),
    };
    if name.is_empty() || target.is_empty() || name.contains("MCP server health") {
        return None;
    }
    let status = status.map(|status| {
        status
            .trim_start_matches(|ch: char| !ch.is_alphanumeric())
            .trim()
            .to_string()
    });
    let managed_by = owner(name);
    let enabled = !status
        .as_deref()
        .is_some_and(|status| status.to_lowercase().contains("disabled"));
    let mut server = CliMcpServer {
        name: name.to_string(),
        transport: McpTransport::Stdio,
        command: None,
        args: Vec::new(),
        url: None,
        enabled,
        status,
        managed_by,
        args_space_joined: true,
        unsupported_settings: Vec::new(),
    };
    if target.starts_with("https://") || target.starts_with("http://") {
        let (url, transport) = match target.rsplit_once(' ') {
            Some((url, "(SSE)")) => (url, McpTransport::Sse),
            Some((url, "(HTTP)")) => (url, McpTransport::Http),
            _ => (target, McpTransport::Http),
        };
        server.transport = transport;
        server.url = Some(url.to_string());
    } else {
        let mut parts = target.split_whitespace().map(str::to_string);
        server.command = parts.next();
        server.args = parts.collect();
    }
    Some(server)
}

/// Servers Claude Code lists but something else owns.
fn owner(name: &str) -> Option<String> {
    if name.starts_with("claude.ai ") {
        Some("your claude.ai connectors".to_string())
    } else if name.starts_with("plugin:") {
        Some("a Claude Code plugin".to_string())
    } else {
        None
    }
}

/// `claude mcp get <name>`: `  Key: value` lines, and indented
/// `Environment:` / `Headers:` blocks.
pub fn parse_get(name: &str, output: &str) -> McpDefinition {
    let mut fields: BTreeMap<&str, &str> = BTreeMap::new();
    let mut env = BTreeMap::new();
    let mut block = None;
    for line in output.lines() {
        if let Some(entry) = line.strip_prefix("    ") {
            if block == Some("Environment") {
                if let Some((key, value)) = entry.trim().split_once('=') {
                    env.insert(key.to_string(), value.to_string());
                }
            }
            continue;
        }
        block = None;
        let Some((key, value)) = line
            .strip_prefix("  ")
            .and_then(|line| line.split_once(':'))
        else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            block = Some(key);
        } else {
            fields.insert(key, value);
        }
    }
    let transport = match fields.get("Type").copied() {
        Some("sse") => McpTransport::Sse,
        Some("http") => McpTransport::Http,
        _ => McpTransport::Stdio,
    };
    let scope = fields.get("Scope").copied().unwrap_or_default();
    McpDefinition {
        server: CliMcpServer {
            name: name.to_string(),
            transport,
            command: fields.get("Command").map(|command| command.to_string()),
            args: fields
                .get("Args")
                .map(|args| args.split_whitespace().map(str::to_string).collect())
                .unwrap_or_default(),
            url: fields.get("URL").map(|url| url.to_string()),
            enabled: true,
            status: fields.get("Status").map(|status| status.to_string()),
            managed_by: owner(name),
            args_space_joined: true,
            unsupported_settings: Vec::new(),
        },
        env,
        other_scope: (!scope.starts_with("User"))
            .then(|| scope.split(" (").next().unwrap_or(scope).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "Checking MCP server health…\n\n\
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected\n\
chrome-devtools: npx chrome-devtools-mcp@latest - ✔ Connected\n\
sentry: https://mcp.sentry.dev/mcp (HTTP) - ! Needs authentication\n\
plugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - ✗ Failed to connect\n";

    #[test]
    fn reads_every_transport_and_owner() {
        let servers = parse_list(LIST);
        assert_eq!(servers.len(), 4);
        assert_eq!(
            servers[0].managed_by.as_deref(),
            Some("your claude.ai connectors")
        );
        assert_eq!(servers[1].command.as_deref(), Some("npx"));
        assert_eq!(servers[1].args, ["chrome-devtools-mcp@latest"]);
        assert_eq!(servers[1].status.as_deref(), Some("Connected"));
        assert_eq!(
            servers[2].url.as_deref(),
            Some("https://mcp.sentry.dev/mcp")
        );
        assert_eq!(servers[2].transport, McpTransport::Http);
        assert_eq!(servers[2].status.as_deref(), Some("Needs authentication"));
        assert_eq!(servers[3].name, "plugin:github:github");
        assert!(servers[3].managed_by.is_some());
    }

    #[test]
    fn an_empty_inventory_is_not_a_server() {
        assert!(
            parse_list("No MCP servers configured. Use `claude mcp add` to add a server.\n")
                .is_empty()
        );
    }

    // Captured from `claude mcp get` (CLI 2.1.x).
    const GET: &str = "acme:\n  Scope: User config (available in all your projects)\n  Status: ✘ Failed to connect\n  Type: stdio\n  Command: npx\n  Args: -y acme@1.0.0 /Users/me/My Projects\n  Environment:\n    ACME_TOKEN=abc=d\n    REGION=eu\n\nTo remove this server, run: claude mcp remove acme -s user\n";

    #[test]
    fn reads_a_whole_definition() {
        let definition = parse_get("acme", GET);
        assert_eq!(definition.server.command.as_deref(), Some("npx"));
        // The CLI joins arguments with spaces: the split is unavoidable.
        assert_eq!(
            definition.server.args,
            ["-y", "acme@1.0.0", "/Users/me/My", "Projects"]
        );
        assert!(definition.server.args_space_joined);
        assert_eq!(definition.env.len(), 2);
        assert_eq!(definition.env["ACME_TOKEN"], "abc=d");
        assert_eq!(definition.other_scope, None);
    }

    #[test]
    fn flags_servers_outside_the_user_config() {
        let output = "remote:\n  Scope: Project config (shared via .mcp.json)\n  Type: http\n  URL: https://x.dev/mcp\n  Headers:\n    X-Key: abc\n";
        let definition = parse_get("remote", output);
        assert_eq!(definition.server.transport, McpTransport::Http);
        assert_eq!(definition.server.url.as_deref(), Some("https://x.dev/mcp"));
        assert!(definition.env.is_empty());
        assert_eq!(definition.other_scope.as_deref(), Some("Project config"));
    }
}
