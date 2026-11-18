use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::error::SdkError;
use crate::types::McpServerStatus;

use super::query_struct::Query;
use super::wire::CONTROL_REQUEST_TIMEOUT;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpStatusResponse {
    mcp_servers: Vec<McpServerStatus>,
}

const REFRESH_MCP_STATUS_TIMEOUT: Duration = Duration::from_secs(2);

impl Query {
    /// Query Claude Code for the live MCP server status of this session.
    ///
    /// This mirrors the official Agent SDK's `get_mcp_status()` /
    /// `mcpServerStatus()` method and uses the CLI control subtype
    /// `mcp_status`, which returns `{ "mcpServers": [...] }`.
    pub async fn mcp_server_status(&self) -> Result<Vec<McpServerStatus>, SdkError> {
        self.mcp_server_status_with_timeout(CONTROL_REQUEST_TIMEOUT)
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

    /// Ask for the live MCP status before the first prompt, without waiting
    /// for the answer. The CLI handles its stdin in order, so the reply only
    /// comes once it has answered `initialize`, i.e. after its whole startup
    /// (plugins, hooks, MCP config): waiting for it held the first prompt for
    /// that long, and a short timeout expired on every spawn. The reply fills
    /// the cache when it lands, unless the session's `init` already reported
    /// statuses.
    pub(super) async fn preload_mcp_server_status(&self) {
        let (request_id, response) = match self
            .start_control_request(serde_json::json!({ "subtype": "mcp_status" }))
            .await
        {
            Ok(started) => started,
            Err(error) => {
                warn!(
                    ?error,
                    "claude mcp: could not request the pre-prompt MCP status"
                );
                return;
            }
        };
        let cache = Arc::clone(&self.mcp_servers);
        let pending = Arc::clone(&self.pending_control);
        tokio::spawn(async move {
            let servers = match tokio::time::timeout(CONTROL_REQUEST_TIMEOUT, response).await {
                Ok(Ok(outcome)) => outcome.and_then(parse_mcp_status),
                // The query was dropped with the request still pending.
                Ok(Err(_closed)) => return,
                Err(_elapsed) => {
                    // The reader keeps unanswered entries for the query's life.
                    pending.lock().await.remove(&request_id);
                    Err(SdkError::Timeout)
                }
            };
            match servers {
                Ok(servers) => {
                    let mut cached = cache.lock().await;
                    if cached.is_empty() {
                        info!(
                            mcp_count = servers.len(),
                            "claude mcp: pre-prompt mcp_status response received"
                        );
                        *cached = servers;
                    }
                }
                Err(error) => warn!(?error, "claude mcp: pre-prompt mcp_status failed"),
            }
        });
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
        parse_mcp_status(response)
    }
}

fn parse_mcp_status(response: serde_json::Value) -> Result<Vec<McpServerStatus>, SdkError> {
    serde_json::from_value::<McpStatusResponse>(response)
        .map(|parsed| parsed.mcp_servers)
        .map_err(SdkError::SerializationError)
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

    /// A CLI still starting up answers the pre-prompt `mcp_status` only once
    /// it gets to it; the first prompt must not wait for that, and the late
    /// answer must still fill the cache.
    #[tokio::test]
    async fn the_pre_prompt_status_neither_holds_the_prompt_nor_drops_a_late_reply() {
        let dir = TempDir::new().unwrap();
        let script = r#"#!/bin/sh
set -e
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$INIT_ID"
read -r MCP_REQ
read -r USER_PROMPT
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[{"name":"late-server","status":"pending"}]}}}\n' "$MCP_ID"
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_late","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
read -r DUMMY
"#;
        let script_path = write_mock_cli(dir.path(), script);
        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();
        q.next().await.expect("init message").unwrap();

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let servers = q.available_mcp_servers().await.unwrap();
            if servers.iter().any(|server| server.name == "late-server") {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "late mcp_status reply never reached the cache: {servers:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        q.close().await;
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
