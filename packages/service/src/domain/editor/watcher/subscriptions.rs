//! Per-client editor file watching.
//!
//! Each WebSocket client holds at most one subscription: the editor root of
//! the feature it shows. Subscribing again (the client switched feature)
//! replaces that subscription, and a disconnect releases it, so neither a
//! relay task nor an OS watcher outlives its client. Clients showing the same
//! root share one [`FileWatcher`], whatever their feature; it stops when the
//! last of them leaves.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, PoisonError,
};

use axum::extract::ws::Message;
use tokio::sync::{broadcast, Mutex};
use tokio::task::{AbortHandle, JoinHandle};

use super::{start_off_runtime, FileChangeEvent, FileWatcher};
use crate::domain::workflow::ws_sender::WsSender;
use crate::domain::ws_session::protocol::WsEnvelope;

/// Room for a burst of emissions before a slow relay lags (it then resends a
/// bare invalidation).
const EVENT_CAPACITY: usize = 16;

struct PendingSubscription {
    id: u64,
    sender: WsSender,
    abort: AbortHandle,
}

#[derive(Default)]
struct PendingSubscriptions {
    next_id: AtomicU64,
    entries: std::sync::Mutex<Vec<PendingSubscription>>,
}

impl PendingSubscriptions {
    fn retain_active_excluding(entries: &mut Vec<PendingSubscription>, sender: &WsSender) {
        entries.retain(|entry| {
            let stale = entry.sender.same_channel(sender) || entry.sender.is_closed();
            if stale {
                entry.abort.abort();
            }
            !stale
        });
    }

    fn replace_for_sender<F>(self: &Arc<Self>, sender: &WsSender, build: impl FnOnce(u64) -> F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        Self::retain_active_excluding(&mut entries, sender);
        let pending = Arc::clone(self);
        let future = build(id);
        let task = tokio::spawn(async move {
            future.await;
            pending.remove(id);
        });
        entries.push(PendingSubscription {
            id,
            sender: sender.clone(),
            abort: task.abort_handle(),
        });
    }

    fn is_current(&self, id: u64) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .any(|entry| entry.id == id)
    }

    fn cancel_for_sender(&self, sender: &WsSender) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        Self::retain_active_excluding(&mut entries, sender);
    }

    fn remove(&self, id: u64) {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|entry| entry.id != id);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

/// One OS watcher and the clients relaying its events. Dropping it stops the
/// watcher.
struct SharedRoot {
    _watcher: FileWatcher,
    events: broadcast::Sender<FileChangeEvent>,
    clients: usize,
}

/// A client's single subscription. Dropping it ends the relay task.
struct ClientSubscription {
    sender: WsSender,
    root: PathBuf,
    feature_id: Option<i64>,
    relay: JoinHandle<()>,
}

impl Drop for ClientSubscription {
    fn drop(&mut self) {
        self.relay.abort();
    }
}

#[derive(Default)]
struct Inner {
    roots: HashMap<PathBuf, SharedRoot>,
    clients: Vec<ClientSubscription>,
}

impl Inner {
    fn client(&self, sender: &WsSender) -> Option<&ClientSubscription> {
        self.clients
            .iter()
            .find(|client| client.sender.same_channel(sender))
    }

    fn take_client(&mut self, sender: &WsSender) -> Option<ClientSubscription> {
        let index = self
            .clients
            .iter()
            .position(|client| client.sender.same_channel(sender))?;
        Some(self.clients.swap_remove(index))
    }

    /// Relay `root`'s changes (which must be watched) to `sender` as
    /// `feature_id`'s, replacing the client's previous subscription. The new
    /// share is taken before the old one is released, so moving between
    /// features of one root never restarts its watcher. Returns any retired
    /// root so the caller can drop it after releasing the registry lock.
    fn attach(
        &mut self,
        sender: &WsSender,
        root: PathBuf,
        feature_id: Option<i64>,
    ) -> Option<SharedRoot> {
        let previous = self.take_client(sender);
        let shared = self
            .roots
            .get_mut(&root)
            .expect("attach needs a watched root");
        shared.clients += 1;
        let relay = tokio::spawn(relay_changes(
            shared.events.subscribe(),
            feature_id,
            sender.clone(),
        ));
        self.clients.push(ClientSubscription {
            sender: sender.clone(),
            root,
            feature_id,
            relay,
        });
        previous.and_then(|previous| self.release(previous))
    }

    /// Drop the client's relay, then release its share of the root's watcher.
    /// Returns the removed [`SharedRoot`] when this was its last client so the
    /// caller can drop it outside the registry mutex.
    fn release(&mut self, client: ClientSubscription) -> Option<SharedRoot> {
        let root = client.root.clone();
        drop(client);
        let shared = self.roots.get_mut(&root)?;
        shared.clients = shared.clients.saturating_sub(1);
        if shared.clients == 0 {
            self.roots.remove(&root)
        } else {
            None
        }
    }
}

