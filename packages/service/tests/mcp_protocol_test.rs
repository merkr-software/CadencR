//! Exercise real server handlers over JSON-RPC, including Claude Code's
//! discovery-first startup. No CLI binary, model, or on-disk database is needed.

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
    let expected = match agent {
        AgentType::Browser => "browser_open_url",
        AgentType::Project => "project_spawn_session",
        AgentType::Workspace => "workspace_read_session",
    };
    assert!(
        tools.iter().any(|tool| tool["name"] == expected),
        "{result}"
    );
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
