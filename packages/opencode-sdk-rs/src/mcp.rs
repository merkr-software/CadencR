use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::SdkError;
use crate::process::resolve_binary;
use serde_json::Value;

const MCP_LIST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeMcpServerStatus {
    pub name: String,
    pub status: String,
}

pub async fn list_mcp_servers_from_cli(
    cwd: Option<&Path>,
) -> Result<Vec<OpenCodeMcpServerStatus>, SdkError> {
    let binary = resolve_binary().await?;
    list_mcp_servers_from_binary(&binary, cwd).await
}

pub async fn list_mcp_servers_from_binary(
    binary: &Path,
    cwd: Option<&Path>,
) -> Result<Vec<OpenCodeMcpServerStatus>, SdkError> {
    tracing::info!(
        binary = %binary.display(),
        cwd = cwd.map(|path| path.display().to_string()).as_deref().unwrap_or("<none>"),
        "discovering OpenCode MCP servers"
    );
    let config_output = run_opencode_command(binary, cwd, ["debug", "config"]).await;
    match config_output {
        Ok(output) => {
            tracing::info!(
                bytes = output.len(),
                "OpenCode debug config output received for MCP discovery"
            );
            let servers = match parse_mcp_config_output(&output) {
                Ok(servers) => servers,
                Err(error) => {
                    tracing::warn!(%error, "OpenCode debug config output was not parseable");
                    return fallback_mcp_servers(cwd);
                }
            };
            tracing::info!(
                count = servers.len(),
                servers = ?servers,
                "OpenCode MCP servers parsed from debug config"
            );
            return Ok(servers);
        }
        Err(error) => {
            tracing::warn!(%error, "failed to read OpenCode resolved config");
            if let Ok(servers) = fallback_mcp_servers(cwd) {
                if !servers.is_empty() {
                    return Ok(servers);
                }
            }
        }
    }

    let output = run_opencode_command(binary, cwd, ["mcp", "list"]).await?;
    tracing::info!(
        bytes = output.len(),
        "OpenCode mcp list output received for MCP discovery"
    );
    let servers = parse_mcp_list_output(&output);
    tracing::info!(
        count = servers.len(),
        servers = ?servers,
        "OpenCode MCP servers parsed from mcp list"
    );
    Ok(servers)
}

pub fn list_mcp_servers_from_config_files(
    cwd: Option<&Path>,
    home: Option<&Path>,
) -> Result<Vec<OpenCodeMcpServerStatus>, SdkError> {
    let mut servers = Vec::new();
    for path in config_paths(cwd, home) {
        if !path.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&path).map_err(|error| {
            SdkError::Protocol(format!(
                "failed to read OpenCode config {}: {error}",
                path.display()
            ))
        })?;
        servers.extend(parse_mcp_config_output(&raw)?);
    }
    dedupe_servers(&mut servers);
    Ok(servers)
}

async fn run_opencode_command<const N: usize>(
    binary: &Path,
    cwd: Option<&Path>,
    args: [&str; N],
) -> Result<String, SdkError> {
    let mut command = cli_discovery::login_shell_exec_command(
        binary.as_os_str(),
        args.map(std::ffi::OsString::from),
    );
    command.kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    // OpenCode exits before draining a piped stdout, so `debug config` comes
    // back cut at the 64 KiB pipe buffer. A file receives every byte; it is
    // owner-only (the resolved config can carry provider API keys) and removed
    // on drop, cancellation included.
    let stdout_capture = tempfile::NamedTempFile::new()?;
    command.stdout(std::process::Stdio::from(stdout_capture.reopen()?));
    read_command_stdout(command, stdout_capture.path()).await
}

