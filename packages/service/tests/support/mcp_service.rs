#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;

use cadencr_service::api;
use cadencr_service::app_state::AppState;
use cadencr_service::domain::mcp::control_client::McpControlClient;
use cadencr_service::domain::mcp::control_grant::{
    McpControlGrant, McpControlServer, TEST_MCP_CONTROL_SECRET,
};
use cadencr_service::domain::mcp::McpContext;
use sqlx::SqlitePool;
use tokio::net::TcpListener;

/// The real router (control middleware included) serving `pool` on loopback.
pub async fn serve(pool: SqlitePool) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut state = AppState::with_pool(pool);
    state.port = port;
    let app = api::build_router(state);
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    format!("http://127.0.0.1:{port}")
}

/// The context of an MCP subprocess that a service built on
/// `AppState::with_pool`, at `service_url`, started for
/// (`feature_id`, `session_id`) on `server`, reading `read_pool`.
pub fn mcp_context(
    read_pool: SqlitePool,
    service_url: String,
    server: McpControlServer,
    feature_id: i64,
    session_id: i64,
) -> Arc<McpContext> {
    let token = McpControlGrant {
        server,
        feature_id,
        session_id,
    }
    .mint(TEST_MCP_CONTROL_SECRET);
    Arc::new(
        McpContext::builder()
            .read_pool(read_pool)
            .feature_id(feature_id)
            .source_session_id(session_id)
            .control(McpControlClient::from_env_values(
                Some(service_url),
                Some(token),
            ))
            .build(),
    )
}

/// A service on `pool` and the context of an MCP subprocess reading the same
/// database: the in-memory test databases cannot be opened twice.
pub async fn served_mcp_context(
    pool: SqlitePool,
    server: McpControlServer,
    feature_id: i64,
    session_id: i64,
) -> Arc<McpContext> {
    let url = serve(pool.clone()).await;
    mcp_context(pool, url, server, feature_id, session_id)
}
