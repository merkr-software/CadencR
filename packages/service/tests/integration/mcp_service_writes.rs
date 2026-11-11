//! `mcp-serve` never writes the database. These tools run on a read-only pool,
//! opened the way `mcp-serve` opens it, and every write they cause goes through
//! the real service router, which commits it and tells connected clients.

use std::sync::Arc;
use std::time::Duration;

use cadencr_service::domain::mcp::context::McpContext;
use cadencr_service::domain::mcp::control_grant::McpControlServer;
use cadencr_service::domain::mcp::tools::project::run_project_tool;
use cadencr_service::domain::ws_session::protocol::WsEnvelope;
use cadencr_service::shared::db;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{http::HeaderValue, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::common::{start_migrated_test_server, TestServer, TEST_AUTH_TOKEN};
use crate::support::mcp_service::mcp_context;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const SOURCE_FEATURE: i64 = 1;
const SOURCE_SESSION: i64 = 10;
const TARGET_FEATURE: i64 = 2;
const TARGET_SESSION: i64 = 20;

/// The test service plus two conversations of its project: the caller's
/// (feature 1, session 10) and a target (feature 2, session 20).
async fn service() -> TestServer {
    let server = start_migrated_test_server().await;
    // The service's own write pool runs in WAL mode; a read-only connection
    // cannot switch the journal mode itself.
    sqlx::query("PRAGMA journal_mode = WAL")
        .execute(&server.pool)
        .await
        .unwrap();
    sqlx::raw_sql(
        "INSERT INTO features (id, project_id, title, status, type)
             VALUES (2, 1, 'Target', 'active', 'ws-session');
         INSERT INTO agent_sessions (id, feature_id, agent_type, status)
             VALUES (10, 1, 'session', 'running'), (20, 2, 'session', 'paused');",
    )
    .execute(&server.pool)
    .await
    .unwrap();
    server
}

/// The context `mcp-serve` builds: a read-only pool on the service's database.
async fn mcp_serve_context(server: &TestServer) -> Arc<McpContext> {
    let db_path = server.tmp_dir.path().join("test.db");
    let read_pool = db::create_read_pool(db_path.to_str().unwrap())
        .await
        .unwrap();
    mcp_context(
        read_pool,
        server.base_url.clone(),
        McpControlServer::Project,
        SOURCE_FEATURE,
        SOURCE_SESSION,
    )
}

fn tool_json(result: rmcp::model::CallToolResult) -> Value {
    let value = serde_json::to_value(result).unwrap();
    let text = value["content"][0]["text"].as_str().unwrap();
    assert_ne!(value["isError"], true, "tool failed: {text}");
    serde_json::from_str(text).unwrap()
}

async fn audit_rows(server: &TestServer, tool: &str) -> Vec<(String, i64, i64, Option<i64>)> {
    sqlx::query_as(
        "SELECT status, source_session_id, source_project_id, target_session_id
         FROM mcp_tool_audit_log WHERE tool_name = ?",
    )
    .bind(tool)
    .fetch_all(&server.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn link_sessions_writes_through_the_service() {
    let server = service().await;
    let ctx = mcp_serve_context(&server).await;

    let body = tool_json(
        run_project_tool(
            "project_link_sessions",
            json!({"target_session_id": TARGET_SESSION, "link_type": "handoff", "note": "n"}),
            ctx,
        )
        .await,
    );

    let link: (i64, i64, String, String) = sqlx::query_as(
        "SELECT source_session_id, target_session_id, link_type, note
         FROM agent_session_links WHERE id = ?",
    )
    .bind(body["link_id"].as_i64().unwrap())
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(
        link,
        (SOURCE_SESSION, TARGET_SESSION, "handoff".into(), "n".into())
    );
    assert_eq!(body["link_type"], "handoff");
    assert_eq!(
        audit_rows(&server, "project_link_sessions").await,
        [("ok".to_string(), SOURCE_SESSION, 1, Some(TARGET_SESSION))]
    );
}

#[tokio::test]
async fn project_read_tools_record_their_audit_through_the_service() {
    let server = service().await;
    let ctx = mcp_serve_context(&server).await;

    let body = tool_json(
        run_project_tool(
            "project_read_session",
            json!({"session_id": TARGET_SESSION}),
            ctx,
        )
        .await,
    );

    assert_eq!(body["session"]["id"], TARGET_SESSION);
    assert_eq!(
        audit_rows(&server, "project_read_session").await,
        [("ok".to_string(), SOURCE_SESSION, 1, Some(TARGET_SESSION))]
    );
}

/// A tool that changes state never falls back to writing the database: when
/// the service does not answer, or this subprocess has no way to reach it, the
/// agent gets an error and nothing is written.
#[tokio::test]
async fn without_the_service_tools_fail_and_write_nothing() {
    let server = service().await;
    let read_pool = mcp_serve_context(&server).await.read_pool.clone();
    let closed_port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let unreachable = mcp_context(
        read_pool.clone(),
        format!("http://127.0.0.1:{closed_port}"),
        McpControlServer::Project,
        SOURCE_FEATURE,
        SOURCE_SESSION,
    );
    let unconfigured = Arc::new(
        McpContext::builder()
            .read_pool(read_pool)
            .feature_id(SOURCE_FEATURE)
            .source_session_id(SOURCE_SESSION)
            .build(),
    );

    for (ctx, expected) in [
        (unreachable, "Control endpoint request failed"),
        (
            unconfigured,
            "Cannot reach the Cadencr service, so this call could not be completed",
        ),
    ] {
        for (tool, args) in [
            (
                "project_link_sessions",
                json!({"target_session_id": TARGET_SESSION}),
            ),
            (
                "project_read_session",
                json!({"session_id": TARGET_SESSION}),
            ),
        ] {
            let value =
                serde_json::to_value(run_project_tool(tool, args, ctx.clone()).await).unwrap();
            assert_eq!(value["isError"], true, "{tool}: {value}");
            let text = value["content"][0]["text"].as_str().unwrap();
            assert!(text.contains(expected), "{tool}: {text}");
        }
    }
    let written: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM agent_session_links), (SELECT COUNT(*) FROM mcp_tool_audit_log)",
    )
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(written, (0, 0));
}

/// The sidebar nests a conversation under the one that spawned or handed off
/// to it; a link the agent adds must reach every open window without a reload.
#[tokio::test]
async fn a_link_made_through_mcp_reaches_websocket_clients() {
    let server = service().await;
    let ctx = mcp_serve_context(&server).await;
    let mut socket = connect(&server.base_url).await;
    send(&mut socket, "app", "subscribe.feature_events", json!({})).await;
    // The snapshot reply proves the subscription before it was handled.
    send(&mut socket, "app", "subscribe.session_status", json!({})).await;
    next_matching(&mut socket, "session_status.snapshot").await;

    tool_json(
        run_project_tool(
            "project_link_sessions",
            json!({"target_session_id": TARGET_SESSION, "link_type": "spawned"}),
            ctx,
        )
        .await,
    );

    let event = next_matching(&mut socket, "feature_event").await;
    assert_eq!(event["domain"], "app");
    assert_eq!(event["payload"]["feature_id"], TARGET_FEATURE);
    assert_eq!(event["payload"]["project_id"], 1);
    assert_eq!(event["payload"]["action"], "updated");
}

async fn connect(base: &str) -> Socket {
    let mut request = format!("{}/ws", base.replace("http://", "ws://"))
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&format!("cadencr-token.{TEST_AUTH_TOKEN}")).unwrap(),
    );
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

async fn send(socket: &mut Socket, domain: &str, action: &str, payload: Value) {
    let envelope = WsEnvelope::new(domain, action, payload);
    socket
        .send(Message::Text(String::from(envelope).into()))
        .await
        .unwrap();
}

async fn next_matching(socket: &mut Socket, action: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let message = tokio::time::timeout_at(deadline, socket.next())
            .await
            .unwrap_or_else(|_| panic!("no `{action}` envelope"))
            .expect("WS closed")
            .unwrap();
        match message {
            Message::Text(text) => {
                let envelope: Value = serde_json::from_str(&text).unwrap();
                if envelope["action"] == action {
                    return envelope;
                }
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
            Message::Close(frame) => panic!("unexpected close: {frame:?}"),
            _ => {}
        }
    }
}
