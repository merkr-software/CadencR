use crate::domain::ws_session::runtime::output::{OutputTarget, SessionOutput};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::ws::Message;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, Mutex};

/// A read-only tap on one feature's traffic (a custom tab's `session.stream`).
///
/// Unlike a viewer socket it is bounded and filtered at the source: frames
/// `accepts` rejects are never cloned, and a full queue drops the frame and
/// raises `lagged` instead of growing — the agent stream never waits on, or
/// buffers for, a plugin.
#[derive(Clone)]
pub struct FeatureObserver {
    pub sender: mpsc::Sender<Message>,
    /// Decides from the raw text frame; must be cheap (it runs per frame).
    pub accepts: fn(&str) -> bool,
    /// Set when a frame was dropped on a full queue.
    pub lagged: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
struct Observers {
    by_feature: Arc<std::sync::Mutex<HashMap<i64, Vec<FeatureObserver>>>>,
    /// Lock-free fast path: with no observer anywhere, mirroring costs one load.
    count: Arc<AtomicUsize>,
}

/// Lightweight registry that maps a `feature_id` to all active WebSocket
/// senders currently subscribed to that feature. Held by `AppState` so HTTP
/// handlers can push WS envelopes without a direct reference to the socket.
///
/// Senders are registered when a WS session opens and removed when it closes.
/// Dead senders (disconnected clients) are pruned lazily on the next broadcast.
#[derive(Clone, Default)]
pub struct WsFeatureSenderRegistry {
    inner: Arc<Mutex<HashMap<i64, Vec<mpsc::UnboundedSender<Message>>>>>,
    observers: Observers,
}

impl WsFeatureSenderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return a sender that forwards each message to the owner and every other
    /// client currently viewing `feature_id`. The forwarder exits when all
    /// clones of the returned sender are dropped.
    pub fn fan_out_sender(
        &self,
        feature_id: i64,
        owner: mpsc::UnboundedSender<Message>,
    ) -> mpsc::UnboundedSender<Message> {
        self.forwarding_sender(feature_id, owner)
    }

    /// Forward legacy workflow progress to feature viewers, with an optional
    /// initiating socket. This is an outbound adapter, never a command reply.
    pub(crate) fn feature_output_sender(
        &self,
        feature_id: i64,
        owner: &impl OutputTarget,
    ) -> mpsc::UnboundedSender<Message> {
        let output = owner
            .recipient()
            .cloned()
            .map(SessionOutput::from)
            .unwrap_or_default();
        self.forwarding_sender(feature_id, output)
    }

