use serde::Deserialize;
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::error::SdkError;
use crate::types::McpServerStatus;

use super::query_struct::Query;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpStatusResponse {
    mcp_servers: Vec<McpServerStatus>,
}

const BOOT_MCP_STATUS_TIMEOUT: Duration = Duration::from_millis(500);
const REFRESH_MCP_STATUS_TIMEOUT: Duration = Duration::from_secs(2);

impl Query {
    /// Query Claude Code for the live MCP server status of this session.
    ///
    /// This mirrors the official Agent SDK's `get_mcp_status()` /
    /// `mcpServerStatus()` method and uses the CLI control subtype
    /// `mcp_status`, which returns `{ "mcpServers": [...] }`.
    pub async fn mcp_server_status(&self) -> Result<Vec<McpServerStatus>, SdkError> {
        self.mcp_server_status_with_timeout(super::wire::CONTROL_REQUEST_TIMEOUT)
            .await
    }

    /// Query live MCP status and replace the cached status list.
    pub async fn refresh_mcp_server_status(&self) -> Result<Vec<McpServerStatus>, SdkError> {
        let servers = self
            .mcp_server_status_with_timeout(REFRESH_MCP_STATUS_TIMEOUT)
            .await?;
        *self.mcp_servers.lock().await = servers.clone();
        Ok(servers)
    }

    pub(super) async fn preload_mcp_server_status(&self) {
        match self
            .mcp_server_status_with_timeout(BOOT_MCP_STATUS_TIMEOUT)
            .await
        {
            Ok(servers) => {
                let server_names = servers
                    .iter()
                    .map(|server| format!("{}:{}", server.name, server.status))
                    .collect::<Vec<_>>();
                info!(
                    mcp_count = server_names.len(),
                    mcp_servers = ?server_names,
                    "claude mcp: pre-prompt mcp_status response received"
                );
                *self.mcp_servers.lock().await = servers;
            }
            Err(error) => {
                warn!(
                    ?error,
                    "failed to preload Claude MCP status before first prompt"
                );
            }
        }
    }

    async fn mcp_server_status_with_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Vec<McpServerStatus>, SdkError> {
        info!(
            timeout_ms = timeout.as_millis(),
            "claude mcp: sending mcp_status control request"
        );
        let response = self
            .send_control_request_with_timeout(
                serde_json::json!({
                "subtype": "mcp_status",
                }),
                timeout,
            )
            .await?;
        debug!(response = ?response, "claude mcp: raw mcp_status response");
        let parsed: McpStatusResponse =
            serde_json::from_value(response).map_err(SdkError::SerializationError)?;
        Ok(parsed.mcp_servers)
    }
}

#[cfg(test)]
mod tests {
    use crate::options::Options;
    use crate::query::query;
    use futures::StreamExt;
    use tempfile::TempDir;

    use super::super::test_support::{mock_mcp_servers, write_mock_cli};

    #[tokio::test]
    async fn available_mcp_servers_queries_live_mcp_status() {
        let dir = TempDir::new().unwrap();
        // No user config file is given and the temp dir is the cwd, so no
        // project .mcp.json leaks in. With no explicit mcp_servers,
        // configured_mcp_servers is empty and available_mcp_servers falls
        // through to the live mcp_status control request.
        let captured_path = dir.path().join("mcp_status_request.json");
        let script = live_mcp_status_script(&captured_path);
        let script_path = write_mock_cli(dir.path(), &script);

        let options = Options {
            cwd: dir.path().to_path_buf(),
            path_to_cli: Some(script_path),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();
        q.next().await.expect("init message").unwrap();

        let servers = q
            .available_mcp_servers()
            .await
            .expect("mcp status should parse");
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "chrome-devtools");
        assert_eq!(servers[0].status, "connected");
        assert_eq!(servers[1].name, "ios-simulator");
        assert_eq!(servers[1].status, "pending");

        q.close().await;
        assert_mcp_status_request_was_sent(&captured_path);
    }

    #[tokio::test]
    async fn refresh_mcp_server_status_queries_live_and_replaces_cache() {
        let dir = TempDir::new().unwrap();
        let captured_path = dir.path().join("refresh_mcp_status_request.json");
        let script = refresh_mcp_status_script(&captured_path);
        let script_path = write_mock_cli(dir.path(), &script);

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();
        q.next().await.expect("init message").unwrap();

        let refreshed = q
            .refresh_mcp_server_status()
            .await
            .expect("refresh should parse");

        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].name, "chrome-devtools");
        assert_eq!(refreshed[0].status, "connected");

        let cached = q.available_mcp_servers().await.expect("cached servers");
        assert_eq!(cached[0].status, "connected");
        q.close().await;
        assert_mcp_status_request_was_sent(&captured_path);
    }

    fn live_mcp_status_script(path: &std::path::Path) -> String {
        format!(
            r#"#!/bin/sh
set -e
CAPTURED='{}'
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{}}}}}}\n' "$INIT_ID"
read -r USER_PROMPT
echo '{{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_mcp_live","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}}'
read -r MCP_REQ
printf '%s' "$MCP_REQ" > "$CAPTURED"
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"mcpServers":[{{"name":"chrome-devtools","status":"connected","tools":[{{"name":"new_page"}}]}},{{"name":"ios-simulator","status":"pending"}}]}}}}}}\n' "$MCP_ID"
read -r DUMMY
"#,
            path.display()
        )
    }

    fn refresh_mcp_status_script(path: &std::path::Path) -> String {
        format!(
            r#"#!/bin/sh
set -e
CAPTURED='{}'
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{}}}}}}\n' "$INIT_ID"
read -r BOOT_MCP_REQ
BOOT_MCP_ID=$(printf '%s' "$BOOT_MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"mcpServers":[{{"name":"chrome-devtools","status":"pending"}}]}}}}}}\n' "$BOOT_MCP_ID"
read -r USER_PROMPT
echo '{{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_mcp_refresh","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}}'
read -r REFRESH_MCP_REQ
printf '%s' "$REFRESH_MCP_REQ" > "$CAPTURED"
REFRESH_MCP_ID=$(printf '%s' "$REFRESH_MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"mcpServers":[{{"name":"chrome-devtools","status":"connected"}}]}}}}}}\n' "$REFRESH_MCP_ID"
read -r DUMMY
"#,
            path.display()
        )
    }

    fn assert_mcp_status_request_was_sent(path: &std::path::Path) {
        let captured_raw = std::fs::read_to_string(path).expect("captured mcp status request");
        let captured: serde_json::Value =
            serde_json::from_str(captured_raw.trim()).expect("captured request is JSON");
        assert_eq!(captured["type"], "control_request");
        assert_eq!(captured["request"]["subtype"], "mcp_status");
    }
}
