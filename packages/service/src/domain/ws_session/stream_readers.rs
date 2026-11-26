//! Process-wide ownership for agent stream-reader tasks.
//!
//! Readers outlive the WebSocket request that created them, so shutdown must
//! close their runtimes and join them before it drains provider-usage writes.

use crate::shared::discard::SendIgnoreClosed;
use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use futures::FutureExt;
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, WaitForCancellationFuture};

use crate::domain::agents::adapter::RuntimeSessionWeakHandle;
use crate::domain::usage_stats::health;

mod signals;
pub(crate) use signals::{ReaderSignals, TRANSCRIPT_SETTLE_TIMEOUT};

#[allow(dead_code)] // Called by the service binary's shutdown module.
pub(crate) const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// Cancelled once shutdown starts closing the runtimes.
static CLOSING: LazyLock<CancellationToken> = LazyLock::new(CancellationToken::new);
static READERS: LazyLock<Mutex<HashMap<uuid::Uuid, RegisteredReader>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct RegisteredReader {
    #[allow(dead_code)] // Read during process shutdown.
    db_session_id: i64,
    /// Read by the service binary's shutdown path and by
    /// [`wait_for_settled_transcript`].
    runtime: Option<RuntimeSessionWeakHandle>,
    signals: ReaderSignals,
    task: JoinHandle<()>,
}

fn readers() -> std::sync::MutexGuard<'static, HashMap<uuid::Uuid, RegisteredReader>> {
    READERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn spawn<F>(
    db_session_id: i64,
    runtime: Option<RuntimeSessionWeakHandle>,
    signals: ReaderSignals,
    write_pool: sqlx::SqlitePool,
    reader: F,
) where
    F: Future<Output = ()> + Send + 'static,
{
    let id = signals.reader_id;
    let (start_tx, start_rx) = tokio::sync::oneshot::channel();
    let ledger_runtime = runtime.clone();
    let settle_guard = signals.settle_on_drop();
    let task = tokio::spawn(async move {
        let _settled = settle_guard;
        if start_rx.await.is_err() {
            return;
        }
        // Recorded for the reader's lifetime, which is the runtime's: a start
        // after a hard kill stops the agent process if it outlived us. Off the
        // reader's path, so the first event is not held behind the write.
        let ledger_entry = tokio::spawn(record_agent_process(db_session_id, ledger_runtime));
        let panicked = AssertUnwindSafe(reader).catch_unwind().await.is_err();
        let ledger_entry = ledger_entry.await.unwrap_or_else(|error| {
            tracing::warn!(db_session_id, %error, "recording an agent process failed");
            None
        });
        if panicked {
            tracing::error!(db_session_id, reader_id = %id, "agent stream reader panicked");
            clean_up_panicked_reader(&write_pool, db_session_id, id).await;
            // The runtime may still be alive. Keep its ledger entry for startup.
        } else {
            crate::domain::restart_continuations::forget_agent_process(ledger_entry).await;
        }
        readers().remove(&id);
    });
    readers().insert(
        id,
        RegisteredReader {
            db_session_id,
            runtime,
            signals,
            task,
        },
    );
    start_tx.send_ignore_closed(());
}

async fn clean_up_panicked_reader(pool: &sqlx::SqlitePool, session_id: i64, id: uuid::Uuid) {
    use crate::domain::restart_continuations::{end_background_work, is_shutting_down};

    if let Err(error) =
        end_background_work(pool, session_id, &id.to_string(), is_shutting_down()).await
    {
        tracing::error!(session_id, reader_id = %id, %error, "could not clear the panicked reader's background work");
    }
}

fn session_signals(db_session_id: i64) -> Vec<ReaderSignals> {
    readers()
        .values()
        .filter(|entry| entry.db_session_id == db_session_id)
        .map(|entry| entry.signals.clone())
        .collect()
}

pub(crate) async fn wait_for_session_transcript(session_id: i64) -> bool {
    let tokens = session_signals(session_id)
        .into_iter()
        .map(|signals| signals.settled_token())
        .collect();
    signals::wait_all_settled(tokens, TRANSCRIPT_SETTLE_TIMEOUT).await
}