    fn forwarding_sender(
        &self,
        feature_id: i64,
        owner: impl Into<SessionOutput>,
    ) -> mpsc::UnboundedSender<Message> {
        let registry = self.clone();
        let owner = owner.into();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                registry.send_and_mirror(feature_id, &owner, message).await;
            }
        });
        sender
    }

    /// Register `sender` for the given `feature_id`.
    pub async fn register(&self, feature_id: i64, sender: mpsc::UnboundedSender<Message>) {
        let mut map = self.inner.lock().await;
        let senders = map.entry(feature_id).or_default();
        senders.retain(|s| !s.same_channel(&sender) && !s.is_closed());
        senders.push(sender);
    }

    /// Remove a specific `sender` for the given `feature_id`.
    #[allow(dead_code)]
    pub async fn unregister(&self, feature_id: i64, sender: &mpsc::UnboundedSender<Message>) {
        let mut map = self.inner.lock().await;
        if let Some(senders) = map.get_mut(&feature_id) {
            senders.retain(|s| !s.same_channel(sender));
            if senders.is_empty() {
                map.remove(&feature_id);
            }
        }
    }

    /// Remove `sender` from every feature it was registered under. Used during
    /// WS disconnect cleanup when the per-feature mapping is not known.
    pub async fn unregister_sender(&self, sender: &mpsc::UnboundedSender<Message>) {
        let mut map = self.inner.lock().await;
        for senders in map.values_mut() {
            senders.retain(|s| !s.same_channel(sender));
        }
        map.retain(|_, senders| !senders.is_empty());
    }

    /// Clone all live senders for `feature_id`. Dead senders are pruned in place.
    pub async fn get_senders(&self, feature_id: i64) -> Vec<mpsc::UnboundedSender<Message>> {
        let mut map = self.inner.lock().await;
        let Some(senders) = map.get_mut(&feature_id) else {
            return Vec::new();
        };
        senders.retain(|s| !s.is_closed());
        senders.clone()
    }

    /// Mirror `message` to every sender registered for `feature_id` EXCEPT
    /// `exclude` — the connection that drives the turn and already received the
    /// message directly. This is how a live turn's output reaches other devices
    /// viewing the same feature (the remote-access mirror). `message` is taken
    /// by reference and cloned only per *other* recipient, so the common
    /// single-viewer case (only the driver is registered) does no work and no
    /// clones. Dead senders are pruned in place.
    pub async fn broadcast_others(
        &self,
        feature_id: i64,
        exclude: &mpsc::UnboundedSender<Message>,
        message: &Message,
    ) {
        self.notify_observers(feature_id, message);
        let mut map = self.inner.lock().await;
        let Some(senders) = map.get_mut(&feature_id) else {
            return;
        };
        senders.retain(|s| !s.is_closed());
        for sender in senders.iter() {
            if sender.same_channel(exclude) {
                continue;
            }
            let _ = sender.send(message.clone());
        }
        if senders.is_empty() {
            map.remove(&feature_id);
        }
    }

    /// Attach a read-only observer to `feature_id`'s traffic.
    pub fn observe(&self, feature_id: i64, observer: FeatureObserver) {
        let mut map = self.observers.lock();
        map.entry(feature_id).or_default().push(observer);
        self.observers.recount(&map);
    }

    /// Detach the observer feeding `sender`, wherever it is attached.
    pub fn unobserve(&self, sender: &mpsc::Sender<Message>) {
        let mut map = self.observers.lock();
        for observers in map.values_mut() {
            observers.retain(|observer| !observer.sender.same_channel(sender));
        }
        map.retain(|_, observers| !observers.is_empty());
        self.observers.recount(&map);
    }

    /// Offer `message` to `feature_id`'s observers. Callers that write to
    /// [`Self::get_senders`] directly call this too, so observers see what
    /// every other viewer sees.
    pub fn notify_observers(&self, feature_id: i64, message: &Message) {
        if self.observers.count.load(Ordering::Acquire) == 0 {
            return;
        }
        let Message::Text(text) = message else {
            return;
        };
        let mut map = self.observers.lock();
        let Some(observers) = map.get_mut(&feature_id) else {
            return;
        };
        observers.retain(|observer| {
            if !(observer.accepts)(text.as_str()) {
                return !observer.sender.is_closed();
            }
            match observer.sender.try_send(message.clone()) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    observer.lagged.store(true, Ordering::Release);
                    true
                }
                Err(TrySendError::Closed(_)) => false,
            }
        });
        if observers.is_empty() {
            map.remove(&feature_id);
        }
        self.observers.recount(&map);
    }

    /// Send `msg` to the turn `owner` and mirror it to every *other* device
    /// viewing `feature_id`. Others are mirrored first so the owner send can
    /// move `msg` without a clone; with only the owner registered this is a
    /// plain send. Returns `true` when the owner socket is gone, so callers can
    /// stop a loop exactly as a bare `send().is_err()` would.
    pub(crate) async fn send_and_mirror(
        &self,
        feature_id: i64,
        owner: &impl OutputTarget,
        msg: Message,
    ) -> bool {
        if let Some(recipient) = owner.recipient() {
            self.broadcast_others(feature_id, recipient, &msg).await;
            return recipient.send(msg).is_err();
        }
        self.notify_observers(feature_id, &msg);
        for sender in self.get_senders(feature_id).await {
            let _ = sender.send(msg.clone());
        }
        false
    }
}