/// Registry held by `AppState`.
#[derive(Default)]
pub struct EditorWatchers {
    inner: Mutex<Inner>,
    pending: Arc<PendingSubscriptions>,
}

impl EditorWatchers {
    /// Resolve `root` and [`Self::subscribe`] off the caller's lane with
    /// per-sender latest-wins cancellation. A newer subscription or
    /// [`Self::unsubscribe_sender`] aborts any in-flight setup before it
    /// attaches or replies.
    pub fn subscribe_in_background<Resolve, E, Respond>(
        self: &Arc<Self>,
        sender: WsSender,
        feature_id: Option<i64>,
        resolve_root: Resolve,
        respond: Respond,
    ) where
        Resolve: Future<Output = Result<PathBuf, E>> + Send + 'static,
        E: Send + 'static,
        Respond: FnOnce(Result<Result<(), String>, E>) + Send + 'static,
    {
        let watchers = Arc::clone(self);
        let pending = Arc::clone(&self.pending);
        let sender_for_task = sender.clone();
        self.pending
            .replace_for_sender(&sender, move |generation| async move {
                let root = match resolve_root.await {
                    Ok(path) => path,
                    Err(error) => {
                        if pending.is_current(generation) {
                            respond(Err(error));
                        }
                        return;
                    }
                };
                if sender_for_task.is_closed() || !pending.is_current(generation) {
                    return;
                }
                if let Err(error) = watchers.subscribe(&sender_for_task, root, feature_id).await {
                    if pending.is_current(generation) {
                        respond(Ok(Err(error)));
                    }
                    return;
                }
                if sender_for_task.is_closed() {
                    watchers.unsubscribe_sender(&sender_for_task).await;
                    return;
                }
                if pending.is_current(generation) {
                    respond(Ok(Ok(())));
                }
            });
    }
    /// Point `sender`'s subscription at `root` (an already resolved and
    /// canonical editor root) for `feature_id`, replacing the one it held.
    /// Re-subscribing to the same feature keeps the running relay, so no
    /// change falls in a gap. On error the client is left unsubscribed.
    ///
    /// A new root's watcher starts without holding the registry, so a slow
    /// start (a large tree) delays neither other clients nor disconnects.
    /// The sender's own disconnect cannot interleave: the connection drains
    /// or aborts its command lanes before it unsubscribes.
    pub async fn subscribe(
        &self,
        sender: &WsSender,
        root: PathBuf,
        feature_id: Option<i64>,
    ) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().await;
            if let Some(current) = inner.client(sender) {
                if current.root == root && current.feature_id == feature_id {
                    return Ok(());
                }
            }
            if inner.roots.contains_key(&root) {
                let retired_root = inner.attach(sender, root, feature_id);
                drop(inner);
                drop(retired_root);
                return Ok(());
            }
        }

        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let started = start_off_runtime(&root, None, events.clone()).await;

        let (result, retired_root, unused_watcher) = {
            let mut inner = self.inner.lock().await;
            match started {
                Ok(watcher) => {
                    // Another client may have started the same root meanwhile:
                    // keep theirs, and drop ours after releasing the lock.
                    let unused = if inner.roots.contains_key(&root) {
                        Some(watcher)
                    } else {
                        inner.roots.insert(
                            root.clone(),
                            SharedRoot {
                                _watcher: watcher,
                                events,
                                clients: 0,
                            },
                        );
                        None
                    };
                    let retired = inner.attach(sender, root, feature_id);
                    (Ok(()), retired, unused)
                }
                Err(error) => {
                    let retired = inner
                        .take_client(sender)
                        .and_then(|previous| inner.release(previous));
                    (Err(error), retired, None)
                }
            }
        };
        drop(unused_watcher);
        drop(retired_root);
        result
    }

    /// Release `sender`'s subscription (the client disconnected) and cancel
    /// any in-flight background setup for that sender.
    pub async fn unsubscribe_sender(&self, sender: &WsSender) {
        self.pending.cancel_for_sender(sender);
        let retired_root = {
            let mut inner = self.inner.lock().await;
            inner
                .take_client(sender)
                .and_then(|client| inner.release(client))
        };
        drop(retired_root);
    }

    /// `(subscribed clients, OS watchers)`.
    #[cfg(test)]
    pub(crate) async fn counts(&self) -> (usize, usize) {
        let inner = self.inner.lock().await;
        (inner.clients.len(), inner.roots.len())
    }
}