async fn read_command_stdout(
    mut command: tokio::process::Command,
    stdout_path: &Path,
) -> Result<String, SdkError> {
    // `output()` would re-pipe stdout; `spawn` keeps the file redirection.
    command.stderr(std::process::Stdio::piped());
    let child = command.spawn()?;
    let output = tokio::time::timeout(MCP_LIST_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| SdkError::Timeout("opencode mcp list".to_string()))??;

    if !output.status.success() {
        return Err(SdkError::Protocol(format!(
            "opencode mcp list exited with status {}",
            output.status,
        )));
    }

    let stdout = std::fs::read(stdout_path)?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

pub fn parse_mcp_config_output(raw: &str) -> Result<Vec<OpenCodeMcpServerStatus>, SdkError> {
    let value: Value = serde_json::from_str(raw).map_err(|error| {
        SdkError::Protocol(format!(
            "opencode debug config returned invalid JSON: {error}"
        ))
    })?;
    let Some(mcp) = value.get("mcp").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut servers = mcp
        .iter()
        .map(|(name, config)| OpenCodeMcpServerStatus {
            name: name.clone(),
            status: config_status(config),
        })
        .collect::<Vec<_>>();
    servers.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(servers)
}

pub fn parse_mcp_list_output(raw: &str) -> Vec<OpenCodeMcpServerStatus> {
    raw.lines()
        .filter_map(|line| {
            let clean = strip_ansi_codes(line);
            parse_output_line(&clean)
        })
        .collect()
}

fn parse_output_line(line: &str) -> Option<OpenCodeMcpServerStatus> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if starts_with_box_marker(trimmed) {
        return parse_box_server_line(trimmed);
    }
    parse_status_line(trimmed)
}

fn parse_box_server_line(_line: &str) -> Option<OpenCodeMcpServerStatus> {
    None
}

fn parse_status_line(line: &str) -> Option<OpenCodeMcpServerStatus> {
    let mut columns = line
        .split_whitespace()
        .filter(|column| !is_marker_token(column));
    let name = trim_marker(columns.next()?);
    let status = trim_marker(columns.next()?).to_ascii_lowercase();
    if name.eq_ignore_ascii_case("name") && status.eq_ignore_ascii_case("status") {
        return None;
    }
    if name.is_empty() || !is_known_status(&status) {
        return None;
    }
    Some(OpenCodeMcpServerStatus {
        name: name.to_string(),
        status,
    })
}

fn strip_ansi_codes(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code in chars.by_ref() {
                if code.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        output.push(ch);
    }
    output
}

fn starts_with_box_marker(value: &str) -> bool {
    value.chars().next().is_some_and(is_box_or_separator)
}

fn is_box_or_separator(ch: char) -> bool {
    matches!(
        ch,
        '┌' | '┐'
            | '└'
            | '┘'
            | '│'
            | '─'
            | '├'
            | '┤'
            | '┬'
            | '┴'
            | '┼'
            | '╭'
            | '╮'
            | '╰'
            | '╯'
            | '═'
            | '║'
    )
}

fn config_status(config: &Value) -> String {
    if config.get("enabled").and_then(Value::as_bool) == Some(false) {
        return "unavailable".to_string();
    }
    "connected".to_string()
}

fn trim_marker(value: &str) -> &str {
    value.trim_matches(|c: char| {
        matches!(c, '●' | '○' | '✓' | '✔' | '✗' | '✘' | '-' | ':' | '[' | ']')
    })
}

fn is_marker_token(value: &str) -> bool {
    let trimmed = trim_marker(value);
    trimmed.is_empty()
}

fn is_known_status(value: &str) -> bool {
    matches!(
        value,
        "connected" | "unavailable" | "unknown" | "disabled" | "pending" | "error"
    )
}

fn fallback_mcp_servers(cwd: Option<&Path>) -> Result<Vec<OpenCodeMcpServerStatus>, SdkError> {
    let servers = list_mcp_servers_from_config_files(cwd, user_home().as_deref())?;
    tracing::info!(
        count = servers.len(),
        servers = ?servers,
        "OpenCode MCP servers parsed from config-file fallback"
    );
    Ok(servers)
}

fn config_paths(cwd: Option<&Path>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(cwd) = cwd {
        paths.push(cwd.join("opencode.json"));
        paths.push(cwd.join(".opencode.json"));
        paths.push(cwd.join(".config/opencode/opencode.json"));
    }
    if let Some(config_home) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(PathBuf::from(config_home).join("opencode/opencode.json"));
    }
    if let Some(home) = home {
        paths.push(home.join(".config/opencode/opencode.json"));
    }
    paths
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn dedupe_servers(servers: &mut Vec<OpenCodeMcpServerStatus>) {
    servers.sort_by(|left, right| left.name.cmp(&right.name));
    servers.dedup_by(|left, right| left.name == right.name);
}