impl Observers {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<i64, Vec<FeatureObserver>>> {
        // Every operation leaves the map consistent, so a poisoned lock is
        // safe to keep using.
        self.by_feature
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn recount(&self, map: &HashMap<i64, Vec<FeatureObserver>>) {
        let count = map.values().map(Vec::len).sum();
        self.count.store(count, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_and_get_senders() {
        let registry = WsFeatureSenderRegistry::new();
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();

        registry.register(1, tx.clone()).await;
        let senders = registry.get_senders(1).await;
        assert_eq!(senders.len(), 1);
    }

    #[tokio::test]
    async fn register_replaces_same_sender_for_feature() {
        let registry = WsFeatureSenderRegistry::new();
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();

        registry.register(1, tx.clone()).await;
        registry.register(1, tx.clone()).await;
        let senders = registry.get_senders(1).await;
        assert_eq!(senders.len(), 1);
    }

    #[tokio::test]
    async fn unregister_removes_sender() {
        let registry = WsFeatureSenderRegistry::new();
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();

        registry.register(1, tx.clone()).await;
        registry.unregister(1, &tx).await;
        let senders = registry.get_senders(1).await;
        assert!(senders.is_empty());
    }

    #[tokio::test]
    async fn dead_senders_pruned_on_get() {
        let registry = WsFeatureSenderRegistry::new();
        let (tx, rx) = mpsc::unbounded_channel::<Message>();

        registry.register(1, tx).await;
        drop(rx); // close the receiver → sender is dead
        let senders = registry.get_senders(1).await;
        assert!(senders.is_empty());
    }

    #[tokio::test]
    async fn broadcast_others_reaches_other_viewers_but_not_the_driver() {
        let registry = WsFeatureSenderRegistry::new();
        let (driver_tx, mut driver_rx) = mpsc::unbounded_channel::<Message>();
        let (viewer_tx, mut viewer_rx) = mpsc::unbounded_channel::<Message>();
        registry.register(1, driver_tx.clone()).await;
        registry.register(1, viewer_tx).await;

        registry
            .broadcast_others(1, &driver_tx, &Message::Text("hi".into()))
            .await;

        // The other viewer receives the mirror...
        assert!(matches!(viewer_rx.try_recv(), Ok(Message::Text(_))));
        // ...but the driver (excluded) does not — it already got it directly.
        assert!(driver_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn broadcast_others_is_a_noop_with_only_the_driver() {
        let registry = WsFeatureSenderRegistry::new();
        let (driver_tx, mut driver_rx) = mpsc::unbounded_channel::<Message>();
        registry.register(1, driver_tx.clone()).await;

        // Single-viewer (local) case: nobody else to mirror to, so the driver
        // never receives an echo of its own message.
        registry
            .broadcast_others(1, &driver_tx, &Message::Text("hi".into()))
            .await;
        assert!(driver_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn fan_out_sender_follows_viewers_that_connect_mid_run() {
        let registry = WsFeatureSenderRegistry::new();
        let (owner_tx, mut owner_rx) = mpsc::unbounded_channel::<Message>();
        let fan_out = registry.fan_out_sender(1, owner_tx);
        let (viewer_tx, mut viewer_rx) = mpsc::unbounded_channel::<Message>();
        registry.register(1, viewer_tx).await;

        fan_out.send(Message::Text("ready".into())).unwrap();

        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(1), owner_rx.recv())
                .await
                .unwrap(),
            Some(Message::Text(_))
        ));
        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(1), viewer_rx.recv())
                .await
                .unwrap(),
            Some(Message::Text(_))
        ));
    }

    fn observer(capacity: usize) -> (FeatureObserver, mpsc::Receiver<Message>) {
        let (sender, receiver) = mpsc::channel(capacity);
        let observer = FeatureObserver {
            sender,
            accepts: |text| text.starts_with("keep"),
            lagged: Arc::default(),
        };
        (observer, receiver)
    }

    #[tokio::test]
    async fn observers_get_only_accepted_frames_bounded_and_flag_overflow() {
        let registry = WsFeatureSenderRegistry::new();
        let (driver_tx, _driver_rx) = mpsc::unbounded_channel::<Message>();
        registry.register(1, driver_tx.clone()).await;
        let (tap, mut rx) = observer(2);
        let lagged = tap.lagged.clone();
        registry.observe(1, tap.clone());
        for text in ["skip", "keep 1", "keep 2", "keep 3"] {
            registry
                .send_and_mirror(1, &driver_tx, Message::Text(text.into()))
                .await;
        }
        assert!(matches!(rx.try_recv(), Ok(Message::Text(t)) if t.as_str() == "keep 1"));
        assert!(matches!(rx.try_recv(), Ok(Message::Text(t)) if t.as_str() == "keep 2"));
        assert!(rx.try_recv().is_err(), "the third frame overflowed");
        assert!(lagged.load(Ordering::Acquire));
        // Observers are not viewers: direct-send paths do not see them.
        assert_eq!(registry.get_senders(1).await.len(), 1);
        registry.unobserve(&tap.sender);
        assert_eq!(registry.observers.count.load(Ordering::Acquire), 0);
        registry.notify_observers(1, &Message::Text("keep 4".into()));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn closed_observers_are_dropped_on_the_next_frame() {
        let registry = WsFeatureSenderRegistry::new();
        let (tap, rx) = observer(4);
        registry.observe(7, tap);
        drop(rx);
        registry.notify_observers(7, &Message::Text("keep".into()));
        assert_eq!(registry.observers.count.load(Ordering::Acquire), 0);
    }
    #[tokio::test]
    async fn headless_progress_forwarder_reaches_current_and_later_viewers_once() {
        let registry = WsFeatureSenderRegistry::new();
        let (first, mut first_rx) = mpsc::unbounded_channel();
        registry.register(1, first).await;
        let progress = registry.feature_output_sender(1, &SessionOutput::headless());
        progress.send(Message::Text("first".into())).unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), first_rx.recv())
            .await
            .unwrap();
        assert!(matches!(event, Some(Message::Text(text)) if text.as_str() == "first"));
        assert!(first_rx.try_recv().is_err());
        let (later, mut later_rx) = mpsc::unbounded_channel();
        registry.register(1, later).await;
        progress.send(Message::Text("later".into())).unwrap();
        for receiver in [&mut first_rx, &mut later_rx] {
            let event = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
                .await
                .unwrap();
            assert!(matches!(event, Some(Message::Text(text)) if text.as_str() == "later"));
            assert!(receiver.try_recv().is_err());
        }
    }
}
