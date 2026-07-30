//! Process-wide ownership for agent stream-reader tasks.
//!
//! Readers outlive the WebSocket request that created them, so shutdown must
//! close their runtimes and join them before it drains provider-usage writes.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::domain::agents::adapter::RuntimeSessionWeakHandle;
use crate::domain::usage_stats::health;

#[allow(dead_code)] // Called by the service binary's shutdown module.
const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static READERS: LazyLock<Mutex<HashMap<u64, RegisteredReader>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct RegisteredReader {
    #[allow(dead_code)] // Read by the service binary's shutdown path.
    runtime: Option<RuntimeSessionWeakHandle>,
    task: JoinHandle<()>,
}

fn readers() -> std::sync::MutexGuard<'static, HashMap<u64, RegisteredReader>> {
    READERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn spawn<F>(runtime: Option<RuntimeSessionWeakHandle>, reader: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (start_tx, start_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        reader.await;
        readers().remove(&id);
    });
    readers().insert(id, RegisteredReader { runtime, task });
    let _ = start_tx.send(());
}

/// Close every runtime and wait for its reader to process the final events.
///
/// Called only after the bounded HTTP drain has ended, so no accepted request
/// can register another reader behind this snapshot.
#[allow(dead_code)] // Called by the service binary; lib tests compile without it.
pub(crate) async fn shutdown(pool: &sqlx::SqlitePool) {
    let entries = std::mem::take(&mut *readers())
        .into_values()
        .collect::<Vec<_>>();
    close_runtimes(&entries).await;
    let aborted = join_within(
        entries.into_iter().map(|entry| entry.task).collect(),
        READER_SHUTDOWN_TIMEOUT,
    )
    .await;
    if aborted == 0 {
        return;
    }

    let message = format!("{aborted} provider stream readers were cancelled before shutdown");
    tracing::warn!("{message}");
    if let Err(error) = health::record_persisted_loss(pool, 1, &message).await {
        tracing::error!(%error, "failed to persist cancelled stream readers");
        health::record_failure(&message);
    }
}

#[allow(dead_code)] // Reachable through `shutdown` in the service binary.
async fn close_runtimes(entries: &[RegisteredReader]) {
    let runtimes = entries
        .iter()
        .filter_map(|entry| entry.runtime.as_ref()?.upgrade())
        .collect::<Vec<_>>();
    let close_all = async {
        futures::future::join_all(runtimes.into_iter().map(|runtime| async move {
            runtime.write().await.close().await;
        }))
        .await;
    };
    if tokio::time::timeout(READER_SHUTDOWN_TIMEOUT, close_all)
        .await
        .is_err()
    {
        tracing::warn!("agent runtimes did not close before the stream-reader shutdown deadline");
    }
}

async fn join_within(mut handles: Vec<JoinHandle<()>>, timeout: Duration) -> u64 {
    let mut next = 0usize;
    if tokio::time::timeout(timeout, async {
        while next < handles.len() {
            report_join_result((&mut handles[next]).await);
            next += 1;
        }
    })
    .await
    .is_ok()
    {
        return 0;
    }

    for handle in &handles[next..] {
        handle.abort();
    }
    let mut aborted = 0u64;
    for handle in handles.into_iter().skip(next) {
        match handle.await {
            Err(error) if error.is_cancelled() => aborted = aborted.saturating_add(1),
            result => report_join_result(result),
        }
    }
    aborted
}

fn report_join_result(result: Result<(), tokio::task::JoinError>) {
    if let Err(error) = result {
        tracing::warn!(%error, "provider stream reader task failed");
    }
}

#[cfg(test)]
mod tests {
    use super::join_within;
    use std::time::Duration;

    #[tokio::test]
    async fn joins_finished_readers_and_counts_only_cancelled_readers() {
        let finished = tokio::spawn(async {});
        assert_eq!(join_within(vec![finished], Duration::from_secs(1)).await, 0);

        let blocked = tokio::spawn(std::future::pending::<()>());
        assert_eq!(
            join_within(vec![blocked], Duration::from_millis(1)).await,
            1
        );
    }
}
