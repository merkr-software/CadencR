//! The plugin socket's outbound side: a bounded queue and the one task that
//! writes it to the peer.
//!
//! Nothing upstream ever waits on the peer. Events go in with `try_send`; a
//! full queue drops the event and owes its subscription a `plugin/resync`,
//! delivered ahead of that subscription's next event (or as soon as the queue
//! drains), so the plugin refetches after everything it did receive. A reply
//! that does not fit means the client stopped reading: the socket closes.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::ws::{close_code, CloseFrame, Message};
use futures::{Sink, SinkExt};
use serde_json::json;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::oneshot::error::RecvError;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_util::sync::CancellationToken;

use crate::domain::ws_session::protocol::WsEnvelope;

/// What the socket owes but has not queued yet.
#[derive(Default)]
pub struct Shared {
    /// Subscription id → topic, for every subscription owed a resync.
    owed: Mutex<BTreeMap<String, &'static str>>,
    /// Wakes the writer to deliver what is owed on an idle queue.
    owed_added: Notify,
    /// Cancelled when a reply could not be queued.
    stalled: CancellationToken,
}

impl Shared {
    fn owed(&self) -> MutexGuard<'_, BTreeMap<String, &'static str>> {
        // Insert/remove only: a poisoned map is still consistent.
        self.owed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Producer handle; cheap to clone.
#[derive(Clone)]
pub struct Outbound {
    tx: mpsc::Sender<Message>,
    shared: Arc<Shared>,
}

pub fn channel(capacity: usize) -> (Outbound, mpsc::Receiver<Message>) {
    let (tx, rx) = mpsc::channel(capacity);
    let outbound = Outbound {
        tx,
        shared: Arc::default(),
    };
    (outbound, rx)
}

impl Outbound {
    pub fn shared(&self) -> Arc<Shared> {
        self.shared.clone()
    }

    /// Cancelled once the client stopped reading.
    pub fn stalled(&self) -> CancellationToken {
        self.shared.stalled.clone()
    }

    /// Queue one event of `subscription_id`. `false` once the socket is gone.
    pub fn event(&self, text: String, subscription_id: &str, topic: &'static str) -> bool {
        let owed = self.shared.owed().remove(subscription_id);
        if owed.is_some() {
            match self.tx.try_send(resync_message(subscription_id, topic)) {
                Ok(()) => {}
                // Still no room: this event is lost too and the debt stands.
                Err(TrySendError::Full(_)) => {
                    self.owe(subscription_id, topic);
                    return true;
                }
                Err(TrySendError::Closed(_)) => return false,
            }
        }
        match self.tx.try_send(Message::Text(text.into())) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.owe(subscription_id, topic);
                true
            }
            Err(TrySendError::Closed(_)) => false,
        }
    }

    /// The subscription missed events: it gets a `plugin/resync`.
    pub fn owe(&self, subscription_id: &str, topic: &'static str) {
        self.shared
            .owed()
            .insert(subscription_id.to_string(), topic);
        self.shared.owed_added.notify_one();
    }

    /// Forget a debt (the subscription is gone).
    pub fn forgive(&self, subscription_id: &str) {
        self.shared.owed().remove(subscription_id);
    }

