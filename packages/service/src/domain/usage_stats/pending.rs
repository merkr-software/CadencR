//! Owns detached provider-usage writes until they either commit or are
//! cancelled and durably reported during shutdown.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::health;

const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static TASKS: LazyLock<Mutex<HashMap<u64, JoinHandle<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn tasks() -> std::sync::MutexGuard<'static, HashMap<u64, JoinHandle<()>>> {
    TASKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Run an awaited write on a task whose handle remains owned after caller
/// cancellation.
pub(super) async fn run_tracked<F>(write: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (finished_tx, finished_rx) = oneshot::channel();
    let (start_tx, start_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        write.await;
        // Normal completion reaps its own detached handle even when the caller
        // was cancelled. Panicked tasks deliberately remain for shutdown to
        // observe and report through their JoinHandle.
        tasks().remove(&id);
        let _ = finished_tx.send(());
    });
    tasks().insert(id, handle);
    let _ = start_tx.send(());

    let _ = finished_rx.await;
}

/// Finish every detached write, or cancel it before recording a durable loss.
///
/// A cancelled SQLx future rolls its transaction back before this function
/// writes the marker. Therefore a write cannot both commit later and remain
/// marked lost.
pub async fn flush(pool: &sqlx::SqlitePool) {
    flush_within(pool, FLUSH_TIMEOUT).await;
}

async fn flush_within(pool: &sqlx::SqlitePool, timeout: Duration) {
    let mut handles = tasks()
        .drain()
        .map(|(_, handle)| handle)
        .collect::<Vec<_>>();
    let mut next = 0usize;
    let drained = tokio::time::timeout(timeout, async {
        while next < handles.len() {
            report_join_result((&mut handles[next]).await);
            next += 1;
        }
    })
    .await;
    if drained.is_ok() {
        return;
    }

    for handle in &handles[next..] {
        handle.abort();
    }
    let mut cancelled = 0u64;
    for handle in handles.into_iter().skip(next) {
        match handle.await {
            Err(error) if error.is_cancelled() => cancelled = cancelled.saturating_add(1),
            result => report_join_result(result),
        }
    }
    if cancelled == 0 {
        return;
    }

    let message = format!("{cancelled} provider usage writes were cancelled before shutdown");
    tracing::warn!("{message}");
    if let Err(error) = health::record_persisted_loss(pool, cancelled, &message).await {
        tracing::error!(%error, "failed to persist cancelled usage writes");
        health::record_failure(&message);
    }
}

fn report_join_result(result: Result<(), tokio::task::JoinError>) {
    if let Err(error) = result {
        let message = format!("provider usage write task failed: {error}");
        tracing::warn!("{message}");
        health::record_failure(&message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn persisted(pool: &sqlx::SqlitePool) -> i64 {
        sqlx::query_scalar(
            "SELECT COALESCE((SELECT dropped_writes FROM usage_recording_losses), 0)",
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn flush_waits_for_a_detached_write() {
        let pool = pool().await;
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let landed = Arc::new(AtomicBool::new(false));
        let landed_by_write = Arc::clone(&landed);
        let caller = tokio::spawn(run_tracked(async move {
            started_tx.send(()).unwrap();
            let _ = release_rx.await;
            landed_by_write.store(true, Ordering::SeqCst);
        }));
        started_rx.await.unwrap();
        caller.abort();
        release_tx.send(()).unwrap();

        flush(&pool).await;

        assert!(landed.load(Ordering::SeqCst));
        assert_eq!(persisted(&pool).await, 0);
    }

    #[tokio::test]
    async fn timed_out_write_is_cancelled_before_loss_is_persisted() {
        let pool = pool().await;
        let (started_tx, started_rx) = oneshot::channel();
        let landed = Arc::new(AtomicBool::new(false));
        let landed_by_write = Arc::clone(&landed);
        let caller = tokio::spawn(run_tracked(async move {
            started_tx.send(()).unwrap();
            std::future::pending::<()>().await;
            landed_by_write.store(true, Ordering::SeqCst);
        }));
        started_rx.await.unwrap();
        caller.abort();

        flush_within(&pool, Duration::from_millis(1)).await;

        assert!(!landed.load(Ordering::SeqCst));
        assert_eq!(persisted(&pool).await, 1);
    }
}
