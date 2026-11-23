//! Bind the listener once everything is ready, serve, then shut down.

use anyhow::Context;
use axum::serve::ListenerExt;
use tracing::info;

use crate::app_state::AppState;
use crate::config::Config;
use crate::{api, domain, shutdown};

pub(super) async fn bind_listener(addr: &str) -> anyhow::Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind Cadencr service listener on {addr}"))
}

pub(super) async fn serve(
    state: AppState,
    config: &Config,
    addr: &str,
    parent_watch: Option<shutdown::ParentWatch>,
) -> anyhow::Result<()> {
    let pty_manager = state.pty_manager.clone();
    let remote_for_shutdown = state.remote.clone();
    let backends_for_shutdown = state.plugin_tab_backends.clone();
    let write_pool_for_shutdown = state.write_pool.clone();
    let maintenance_read_pool = state.read_pool.clone();
    let maintenance_write_pool = state.write_pool.clone();
    let maintenance_events = state.storage_maintenance_events_tx.clone();
    let app = api::build_router(state).layer(api::cors::build_cors_layer(config.frontend_port));

    // Bound only now: until this point a client probing `/api/health` gets
    // ECONNREFUSED instead of a connection that stalls behind startup work.
    let listener = bind_listener(addr).await?;
    info!("Cadencr service listening on {addr}");
    // Disable Nagle's algorithm on every accepted connection. Nagle is
    // the default on `tokio::net::TcpStream` and silently coalesces
    // small frames for ~200 ms, which destroys real-time WS streaming.
    let listener = listener.tap_io(|stream| {
        if let Err(err) = stream.set_nodelay(true) {
            tracing::warn!("set_nodelay failed: {err}");
        }
    });
    // Start maintenance only after the listener is ready. The scheduler
    // adds its own delay so it cannot compete with session restore or
    // the user's first active turn.
    domain::maintenance::spawn(
        maintenance_read_pool,
        maintenance_write_pool,
        maintenance_events,
    );
    // Shutdown ordering lives in `shutdown`: the signal future only
    // closes the listener, then teardown and the HTTP drain run together.
    let (drain_tx, drain_rx) = tokio::sync::oneshot::channel();
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown::stop_admitting_on_signal(drain_tx, parent_watch));
    shutdown::serve_then_shutdown(
        server,
        drain_rx,
        pty_manager,
        remote_for_shutdown,
        backends_for_shutdown,
        write_pool_for_shutdown,
    )
    .await?;
    Ok(())
}
