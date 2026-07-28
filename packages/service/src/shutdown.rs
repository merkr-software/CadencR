//! Orderly shutdown of the HTTP server.
//!
//! Three things have to happen in order, and the order is the whole point:
//!
//! 1. Stop admitting work. The listener closes the instant axum's shutdown
//!    future resolves, so that future does nothing but wait for the signal —
//!    anything it did first would be time spent still accepting new requests
//!    against services we are in the middle of tearing down.
//! 2. Tear down what is already running (remote listener, PTYs, agent runtimes)
//!    while axum drains the requests it had already accepted. Concurrently: the
//!    teardown is what lets a live agent stream end, so serialising them would
//!    guarantee the drain runs out its grace period on every quit.

use std::future::Future;
use std::time::Duration;

use tokio::sync::oneshot;

/// How long the requests axum already accepted get to finish once the listener
/// is closed. A connection that never closes on its own — an idle WebSocket —
/// must not hold shutdown hostage, so the wait is bounded.
const DRAIN_GRACE: Duration = Duration::from_secs(3);

/// The future handed to `with_graceful_shutdown`. It resolves as soon as the
/// signal arrives and does nothing else: resolving is what closes the listener,
/// so every extra await here is another moment spent accepting requests we have
/// already decided not to serve. `drain_started` fires at that same instant,
/// which is what tells the caller the HTTP drain has begun.
pub async fn stop_admitting_on_signal(drain_started: oneshot::Sender<()>) {
    wait_for_signal().await;
    tracing::info!("Shutdown signal received, shutting down gracefully...");
    let _ = drain_started.send(());
}

/// Serve until shutdown while tearing down background work alongside the
/// bounded HTTP drain.
pub async fn serve_then_shutdown<S>(
    server: S,
    drain_started: oneshot::Receiver<()>,
    pty_manager: crate::domain::terminal::service::PtyManager,
    remote: std::sync::Arc<crate::remote::RemoteController>,
) -> std::io::Result<()>
where
    S: std::future::IntoFuture<Output = std::io::Result<()>>,
{
    serve_then_shutdown_within(
        server,
        drain_started,
        stop_background_work(pty_manager, remote),
        DRAIN_GRACE,
    )
    .await
}

/// Everything that keeps running after the listener closes. Nothing here is
/// reached until the drain starts — an `async fn` body does not run until it is
/// polled.
async fn stop_background_work(
    pty_manager: crate::domain::terminal::service::PtyManager,
    remote: std::sync::Arc<crate::remote::RemoteController>,
) {
    // Drop the remote listener first: it has its own admission path, so it is
    // the one thing that could still start new work. Bounded internally so a
    // hung remote WS can't block quit.
    remote.stop().await;

    pty_manager.kill_all();
    crate::domain::agents::shutdown_runtime_servers().await;
    tracing::info!("Runtime servers stopped.");
}

/// [`serve_then_shutdown`] with the teardown and grace period spelled out, so a
/// test can assert the ordering without real processes or the real timeout.
async fn serve_then_shutdown_within<S, T>(
    server: S,
    drain_started: oneshot::Receiver<()>,
    teardown: T,
    grace: Duration,
) -> std::io::Result<()>
where
    S: std::future::IntoFuture<Output = std::io::Result<()>>,
    T: Future<Output = ()>,
{
    let mut server = std::pin::pin!(server.into_future());
    let mut drain_started = drain_started;

    // The server can also stop on its own — a listener error, say — in which
    // case there is no drain left to wait for. `biased`, because on a clean quit
    // the drain finishes so fast that both branches are ready in the same poll,
    // and an unbiased select would pick between them at random: half of all
    // shutdowns would take the "stopped on its own" path.
    let stopped_on_its_own = tokio::select! {
        biased;
        _ = &mut drain_started => None,
        result = &mut server => Some(result),
    };

    match stopped_on_its_own {
        Some(result) => {
            teardown.await;
            result
        }
        // Tear down alongside the drain rather than after it: the teardown is
        // what lets a live agent stream end, so serialising them would run the
        // grace period out on every quit that has a WebSocket open.
        None => {
            let (drained, ()) = tokio::join!(tokio::time::timeout(grace, &mut server), teardown);
            drained.unwrap_or_else(|_| {
                tracing::warn!("connections were still open after the shutdown grace period");
                Ok(())
            })
        }
    }
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
    use super::serve_then_shutdown_within;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn tears_down_background_work_while_the_drain_runs() {
        let (drain_tx, drain_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let server = async move {
            let _ = finish_rx.await;
            Ok(())
        };
        let torn_down = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&torn_down);

        let served = tokio::spawn(serve_then_shutdown_within(
            server,
            drain_rx,
            async move { flag.store(true, Ordering::Relaxed) },
            Duration::from_secs(30),
        ));
        drain_tx.send(()).unwrap();
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        // The teardown is what lets a live stream end, so it must not wait on
        // the connections it is trying to release…
        assert!(
            torn_down.load(Ordering::Relaxed),
            "background work is torn down while the drain is still running"
        );
        // The server still waits for the accepted request to finish.
        assert!(!served.is_finished(), "the server waited for the drain");

        finish_tx.send(()).unwrap();
        served.await.unwrap().unwrap();
    }

    // On a quit with nothing in flight the drain finishes in the same poll the
    // signal arrives in, so both halves of the select are ready at once. The
    // teardown has to run anyway — this is the case that leaves PTYs and agent
    // runtimes behind when it doesn't.
    #[tokio::test]
    async fn tears_down_even_when_the_drain_finishes_instantly() {
        for _ in 0..20 {
            let (drain_tx, drain_rx) = oneshot::channel();
            let torn_down = Arc::new(AtomicBool::new(false));
            let flag = Arc::clone(&torn_down);
            drain_tx.send(()).unwrap();

            serve_then_shutdown_within(
                std::future::ready(Ok(())),
                drain_rx,
                async move { flag.store(true, Ordering::Relaxed) },
                Duration::from_secs(30),
            )
            .await
            .unwrap();

            assert!(
                torn_down.load(Ordering::Relaxed),
                "background work is torn down however fast the drain completes"
            );
        }
    }

    #[tokio::test]
    async fn tears_down_when_the_server_stops_without_a_signal() {
        let (_drain_tx, drain_rx) = oneshot::channel();
        let torn_down = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&torn_down);

        // A listener error ends the server with no shutdown signal at all; the
        // processes it spawned still have to go.
        let failed = std::future::ready(Err(std::io::Error::other("listener died")));
        let served = serve_then_shutdown_within(
            failed,
            drain_rx,
            async move { flag.store(true, Ordering::Relaxed) },
            Duration::from_secs(30),
        )
        .await;

        assert!(served.is_err(), "the listener error reaches the caller");
        assert!(torn_down.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn does_not_wait_forever_on_a_connection_that_never_closes() {
        let (drain_tx, drain_rx) = oneshot::channel();

        let served = tokio::spawn(serve_then_shutdown_within(
            std::future::pending::<std::io::Result<()>>(),
            drain_rx,
            std::future::ready(()),
            Duration::from_millis(20),
        ));
        drain_tx.send(()).unwrap();

        // A connection that never closes: the grace period expires rather than
        // hanging shutdown forever.
        assert!(served.await.unwrap().is_ok());
    }
}