/// A viewer attached to `db_session_id`: ask its readers to re-send the full
/// text of their live blocks. A viewer's history snapshot is read before its
/// socket is bound and before buffered deltas reach the database, so without
/// this the chunks in between are never shown (see `ws-session-resync.ts`).
pub(crate) fn request_live_catch_up(db_session_id: i64) {
    for signals in session_signals(db_session_id) {
        signals.request_catch_up();
    }
}

/// Wait until the reader of `runtime` has written its last transcript row (a
/// closed runtime's reader flushes its buffered text as it ends), or until
/// `timeout`. Returns whether it did; a runtime with no reader has nothing
/// left to write.
pub(crate) async fn wait_for_settled_transcript(
    runtime: &RuntimeSessionWeakHandle,
    timeout: Duration,
) -> bool {
    let tokens = readers()
        .values()
        .filter(|entry| {
            entry
                .runtime
                .as_ref()
                .is_some_and(|reader_runtime| reader_runtime.ptr_eq(runtime))
        })
        .map(|entry| entry.signals.settled_token())
        .collect();
    signals::wait_all_settled(tokens, timeout).await
}

async fn record_agent_process(
    db_session_id: i64,
    runtime: Option<RuntimeSessionWeakHandle>,
) -> Option<i64> {
    let runtime = runtime?.upgrade()?;
    let pid = runtime.read().await.pid()?;
    crate::domain::restart_continuations::record_agent_process(db_session_id, pid).await
}

/// Resolves once shutdown starts closing the runtimes. Work that holds a
/// runtime only to refresh what clients show gives it up then, so the close
/// does not wait on it.
pub(crate) fn closing() -> WaitForCancellationFuture<'static> {
    CLOSING.cancelled()
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
    CLOSING.cancel();
    close_runtimes(&entries, pool).await;
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
async fn close_runtimes(entries: &[RegisteredReader], pool: &sqlx::SqlitePool) {
    let runtimes = entries
        .iter()
        .filter_map(|entry| Some((entry.db_session_id, entry.runtime.as_ref()?.upgrade()?)))
        .collect::<Vec<_>>();
    let close_all = async {
        futures::future::join_all(runtimes.into_iter().map(
            |(db_session_id, runtime)| async move {
                // Read first: closing may drop the process handle.
                let pid = runtime.read().await.pid();
                if let Err(error) = runtime.write().await.close().await {
                    report_close_failure(pool, db_session_id, pid, &error.to_string()).await;
                }
            },
        ))
        .await;
    };
    if tokio::time::timeout(READER_SHUTDOWN_TIMEOUT, close_all)
        .await
        .is_err()
    {
        tracing::warn!("agent runtimes did not close before the stream-reader shutdown deadline");
    }
}

/// A runtime that failed to close at shutdown. An idle one whose process was
/// already gone (the terminal's Ctrl-C reaches the service's whole process
/// group, so an agent sharing it can die before the service closes it; a
/// Claude CLI leads its own) lost nothing: only logged. Any other failure is
/// the conversation's to show.
#[allow(dead_code)] // Reachable through `shutdown` in the service binary.
async fn report_close_failure(
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
    pid: Option<u32>,
    error: &str,
) {
    if close_failure_is_benign(
        turn_was_running(pool, db_session_id).await,
        pid.map(process_alive),
    ) {
        tracing::info!(
            db_session_id,
            error,
            "idle runtime had already exited before shutdown closed it"
        );
        return;
    }
    tracing::warn!(db_session_id, error, "runtime close failed during shutdown");
    super::persistence::WsSessionPersistence::persist_error_message_static(
        pool,
        db_session_id,
        &format!("Runtime close failed during shutdown: {error}"),
        None,
    )
    .await;
}

/// `process_alive` is `None` for a runtime with no process of its own: no
/// proof it is gone, so its failure is reported.
pub(super) fn close_failure_is_benign(turn_was_running: bool, process_alive: Option<bool>) -> bool {
    !turn_was_running && process_alive == Some(false)
}

