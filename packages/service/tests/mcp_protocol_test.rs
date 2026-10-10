//! Exercise real server handlers over JSON-RPC, including Claude Code's
//! discovery-first startup. No CLI binary, model, or on-disk database is needed.
//!
//! Own test binary: it calls `settings_store::init` (a first-call-wins
//! `OnceLock`) with a tempdir that is deleted when the test ends.

mod support;

use std::sync::Arc;
use std::time::Duration;

use cadencr_service::domain::mcp::{
    servers::{create_mcp_server, AgentType, McpServer},
    McpContext,
};
use rmcp::ServiceExt;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
use tokio::task::JoinHandle;

const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MODERN_VERSION: &str = "2026-07-28";

struct WireClient {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    server: JoinHandle<()>,
}

impl WireClient {
    fn connect(agent: AgentType) -> Self {
        let pool = sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap();
        let ctx = McpContext::new(pool.clone(), pool, 1);
        Self::with_context(agent, ctx)
    }

    fn with_context(agent: AgentType, ctx: Arc<McpContext>) -> Self {
        let server = create_mcp_server(agent, ctx);
        let (client_io, server_io) = tokio::io::duplex(65536);
        let server = tokio::spawn(async move {
            match server {
                McpServer::Browser(s) => s.serve(server_io).await.unwrap().waiting().await,
                McpServer::Project(s) => s.serve(server_io).await.unwrap().waiting().await,
                McpServer::Workspace(s) => s.serve(server_io).await.unwrap().waiting().await,
            }
            .unwrap();
        });
        let (reader, writer) = tokio::io::split(client_io);
        Self {
            reader: BufReader::new(reader),
            writer,
            server,
        }
    }

    async fn send(&mut self, message: Value) {
        let line = format!("{message}\n");
        tokio::time::timeout(IO_TIMEOUT, self.writer.write_all(line.as_bytes()))
            .await
            .expect("MCP write timed out")
            .unwrap();
    }

    async fn request(&mut self, id: Value, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await;
        let mut line = String::new();
        tokio::time::timeout(IO_TIMEOUT, self.reader.read_line(&mut line))
            .await
            .expect("MCP response timed out")
            .unwrap();
        let mut response: Value = serde_json::from_str(&line).expect("MCP JSON response");
        assert_eq!(response["id"], id, "{response}");
        assert!(response.get("error").is_none(), "{response}");
        response["result"].take()
    }
}

impl Drop for WireClient {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn modern_meta() -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {"name": "protocol-test", "version": "1"}
    })
}

fn assert_tool_catalog(agent: AgentType, result: &Value) {
    let tools = result["tools"].as_array().expect("tools array");
    // Keep the expected public contract independent of the production catalogs.
    let expected: &[&str] = match agent {
        AgentType::Browser => &[
            "browser_list_tabs",
            "browser_open_url",
            "browser_open_external_url",
            "browser_get_console",
            "browser_get_network",
            "browser_get_snapshot",
            "browser_screenshot",
            "browser_click",
            "browser_fill",
            "browser_hover",
            "browser_type",
            "browser_keypress",
            "browser_wait_for",
            "browser_evaluate",
            "browser_select_element_context",
        ],
        AgentType::Project => &[
            "project_list_sessions",
            "project_read_session",
            "project_read_session_tail",
            "project_get_session_status",
            "project_get_worktree_status",
            "project_find_related_sessions",
            "project_compare_sessions",
            "project_link_sessions",
            "project_list_agent_providers",
            "project_spawn_session",
            "project_send_session_message",
            "project_list_pending_gates",
            "project_respond_gate",
        ],
        AgentType::Workspace => &[
            "workspace_list_projects",
            "workspace_read_session",
            "workspace_read_sessions",
            "workspace_session_graph",
            "workspace_recent_activity",
            "workspace_send_session_message",
        ],
    };
    let mut actual: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name"))
        .collect();
    let mut expected = expected.to_vec();
    actual.sort_unstable();
    expected.sort_unstable();
    assert_eq!(actual, expected, "{} catalog", agent.short_name());
}