    /// Queue a reply or error. A client that left even replies unread is
    /// stalled; the socket loop closes it.
    pub fn control(&self, envelope: WsEnvelope) {
        let message = Message::Text(String::from(envelope).into());
        if let Err(TrySendError::Full(_)) = self.tx.try_send(message) {
            self.shared.stalled.cancel();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

fn resync_message(subscription_id: &str, topic: &str) -> Message {
    let envelope = WsEnvelope::new(
        "plugin",
        "resync",
        json!({ "subscription_id": subscription_id, "topic": topic }),
    );
    Message::Text(String::from(envelope).into())
}

/// The writer task: drains the queue into the peer, delivers what is owed
/// once the queue is idle, and sends the policy close frame when told to.
pub async fn write<S>(
    mut sink: S,
    mut rx: mpsc::Receiver<Message>,
    shared: Arc<Shared>,
    mut close: oneshot::Receiver<&'static str>,
) where
    S: Sink<Message> + Unpin,
{
    loop {
        tokio::select! {
            biased;
            reason = &mut close => {
                send_close(&mut sink, reason).await;
                return;
            }
            message = rx.recv() => {
                // Every producer is gone because the socket loop is closing,
                // and the loop still decides whether a policy frame goes out.
                // The last producer can be an aborted subscription task
                // dropped on another worker before that decision arrives.
                let Some(message) = message else {
                    send_close(&mut sink, (&mut close).await).await;
                    return;
                };
                if sink.send(message).await.is_err() {
                    return;
                }
            }
            () = shared.owed_added.notified() => {}
        }
        if rx.is_empty() {
            let owed = std::mem::take(&mut *shared.owed());
            for (subscription_id, topic) in owed {
                if sink
                    .send(resync_message(&subscription_id, topic))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    }
}

/// Send the policy close frame. A dropped sender means the peer already
/// left: no frame.
async fn send_close<S>(sink: &mut S, reason: Result<&'static str, RecvError>)
where
    S: Sink<Message> + Unpin,
{
    let Ok(reason) = reason else { return };
    let frame = CloseFrame {
        code: close_code::POLICY,
        reason: reason.into(),
    };
    if sink.send(Message::Close(Some(frame))).await.is_err() {
        tracing::debug!("plugin socket closed before the policy close frame");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use serde_json::Value;

    fn decode(message: Message) -> Value {
        match message {
            Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_full_queue_drops_events_and_resyncs_before_the_next_one() {
        let (out, mut rx) = channel(2);
        assert!(out.event("1".into(), "s1", "git.status"));
        assert!(out.event("2".into(), "s1", "git.status"));
        assert!(
            out.event("3".into(), "s1", "git.status"),
            "dropped, not closed"
        );
        assert!(matches!(rx.try_recv(), Ok(Message::Text(t)) if t.as_str() == "1"));
        // One slot free: the resync takes it and event 4 is lost as well.
        assert!(out.event("4".into(), "s1", "git.status"));
        assert!(matches!(rx.try_recv(), Ok(Message::Text(t)) if t.as_str() == "2"));
        assert_eq!(decode(rx.try_recv().unwrap())["action"], "resync");
        assert!(rx.try_recv().is_err());
        // Room again: the debt is paid ahead of the next event.
        assert!(out.event("5".into(), "s1", "git.status"));
        assert!(out.event("6".into(), "s1", "git.status"));
        let resync = decode(rx.try_recv().unwrap());
        assert_eq!(resync["payload"]["subscription_id"], "s1");
        assert!(matches!(rx.try_recv(), Ok(Message::Text(t)) if t.as_str() == "5"));
        assert!(out.shared.owed().contains_key("s1"), "6 did not fit");
        out.forgive("s1");
        assert!(out.shared.owed().is_empty());
        drop(rx);
        assert!(!out.event("7".into(), "s2", "git.status"));
    }

    #[tokio::test]
    async fn the_policy_close_frame_follows_the_last_producer_leaving_first() {
        let (out, rx) = channel(4);
        let (sink, mut peer) = futures::channel::mpsc::unbounded();
        let (close_tx, close_rx) = oneshot::channel();
        let writer = write(sink, rx, out.shared(), close_rx);
        tokio::pin!(writer);
        drop(out);
        // The writer sees the queue closed before the reason arrives.
        assert!(futures::poll!(&mut writer).is_pending());
        close_tx
            .send("grant revoked")
            .expect("the writer still waits for the reason");
        writer.await;
        match peer.next().await {
            Some(Message::Close(Some(frame))) => {
                assert_eq!(frame.code, close_code::POLICY);
                assert_eq!(frame.reason.as_str(), "grant revoked");
            }
            other => panic!("expected the policy close frame, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_peer_that_left_gets_no_close_frame() {
        let (out, rx) = channel(4);
        let (sink, mut peer) = futures::channel::mpsc::unbounded();
        let (close_tx, close_rx) = oneshot::channel::<&'static str>();
        let writer = write(sink, rx, out.shared(), close_rx);
        tokio::pin!(writer);
        drop(out);
        assert!(futures::poll!(&mut writer).is_pending());
        drop(close_tx);
        tokio::time::timeout(std::time::Duration::from_secs(1), writer)
            .await
            .expect("the writer stops once the peer left");
        assert!(peer.next().await.is_none());
    }

    #[test]
    fn an_unread_reply_marks_the_client_stalled() {
        let (out, _rx) = channel(1);
        out.control(WsEnvelope::new("plugin", "error", json!({})));
        assert!(!out.stalled().is_cancelled());
        out.control(WsEnvelope::new("plugin", "error", json!({})));
        assert!(out.stalled().is_cancelled());
    }
}
