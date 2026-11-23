//! Signals other tasks use to reach a running stream reader without sharing
//! its transcript buffer, which stays owned by the reader task alone.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;
use tokio_util::sync::{CancellationToken, DropGuard};

/// How long a rewind or fork waits for a closed runtime's reader to write its
/// buffered text before it rewrites the transcript anyway.
pub(crate) const TRANSCRIPT_SETTLE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
pub(crate) struct ReaderSignals {
    /// A viewer attached to the session: the reader re-sends the full text of
    /// its live blocks (see `StreamReaderTask::send_live_catch_up`). `Notify`
    /// keeps one permit, so a request made while the reader is busy with an
    /// event is served right after it.
    catch_up: Arc<Notify>,
    /// Cancelled once the reader wrote its last transcript row, so nothing it
    /// buffered can land after a caller rewrites the transcript.
    settled: CancellationToken,
}

impl ReaderSignals {
    pub(crate) fn request_catch_up(&self) {
        self.catch_up.notify_one();
    }

    pub(crate) async fn catch_up_requested(&self) {
        self.catch_up.notified().await;
    }

    pub(crate) fn mark_settled(&self) {
        self.settled.cancel();
    }

    /// Settles the reader when dropped, including by a panic unwinding its
    /// task, so a waiter is never held for the whole timeout by a dead reader.
    pub(crate) fn settle_on_drop(&self) -> DropGuard {
        self.settled.clone().drop_guard()
    }

    pub(crate) fn settled_token(&self) -> CancellationToken {
        self.settled.clone()
    }
}

/// Wait until every token is cancelled, or `timeout` passes. Returns whether
/// all of them settled.
pub(crate) async fn wait_all_settled(tokens: Vec<CancellationToken>, timeout: Duration) -> bool {
    let all = futures::future::join_all(tokens.iter().map(CancellationToken::cancelled));
    tokio::time::timeout(timeout, all).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn waits_for_every_reader_and_gives_up_at_the_timeout() {
        let first = ReaderSignals::default();
        let second = ReaderSignals::default();
        let tokens = vec![first.settled_token(), second.settled_token()];
        let waiting = tokio::spawn(wait_all_settled(tokens, Duration::from_secs(2)));
        first.mark_settled();
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "the second reader still writes");
        second.mark_settled();
        assert!(waiting.await.unwrap());

        let stuck = ReaderSignals::default();
        assert!(!wait_all_settled(vec![stuck.settled_token()], Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn a_dropped_reader_counts_as_settled() {
        let signals = ReaderSignals::default();
        let guard = signals.settle_on_drop();
        let token = signals.settled_token();
        assert!(!token.is_cancelled());
        drop(guard);
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn a_catch_up_requested_while_the_reader_is_busy_is_kept() {
        let signals = ReaderSignals::default();
        signals.request_catch_up();
        tokio::time::timeout(Duration::from_secs(1), signals.catch_up_requested())
            .await
            .expect("the permit was kept");
    }
}
