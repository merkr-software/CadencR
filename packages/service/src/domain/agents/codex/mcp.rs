use std::collections::HashMap;

use crate::domain::agents::adapter::RuntimeMcpServerConfig;
use crate::domain::mcp::servers::cadencr_mcp_uses_approval_elicitation;
use serde_json::{json, Value};

pub(super) fn thread_config(
    mcp_servers: Option<&HashMap<String, RuntimeMcpServerConfig>>,
    developer_instructions: Option<String>,
) -> Value {
    let mut config = serde_json::Map::new();
    if let Some(instructions) = developer_instructions.filter(|value| !value.trim().is_empty()) {
        let trimmed = instructions.trim();
        let value = if trimmed.len() == instructions.len() {
            instructions
        } else {
            trimmed.to_string()
        };
        config.insert("developer_instructions".to_string(), Value::String(value));
    }
    if let Some(servers) = mcp_servers.filter(|servers| !servers.is_empty()) {
        let mut values = serde_json::Map::new();
        for (name, server_config) in servers {
            values.insert(name.clone(), mcp_server_value(name, server_config.clone()));
        }
        config.insert("mcp_servers".to_string(), Value::Object(values));
    }
    config_or_null(config)
}

fn config_or_null(config: serde_json::Map<String, Value>) -> Value {
    if config.is_empty() {
        Value::Null
    } else {
        Value::Object(config)
    }
}

pub(super) fn mcp_server_names(config: &Value) -> Vec<String> {
    config
        .get("mcp_servers")
        .and_then(Value::as_object)
        .map(|servers| servers.keys().cloned().collect())
        .unwrap_or_default()
}

fn mcp_server_value(name: &str, config: RuntimeMcpServerConfig) -> Value {
    match config {
        RuntimeMcpServerConfig::Stdio { command, args, env } => {
            let mut env = env.unwrap_or_default();
            if cadencr_mcp_uses_approval_elicitation(name) {
                env.insert(
                    "CADENCR_MCP_APPROVAL_MODE".to_string(),
                    "elicitation".to_string(),
                );
            }
            json!({
                "command": command,
                "args": args.unwrap_or_default(),
                "env": env,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{mcp_server_value, thread_config};
    use crate::domain::agents::adapter::RuntimeMcpServerConfig;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn thread_config_injects_developer_instructions_without_mcp_servers() {
        let config = thread_config(None, Some("Use Markdown".to_string()));

        assert_eq!(config["developer_instructions"], json!("Use Markdown"));
        assert!(config.get("mcp_servers").is_none());
    }

    #[test]
    fn thread_config_merges_developer_instructions_with_mcp_servers() {
        let mut servers = HashMap::new();
        servers.insert(
            "cadencr-browser".to_string(),
            RuntimeMcpServerConfig::Stdio {
                command: "svc".to_string(),
                args: None,
                env: None,
            },
        );

        let config = thread_config(Some(&servers), Some("Use Markdown".to_string()));

        assert_eq!(config["developer_instructions"], json!("Use Markdown"));
        assert_eq!(
            config["mcp_servers"]["cadencr-browser"]["command"],
            json!("svc")
        );
    }

    #[test]
    fn approval_elicitation_env_is_not_set_after_ws_feature_removal() {
        let server = |name| {
            mcp_server_value(
                name,
                RuntimeMcpServerConfig::Stdio {
                    command: "server".to_string(),
                    args: None,
                    env: None,
                },
            )
        };

        assert!(server("cadencr-browser")["env"]["CADENCR_MCP_APPROVAL_MODE"].is_null());
        assert!(server("custom")["env"]["CADENCR_MCP_APPROVAL_MODE"].is_null());
    }
}
