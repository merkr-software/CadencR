//! Orderly shutdown of the HTTP server.
//!
//! Two things have to happen in order, and the order is the whole point:
//! inbound work stops *before* axum drains the requests it already accepted,
//! and the usage writes are drained *after* that, once nothing can enqueue any
//! more. Doing the usage drain inside axum's shutdown future — before the HTTP
//! drain — would let a request that is still finishing hand off words nobody is
//! waiting for, and lose them without even counting them as lost.

use std::time::Duration;

use tokio::sync::oneshot;

/// How long the requests axum already accepted get to finish once the listener
/// is closed. A connection that never closes on its own — an idle WebSocket —
/// must not hold the usage drain hostage, so the wait is bounded.
const DRAIN_GRACE: Duration = Duration::from_secs(3);

/// The future handed to `with_graceful_shutdown`: waits for the signal, tears
/// down everything that could start new work, then resolves so axum stops
/// accepting and drains. `drained` fires at that same instant, which is what
/// tells the caller the HTTP drain has begun.
pub async fn teardown_on_signal(
    pty_manager: crate::domain::terminal::service::PtyManager,
    remote: std::sync::Arc<crate::remote::RemoteController>,
    drain_started: oneshot::Sender<()>,
) {
    wait_for_signal().await;
    tracing::info!("Shutdown signal received, shutting down gracefully...");

    // Drop the remote listener first so no new remote-driven work starts while
    // we tear the rest down. Bounded so a hung remote WS can't block quit.
    remote.stop().await;

    pty_manager.kill_all();
    crate::domain::agents::shutdown_runtime_servers().await;
    tracing::info!("Runtime servers stopped.");

    let _ = drain_started.send(());
}

/// Serve until shutdown, then flush the usage writes.
///
/// The flush waits for the HTTP drain (bounded by [`DRAIN_GRACE`]) so the words
/// of the very last request are already in flight by the time we wait for them.
pub async fn serve_then_flush<S>(
    server: S,
    drain_started: oneshot::Receiver<()>,
    write_pool: sqlx::SqlitePool,
) -> std::io::Result<()>
where
    S: std::future::IntoFuture<Output = std::io::Result<()>>,
{
    serve_then_flush_within(server, drain_started, write_pool, DRAIN_GRACE).await
}

/// [`serve_then_flush`] with the grace period spelled out, so a test can assert
/// the timeout path without waiting the real one out.
async fn serve_then_flush_within<S>(
    server: S,
    drain_started: oneshot::Receiver<()>,
    write_pool: sqlx::SqlitePool,
    grace: Duration,
) -> std::io::Result<()>
where
    S: std::future::IntoFuture<Output = std::io::Result<()>>,
{
    let mut server = std::pin::pin!(server.into_future());
    let mut drain_started = drain_started;

    let served = tokio::select! {
        // The server can also stop on its own — a listener error, say — in
        // which case there is no drain left to wait for.
        result = &mut server => result,
        _ = &mut drain_started => match tokio::time::timeout(grace, &mut server).await {
            Ok(result) => result,
            Err(_) => {
                tracing::warn!("connections were still open after the shutdown grace period");
                Ok(())
            }
        },
    };

    crate::domain::usage_stats::flush_pending_writes(&write_pool).await;
    served
}

async fn wait_for_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::{serve_then_flush, serve_then_flush_within};
    use std::time::Duration;
    use tokio::sync::oneshot;

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn flushes_only_once_the_drain_has_finished() {
        let pool = pool().await;
        let (drain_tx, drain_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let server = async move {
            let _ = finish_rx.await;
            Ok(())
        };

        let served = tokio::spawn(serve_then_flush(server, drain_rx, pool));
        // The drain has begun, but the last request has not finished: nothing
        // may be flushed yet.
        drain_tx.send(()).unwrap();
        tokio::task::yield_now().await;
        assert!(!served.is_finished(), "the flush waited for the drain");

        finish_tx.send(()).unwrap();
        served.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn does_not_wait_forever_on_a_connection_that_never_closes() {
        let pool = pool().await;
        let (drain_tx, drain_rx) = oneshot::channel();

        let served = tokio::spawn(serve_then_flush_within(
            std::future::pending::<std::io::Result<()>>(),
            drain_rx,
            pool,
            Duration::from_millis(20),
        ));
        drain_tx.send(()).unwrap();

        // A connection that never closes: the grace period expires, and the
        // flush still runs rather than shutdown hanging on it.
        assert!(served.await.unwrap().is_ok());
    }
}
