//! Subscriptions still computing their first snapshot.
//!
//! A WebSocket runs its commands in order, so a `subscribe.git_status` that
//! waits on a hung Git would hold up every command after it on that socket,
//! other features' subscriptions included. Subscriptions therefore run beside
//! the socket's lane, and an unsubscribe or a disconnect can now arrive before
//! one completes: it cancels the pending subscription instead of leaving a
//! subscriber behind. A subscription only touches the registry in its last,
//! synchronous step, so cancelling it never leaves it half-registered.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use axum::extract::ws::Message;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

struct Pending {
    id: u64,
    feature_id: i64,
    sender: mpsc::UnboundedSender<Message>,
    abort: AbortHandle,
}

#[derive(Default)]
pub(super) struct PendingSubscriptions {
    next_id: AtomicU64,
    entries: Mutex<Vec<Pending>>,
}

impl PendingSubscriptions {
    /// Run `subscription` in the background until it ends or is cancelled.
    pub(super) fn start<F>(
        self: &Arc<Self>,
        feature_id: i64,
        sender: mpsc::UnboundedSender<Message>,
        subscription: F,
    ) where
        F: Future<Output = ()> + Send + 'static,
    {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        // Held across the spawn so the task's own removal finds its entry.
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let pending = Arc::clone(self);
        let task = tokio::spawn(async move {
            subscription.await;
            pending.remove(id);
        });
        entries.push(Pending {
            id,
            feature_id,
            sender,
            abort: task.abort_handle(),
        });
    }

    /// Cancel the pending subscriptions `matches` selects.
    pub(super) fn cancel(&self, matches: impl Fn(i64, &mpsc::UnboundedSender<Message>) -> bool) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries.retain(|entry| {
            let cancelled = matches(entry.feature_id, &entry.sender);
            if cancelled {
                entry.abort.abort();
            }
            !cancelled
        });
    }

    fn remove(&self, id: u64) {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|entry| entry.id != id);
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_finished_subscription_leaves_no_entry() {
        let pending = Arc::new(PendingSubscriptions::default());
        let (tx, _rx) = mpsc::unbounded_channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        pending.start(1, tx, async move {
            done_tx.send(()).unwrap();
        });
        done_rx.await.unwrap();
        tokio::task::yield_now().await;
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn cancelling_aborts_only_the_matching_subscriptions() {
        let pending = Arc::new(PendingSubscriptions::default());
        let (tx, _rx) = mpsc::unbounded_channel();
        let (other, _other_rx) = mpsc::unbounded_channel();
        let (finished_tx, mut finished) = mpsc::unbounded_channel::<i64>();
        for (feature_id, sender) in [(1, tx.clone()), (2, tx.clone()), (1, other.clone())] {
            let finished_tx = finished_tx.clone();
            pending.start(feature_id, sender, async move {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                finished_tx.send(feature_id).unwrap();
            });
        }
        pending.cancel(|feature_id, sender| feature_id == 1 && sender.same_channel(&tx));
        assert_eq!(pending.len(), 2);
        drop(finished_tx);
        let mut done = Vec::new();
        while let Some(feature_id) = finished.recv().await {
            done.push(feature_id);
        }
        done.sort();
        assert_eq!(
            done,
            vec![1, 2],
            "the other socket's feature 1 and feature 2 ran"
        );
    }
}