/// Forward a root's changes to one client, as seen from its feature, until
/// either side closes.
async fn relay_changes(
    mut rx: broadcast::Receiver<FileChangeEvent>,
    feature_id: Option<i64>,
    sender: WsSender,
) {
    loop {
        let payload = match rx.recv().await {
            Ok(event) => FileChangeEvent {
                feature_id,
                ..event
            }
            .payload(),
            // The frontend refetches on any change, so one bare event covers
            // whatever was missed.
            Err(broadcast::error::RecvError::Lagged(_)) => serde_json::json!({}),
            Err(broadcast::error::RecvError::Closed) => break,
        };
        let update = WsEnvelope::new("editor", "file_tree.changed", payload);
        if sender
            .send(Message::Text(String::from(update).into()))
            .is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;

    fn temp_root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        (dir, root)
    }

    #[tokio::test]
    async fn switching_features_replaces_the_clients_subscription() {
        let watchers = EditorWatchers::default();
        let (_dir, root) = temp_root();
        let (tx, _rx) = mpsc::unbounded_channel();

        for feature_id in [1, 2, 1, 2, 3] {
            watchers
                .subscribe(&tx, root.clone(), Some(feature_id))
                .await
                .unwrap();
        }
        assert_eq!(watchers.counts().await, (1, 1), "one relay, one OS watcher");

        watchers.unsubscribe_sender(&tx).await;
        assert_eq!(watchers.counts().await, (0, 0));
    }

    #[tokio::test]
    async fn clients_on_the_same_root_share_one_watcher_until_the_last_leaves() {
        let watchers = EditorWatchers::default();
        let (_dir, root) = temp_root();
        let (a, _rx_a) = mpsc::unbounded_channel();
        let (b, _rx_b) = mpsc::unbounded_channel();

        watchers.subscribe(&a, root.clone(), Some(1)).await.unwrap();
        watchers.subscribe(&b, root.clone(), Some(2)).await.unwrap();
        assert_eq!(
            watchers.counts().await,
            (2, 1),
            "features share the root's watcher"
        );

        watchers.unsubscribe_sender(&a).await;
        assert_eq!(watchers.counts().await, (1, 1), "b still watches");
        watchers.unsubscribe_sender(&b).await;
        assert_eq!(watchers.counts().await, (0, 0));
    }

    /// One OS watcher, but each client hears the change as its own feature's.
    #[tokio::test]
    async fn each_client_sees_changes_under_its_own_feature() {
        let watchers = EditorWatchers::default();
        let (_dir, root) = temp_root();
        let (a, mut rx_a) = mpsc::unbounded_channel();
        let (b, mut rx_b) = mpsc::unbounded_channel();
        watchers.subscribe(&a, root.clone(), Some(1)).await.unwrap();
        watchers.subscribe(&b, root.clone(), Some(2)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        std::fs::write(root.join("edited.txt"), "x").unwrap();

        for (rx, feature_id) in [(&mut rx_a, 1), (&mut rx_b, 2)] {
            let message = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .expect("a change reaches every client")
                .unwrap();
            let Message::Text(text) = message else {
                panic!("expected a text envelope");
            };
            let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
            assert_eq!(envelope.payload["feature_id"], feature_id);
        }
    }

    /// Every relay holds a clone of the client's sender, so the client's
    /// receiver closes only once no relay task is left behind.
    #[tokio::test]
    async fn released_subscriptions_leave_no_relay_task() {
        let watchers = EditorWatchers::default();
        let (_dir_a, root_a) = temp_root();
        let (_dir_b, root_b) = temp_root();
        let (tx, mut rx) = mpsc::unbounded_channel();

        for root in [&root_a, &root_b, &root_a] {
            watchers.subscribe(&tx, root.clone(), None).await.unwrap();
        }
        watchers.unsubscribe_sender(&tx).await;
        drop(tx);

        let closed = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
        assert!(
            matches!(closed, Ok(None)),
            "a relay task leaked: {closed:?}"
        );
    }

    #[tokio::test]
    async fn a_failed_start_keeps_the_previous_state_released() {
        let watchers = EditorWatchers::default();
        let (dir, root) = temp_root();
        let (tx, _rx) = mpsc::unbounded_channel();
        watchers.subscribe(&tx, root.clone(), None).await.unwrap();
        drop(dir);

        let missing = root.join("gone");
        assert!(watchers.subscribe(&tx, missing, None).await.is_err());
        assert_eq!(watchers.counts().await, (0, 0), "nothing dangles");
    }

    #[tokio::test]
    async fn unsubscribe_sender_cancels_pending_background_subscription() {
        let watchers = Arc::new(EditorWatchers::default());
        let (_dir, root) = temp_root();
        let (tx, _rx) = mpsc::unbounded_channel();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (replied_tx, mut replied_rx) = mpsc::unbounded_channel();

        watchers.subscribe_in_background(
            tx.clone(),
            Some(1),
            async move {
                started_tx.send(()).unwrap();
                std::future::pending::<Result<PathBuf, ()>>().await
            },
            move |result| {
                let _ = replied_tx.send(result.is_ok());
            },
        );
        started_rx.await.unwrap();
        assert_eq!(watchers.pending.len(), 1);

        watchers.unsubscribe_sender(&tx).await;
        assert_eq!(watchers.pending.len(), 0);
        assert_eq!(watchers.counts().await, (0, 0));
        assert!(replied_rx.try_recv().is_err());
        drop(root);
    }
}
