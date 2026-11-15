//! Per-client editor file watching.
//!
//! Each WebSocket client holds at most one subscription: the editor root of
//! the feature it shows. Subscribing again (the client switched feature)
//! replaces that subscription, and a disconnect releases it, so neither a
//! relay task nor an OS watcher outlives its client. Clients showing the same
//! root share one [`FileWatcher`], whatever their feature; it stops when the
//! last of them leaves.

use std::collections::HashMap;
use std::path::PathBuf;

use axum::extract::ws::Message;
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;

use super::{start_off_runtime, FileChangeEvent, FileWatcher};
use crate::domain::workflow::ws_sender::WsSender;
use crate::domain::ws_session::protocol::WsEnvelope;

/// Room for a burst of emissions before a slow relay lags (it then resends a
/// bare invalidation).
const EVENT_CAPACITY: usize = 16;

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
    /// features of one root never restarts its watcher.
    fn attach(&mut self, sender: &WsSender, root: PathBuf, feature_id: Option<i64>) {
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
        if let Some(previous) = previous {
            self.release(previous);
        }
    }

    /// Drop the client's relay, then its share of the root's watcher.
    fn release(&mut self, client: ClientSubscription) {
        let root = client.root.clone();
        drop(client);
        let Some(shared) = self.roots.get_mut(&root) else {
            return;
        };
        shared.clients = shared.clients.saturating_sub(1);
        if shared.clients == 0 {
            self.roots.remove(&root);
        }
    }
}

/// Registry held by `AppState`.
#[derive(Default)]
pub struct EditorWatchers {
    inner: Mutex<Inner>,
}

impl EditorWatchers {
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
                inner.attach(sender, root, feature_id);
                return Ok(());
            }
        }
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let started = start_off_runtime(&root, None, events.clone()).await;
        let mut inner = self.inner.lock().await;
        let watcher = match started {
            Ok(watcher) => watcher,
            Err(error) => {
                if let Some(previous) = inner.take_client(sender) {
                    inner.release(previous);
                }
                return Err(error);
            }
        };
        // Another client may have started the same root meanwhile: keep
        // theirs, and ours stops as it drops.
        inner.roots.entry(root.clone()).or_insert(SharedRoot {
            _watcher: watcher,
            events,
            clients: 0,
        });
        inner.attach(sender, root, feature_id);
        Ok(())
    }

    /// Release `sender`'s subscription (the client disconnected).
    pub async fn unsubscribe_sender(&self, sender: &WsSender) {
        let mut inner = self.inner.lock().await;
        if let Some(client) = inner.take_client(sender) {
            inner.release(client);
        }
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
}
