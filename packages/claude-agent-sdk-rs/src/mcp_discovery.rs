use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;
use tracing::warn;

use crate::mcp::McpServerConfig;
use crate::types::McpServerStatus;

pub fn configured_mcp_servers(
    cwd: &Path,
    explicit: Option<&HashMap<String, McpServerConfig>>,
    user_config_file: Option<&Path>,
) -> Vec<McpServerStatus> {
    let mut servers = Vec::new();
    push_explicit_servers(&mut servers, explicit);
    push_project_servers(&mut servers, cwd);
    if let Some(user_config_file) = user_config_file {
        push_claude_json_servers(&mut servers, cwd, user_config_file);
    }
    servers
}

fn push_explicit_servers(
    servers: &mut Vec<McpServerStatus>,
    explicit: Option<&HashMap<String, McpServerConfig>>,
) {
    let Some(explicit) = explicit else {
        return;
    };
    let mut names = explicit.keys().collect::<Vec<_>>();
    names.sort();
    for name in names {
        push_configured_server(servers, name);
    }
}

fn push_project_servers(servers: &mut Vec<McpServerStatus>, cwd: &Path) {
    let path = cwd.join(".mcp.json");
    let Some(value) = read_json_file(&path) else {
        return;
    };
    push_servers_from_value(servers, value.get("mcpServers"));
}

fn push_claude_json_servers(servers: &mut Vec<McpServerStatus>, cwd: &Path, path: &Path) {
    let Some(value) = read_json_file(path) else {
        return;
    };
    push_servers_from_value(servers, value.get("mcpServers"));
    push_servers_from_value(
        servers,
        value
            .get("projects")
            .and_then(|projects| projects.get(cwd.to_string_lossy().as_ref()))
            .and_then(|project| project.get("mcpServers")),
    );
}

fn push_servers_from_value(servers: &mut Vec<McpServerStatus>, value: Option<&Value>) {
    let Some(map) = value.and_then(Value::as_object) else {
        return;
    };
    let mut names = map.keys().collect::<Vec<_>>();
    names.sort();
    for name in names {
        push_configured_server(servers, name);
    }
}

fn push_configured_server(servers: &mut Vec<McpServerStatus>, name: &str) {
    if servers.iter().any(|server| server.name == name) {
        return;
    }
    servers.push(McpServerStatus {
        name: name.to_string(),
        status: "configured".to_string(),
    });
}

fn read_json_file(path: &Path) -> Option<Value> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            warn!(path = %path.display(), %error, "failed to read Claude MCP config file");
            return None;
        }
    };
    match serde_json::from_str(&content) {
        Ok(value) => Some(value),
        Err(error) => {
            warn!(path = %path.display(), %error, "failed to parse Claude MCP config file");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tempfile::TempDir;

    use super::configured_mcp_servers;
    use crate::mcp::McpServerConfig;

    #[test]
    fn configured_servers_include_explicit_mcp_config_when_init_is_empty() {
        let dir = TempDir::new().unwrap();
        let mut explicit = HashMap::new();
        explicit.insert(
            "cadencr-session".to_string(),
            McpServerConfig::Stdio {
                command: "node".to_string(),
                args: None,
                env: None,
            },
        );

        let servers = configured_mcp_servers(dir.path(), Some(&explicit), None);

        let server = servers
            .iter()
            .find(|server| server.name == "cadencr-session")
            .expect("explicit server");
        assert_eq!(server.status, "configured");
    }

    #[test]
    fn configured_servers_read_project_mcp_json() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"chrome-devtools":{"command":"npx","args":["chrome-devtools-mcp@latest"]}}}"#,
        )
        .unwrap();

        let servers = configured_mcp_servers(dir.path(), None, None);

        let server = servers
            .iter()
            .find(|server| server.name == "chrome-devtools")
            .expect("project server");
        assert_eq!(server.status, "configured");
    }

    #[test]
    fn configured_servers_read_the_given_user_file() {
        let dir = TempDir::new().unwrap();
        let user_file = dir.path().join("profile").join(".claude.json");
        std::fs::create_dir_all(user_file.parent().unwrap()).unwrap();
        let project = dir.path().to_string_lossy().into_owned();
        std::fs::write(
            &user_file,
            serde_json::json!({
                "mcpServers": { "user-server": { "command": "a" } },
                "projects": { project: { "mcpServers": { "project-server": { "command": "b" } } } }
            })
            .to_string(),
        )
        .unwrap();

        let servers = configured_mcp_servers(dir.path(), None, Some(&user_file));

        let names: Vec<_> = servers.iter().map(|server| server.name.as_str()).collect();
        assert_eq!(names, ["user-server", "project-server"]);
    }
}
