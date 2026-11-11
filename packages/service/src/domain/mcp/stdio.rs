//! MCP stdio server entry point. Each subprocess is pinned to a single
//! `feature_id`, stored on `McpContext` and checked at every tool call.
//! Tools read it via plain field access rather than a task-local scope —
//! `rmcp` sometimes dispatches handlers on freshly-spawned tokio tasks that
//! wouldn't inherit a task-local, which was breaking the workflow path.
//! The process opens the database read-only and changes state only through
//! the service's `/internal/mcp/*` routes.

use std::sync::Arc;

use rmcp::ServiceExt;
use tracing::info;

use super::context::McpContext;
use super::control_client::McpControlClient;
use super::servers::McpServer;
use crate::shared::db;

pub async fn run_mcp_stdio(
    db_path: &str,
    agent_type_str: &str,
    feature_id: i64,
    source_session_id: Option<i64>,
) -> anyhow::Result<()> {
    let agent_type: super::servers::AgentType = agent_type_str
        .parse()
        .map_err(|e: String| anyhow::anyhow!(e))?;

    info!(
        agent_type = agent_type_str,
        feature_id, "starting MCP stdio server"
    );

    // Read-only: every write a tool causes goes through the service over the
    // control client, so this process never competes for the write lock nor
    // changes state without the service broadcasting it.
    let read_pool = db::create_read_pool(db_path).await?;
    let ctx = Arc::new(
        McpContext::builder()
            .read_pool(read_pool)
            .feature_id(feature_id)
            .maybe_source_session_id(source_session_id)
            .control(McpControlClient::from_env())
            .build(),
    );

    let server = super::servers::create_mcp_server(agent_type, ctx);
    let stdio = rmcp::transport::io::stdio();

    let quit_reason = match server {
        McpServer::Browser(s) => s.serve(stdio).await?.waiting().await,
        McpServer::Project(s) => s.serve(stdio).await?.waiting().await,
        McpServer::Workspace(s) => s.serve(stdio).await?.waiting().await,
    };

    info!(?quit_reason, "MCP stdio server shutting down");
    Ok(())
}
