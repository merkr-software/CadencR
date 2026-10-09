use opencode_sdk_rs::{
    list_mcp_servers_from_binary, list_mcp_servers_from_config_files, parse_mcp_list_output,
    OpenCodeMcpServerStatus,
};

#[test]
fn parses_opencode_mcp_list_table_output() {
    let servers = parse_mcp_list_output(
        r#"
Name              Status
cadencr-session   connected
filesystem        unavailable
"#,
    );

    assert_eq!(servers.len(), 2);
    assert_eq!(servers[0].name, "cadencr-session");
    assert_eq!(servers[0].status, "connected");
    assert_eq!(servers[1].name, "filesystem");
    assert_eq!(servers[1].status, "unavailable");
}

#[test]
fn parses_opencode_mcp_list_plain_pairs() {
    let servers = parse_mcp_list_output(
        r#"
cadencr-session connected
browser unknown
"#,
    );

    assert_eq!(servers.len(), 2);
    assert_eq!(servers[0].name, "cadencr-session");
    assert_eq!(servers[0].status, "connected");
    assert_eq!(servers[1].name, "browser");
    assert_eq!(servers[1].status, "unknown");
}

#[test]
fn parses_opencode_mcp_list_bullet_rows_without_empty_server_names() {
    let servers = parse_mcp_list_output(
        "\
● chrome-devtools connected
\u{1b}[32m●\u{1b}[0m filesystem unavailable
",
    );

    assert_eq!(
        servers,
        vec![
            OpenCodeMcpServerStatus {
                name: "chrome-devtools".to_string(),
                status: "connected".to_string(),
            },
            OpenCodeMcpServerStatus {
                name: "filesystem".to_string(),
                status: "unavailable".to_string(),
            },
        ]
    );
}

#[test]
fn ignores_opencode_mcp_list_prose_and_malformed_rows() {
    let servers = parse_mcp_list_output(
        "\
No MCP servers configured
name only
chrome-devtools definitely-not-a-status
",
    );

    assert!(servers.is_empty());
}

#[test]
fn parses_opencode_mcp_list_box_output_without_treating_artifacts_as_servers() {
    let servers = parse_mcp_list_output(
        "\
┌  mcp
│  \u{1b}[90mnpx -y @modelcontextprotocol/server-everything\u{1b}[0m
└  1 tools
",
    );

    assert!(servers.is_empty());
}

#[test]
fn parses_resolved_opencode_config_mcp_names() {
    let servers = opencode_sdk_rs::parse_mcp_config_output(
        r#"
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "chrome-devtools": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
    },
    "disabled-server": {
      "type": "local",
      "command": ["node", "server.js"],
      "enabled": false
    }
  }
}
"#,
    )
    .expect("parse config");

    assert_eq!(
        servers,
        vec![
            OpenCodeMcpServerStatus {
                name: "chrome-devtools".to_string(),
                status: "connected".to_string(),
            },
            OpenCodeMcpServerStatus {
                name: "disabled-server".to_string(),
                status: "unavailable".to_string(),
            },
        ]
    );
}

#[test]
fn reads_global_opencode_config_mcp_names_when_cli_discovery_is_unusable() {
    let home = tempfile::tempdir().expect("home tempdir");
    let config_dir = home.path().join(".config/opencode");
    std::fs::create_dir_all(&config_dir).expect("create config dir");
    std::fs::write(
        config_dir.join("opencode.json"),
        r#"{
          "mcp": {
            "chrome-devtools": {
              "type": "local",
              "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
            }
          }
        }"#,
    )
    .expect("write config");

    let servers = list_mcp_servers_from_config_files(None, Some(home.path())).expect("read config");

    assert_eq!(
        servers,
        vec![OpenCodeMcpServerStatus {
            name: "chrome-devtools".to_string(),
            status: "connected".to_string(),
        }]
    );
}

#[tokio::test]
async fn reads_a_resolved_config_larger_than_a_pipe_buffer() {
    let dir = tempfile::tempdir().unwrap();
    // Real configs exceed 64 KiB once plugins and agents are resolved.
    let padding = "x".repeat(100_000);
    let config = format!(r#"{{"padding":"{padding}","mcp":{{"big":{{"type":"local"}}}}}}"#);
    std::fs::write(dir.path().join("config.json"), &config).unwrap();
    let binary = dir.path().join("opencode");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\ncat '{}'\n",
            dir.path().join("config.json").display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let servers = list_mcp_servers_from_binary(&binary, Some(dir.path()))
        .await
        .unwrap();

    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].name, "big");
}