/// Whether the session had a turn running (or waiting on its gate). An
/// unreadable status is no proof it was idle.
#[allow(dead_code)] // Reachable through `shutdown` in the service binary.
async fn turn_was_running(pool: &sqlx::SqlitePool, db_session_id: i64) -> bool {
    match super::persistence::WsSessionPersistence::get_session_row(pool, db_session_id).await {
        Ok(Some(row)) => row.status == "running" || row.has_pending_user_input(),
        Ok(None) => false,
        Err(error) => {
            tracing::warn!(db_session_id, %error, "could not read session status at shutdown");
            true
        }
    }
}

#[cfg(unix)]
pub(super) fn process_alive(pid: u32) -> bool {
    crate::domain::restart_continuations::process_is_alive(pid)
}

#[cfg(not(unix))]
pub(super) fn process_alive(_pid: u32) -> bool {
    true
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
    use super::{close_failure_is_benign, join_within, report_close_failure, spawn, ReaderSignals};
    use std::time::Duration;

    use crate::domain::ws_session::handler::tests::support::{
        insert_running_session, make_test_app_state,
    };

    #[test]
    fn only_an_idle_runtime_whose_process_is_gone_fails_to_close_benignly() {
        assert!(close_failure_is_benign(false, Some(false)));
        assert!(
            !close_failure_is_benign(true, Some(false)),
            "a running turn"
        );
        assert!(
            !close_failure_is_benign(false, Some(true)),
            "a live process"
        );
        assert!(!close_failure_is_benign(false, None), "no process to check");
    }

    async fn error_rows(pool: &sqlx::SqlitePool, session_id: i64) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE session_id = ? AND message_type = 'error'",
        )
        .bind(session_id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// Found in QA: a Ctrl-C to the service's process group killed an idle
    /// Codex app-server first, and its failed close at shutdown was saved as
    /// an error in the conversation. A session still recorded as running (or
    /// gated) keeps the error.
    #[tokio::test]
    async fn a_dead_idle_runtime_failing_to_close_leaves_no_conversation_error() {
        let app_state = make_test_app_state().await;
        let pool = &app_state.write_pool;
        let mut exited = std::process::Command::new("true").spawn().unwrap();
        let dead_pid = exited.id();
        exited.wait().unwrap();
        insert_running_session(&app_state, 81, 1).await;
        sqlx::query("UPDATE agent_sessions SET status = 'completed' WHERE id = 81")
            .execute(pool)
            .await
            .unwrap();
        insert_running_session(&app_state, 82, 1).await;

        report_close_failure(pool, 81, Some(dead_pid), "app-server stdout closed").await;
        report_close_failure(pool, 82, Some(dead_pid), "app-server stdout closed").await;

        assert_eq!(error_rows(pool, 81).await, 0, "idle and already gone");
        assert_eq!(error_rows(pool, 82).await, 1, "its turn was running");
    }

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

    #[tokio::test]
    async fn a_panicked_reader_only_removes_the_work_it_owned() {
        use crate::domain::restart_continuations::write_background_work;

        let state = make_test_app_state().await;
        for has_successor in [false, true] {
            let session_id = if has_successor { 92 } else { 91 };
            insert_running_session(&state, session_id, 1).await;
            let signals = ReaderSignals::default();
            let settled = signals.settled_token();
            let reader_id = signals.reader_id.to_string();
            let (ready, reached) = tokio::sync::oneshot::channel();
            let (fail, failing) = tokio::sync::oneshot::channel();
            let pool = state.write_pool.clone();
            spawn(session_id, None, signals, pool.clone(), async move {
                write_background_work(&pool, session_id, &reader_id, Some(chrono::Utc::now()))
                    .await
                    .unwrap();
                ready.send(()).unwrap();
                failing.await.unwrap();
                panic!("reader failed after recording background work");
            });
            reached.await.unwrap();
            if has_successor {
                write_background_work(
                    &state.write_pool,
                    session_id,
                    "successor",
                    Some(chrono::Utc::now()),
                )
                .await
                .unwrap();
            }
            fail.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(2), settled.cancelled())
                .await
                .unwrap();

            let owner: Option<String> = sqlx::query_scalar(
                "SELECT reader_id FROM agent_background_work WHERE session_id = ?",
            )
            .bind(session_id)
            .fetch_optional(&state.write_pool)
            .await
            .unwrap();
            assert_eq!(owner.as_deref(), has_successor.then_some("successor"));
        }
    }
}