#[tokio::test]
async fn discovery_first_lists_tools_and_dispatches_calls_for_every_server() {
    for &agent in AgentType::ALL {
        let mut client = WireClient::connect(agent);
        let discovery = client
            .request(
                json!("probe"),
                "server/discover",
                json!({"_meta": modern_meta()}),
            )
            .await;
        assert!(discovery["supportedVersions"]
            .as_array()
            .unwrap()
            .contains(&json!(MODERN_VERSION)));
        assert_eq!(discovery["resultType"], "complete");
        assert_eq!(discovery["cacheScope"], "private");
        assert_eq!(discovery["ttlMs"], 0);
        if matches!(agent, AgentType::Project) {
            assert!(discovery["instructions"]
                .as_str()
                .unwrap()
                .contains("reactive"));
        }

        let tools = client
            .request(json!(1), "tools/list", json!({"_meta": modern_meta()}))
            .await;
        assert_tool_catalog(agent, &tools);
        // SEP-2549 requires these fields. Omitting them caused issue #208.
        assert_eq!(tools["resultType"], "complete");
        assert_eq!(tools["ttlMs"], 0);
        assert_eq!(tools["cacheScope"], "private");

        // An unknown tool exercises dispatch without touching a browser or session.
        let call = client
            .request(
                json!(2),
                "tools/call",
                json!({"name": "unknown_test_tool", "arguments": {}, "_meta": modern_meta()}),
            )
            .await;
        assert_eq!(call["resultType"], "complete");
        assert_eq!(call["isError"], true);
        assert!(call["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Unknown tool"));
    }
}

#[tokio::test]
async fn legacy_clients_still_initialize_and_list_tools_without_metadata() {
    for &agent in AgentType::ALL {
        for version in ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] {
            let mut client = WireClient::connect(agent);
            let init = client
                .request(
                    json!(0),
                    "initialize",
                    json!({
                        "protocolVersion": version,
                        "capabilities": {},
                        "clientInfo": {"name": "legacy-test", "version": "1"}
                    }),
                )
                .await;
            assert_eq!(init["protocolVersion"], version);
            assert_eq!(
                init["serverInfo"]["name"],
                format!("cadencr-{}", agent.short_name())
            );
            client
                .send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
                .await;
            let tools = client.request(json!(1), "tools/list", json!({})).await;
            assert_tool_catalog(agent, &tools);
            assert!(tools.get("resultType").is_none(), "{tools}");
        }
    }
}

/// A valid call must reach the database-backed handler and return its data,
/// both after modern discovery and after legacy initialization.
#[tokio::test]
async fn real_workspace_tool_succeeds_over_modern_and_legacy_wire() {
    let settings_dir = tempfile::tempdir().unwrap();
    cadencr_service::domain::settings_store::init(settings_dir.path().to_path_buf());
    let pool = support::mcp_control::seeded_control_pool().await;
    let ctx = McpContext::new_with_source_session(pool.clone(), pool, 42, Some(777));

    for modern in [true, false] {
        let mut client = WireClient::with_context(AgentType::Workspace, ctx.clone());
        let metadata = if modern {
            client
                .request(json!(0), "server/discover", json!({"_meta": modern_meta()}))
                .await;
            json!({"_meta": modern_meta()})
        } else {
            client
                .request(
                    json!(0),
                    "initialize",
                    json!({
                        "protocolVersion": "2025-11-25",
                        "capabilities": {},
                        "clientInfo": {"name": "legacy-test", "version": "1"}
                    }),
                )
                .await;
            client
                .send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
                .await;
            json!({})
        };

        // Repeat on the same connection to cover dispatch after the first call.
        for id in [1, 3] {
            let tools = client
                .request(json!(id), "tools/list", metadata.clone())
                .await;
            assert_tool_catalog(AgentType::Workspace, &tools);
            let mut params = metadata.clone();
            params["name"] = json!("workspace_list_projects");
            params["arguments"] = json!({});
            let call = client.request(json!(id + 1), "tools/call", params).await;
            assert_eq!(call["isError"], false, "{call}");
            if modern {
                assert_eq!(call["resultType"], "complete");
            } else {
                assert!(call.get("resultType").is_none(), "{call}");
            }
            assert_eq!(call["content"][0]["type"], "text");
            let body: Value =
                serde_json::from_str(call["content"][0]["text"].as_str().unwrap()).unwrap();
            let projects = body["projects"].as_array().expect("projects array");
            assert_eq!(projects.len(), 1);
            assert_eq!(projects[0]["id"], 7);
            assert_eq!(projects[0]["name"], "Proj");
            assert_eq!(projects[0]["path"], "/tmp/proj");
        }
    }
}
