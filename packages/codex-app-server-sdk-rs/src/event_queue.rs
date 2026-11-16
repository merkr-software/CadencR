//! Ordered runtime subscriptions, independent of the best-effort broadcast.
//! The reader never waits for consumers: RPC responses must remain readable while
//! a consumer awaits an RPC. Resource exhaustion terminates that subscription
//! explicitly, after its retained events, instead of overwriting older events.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, Weak};

use serde_json::Value;
use tokio::sync::{broadcast, Notify};

use crate::AppServerEvent;

const MAX_EVENTS: usize = 65_536;
const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct EventHub(Arc<HubState>);

struct HubState {
    broadcast: broadcast::Sender<AppServerEvent>,
    subscribers: Mutex<Vec<Weak<Queue>>>,
}

#[derive(Default)]
struct Queue {
    state: Mutex<QueueState>,
    ready: Notify,
}

#[derive(Default)]
struct QueueState {
    events: VecDeque<(AppServerEvent, usize)>,
    bytes: usize,
    closed: bool,
}

/// An ordered subscription. A backlog exceeding an estimated 64 MiB or 65,536
/// events ends with `TransportError`; unread events are never overwritten.
/// Dropping the receiver immediately releases its backlog.
pub struct AppServerEventReceiver(Arc<Queue>);

impl EventHub {
    pub(crate) fn new() -> Self {
        Self(Arc::new(HubState {
            broadcast: broadcast::channel(512).0,
            subscribers: Mutex::new(Vec::new()),
        }))
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<AppServerEvent> {
        self.0.broadcast.subscribe()
    }

    pub(crate) fn subscribe_reliable(&self) -> AppServerEventReceiver {
        let queue = Arc::new(Queue::default());
        let mut subscribers = self
            .0
            .subscribers
            .lock()
            .expect("event subscribers poisoned");
        subscribers.retain(|queue| queue.strong_count() > 0);
        subscribers.push(Arc::downgrade(&queue));
        AppServerEventReceiver(queue)
    }

    pub(crate) fn send(&self, event: AppServerEvent) {
        let mut subscribers = self
            .0
            .subscribers
            .lock()
            .expect("event subscribers poisoned");
        if subscribers.is_empty() {
            let _ = self.0.broadcast.send(event);
            return;
        }
        if self.0.broadcast.receiver_count() > 0 {
            let _ = self.0.broadcast.send(event.clone());
        }
        let mut event = Some(event);
        let mut bytes = None;
        let mut remaining = subscribers.len();
        subscribers.retain(|subscriber| {
            remaining -= 1;
            let Some(queue) = subscriber.upgrade() else {
                return false;
            };
            let mut state = queue.state.lock().expect("event queue poisoned");
            if state.closed {
                return false;
            }
            let bytes = *bytes.get_or_insert_with(|| {
                event_size(
                    event
                        .as_ref()
                        .expect("event retained until last subscriber"),
                )
            });
            if state.events.len() >= MAX_EVENTS || bytes > MAX_BYTES - state.bytes {
                state.events.push_back((
                    AppServerEvent::TransportError {
                        message:
                            "Codex event backlog exceeded its safety limit (64 MiB or 65536 events)"
                                .into(),
                    },
                    0,
                ));
                state.closed = true;
            } else {
                state.bytes += bytes;
                // The final queue takes ownership; only actual fan-out copies payloads.
                let queued = if remaining == 0 {
                    event.take().expect("event retained until last subscriber")
                } else {
                    event
                        .as_ref()
                        .expect("event retained until last subscriber")
                        .clone()
                };
                state.events.push_back((queued, bytes));
            }
            queue.ready.notify_one();
            !state.closed
        });
    }
}

impl AppServerEventReceiver {
    /// Cancellation safe. Returns `None` after the sender closes and all queued
    /// events (including any terminal error) have been consumed.
    pub async fn recv(&mut self) -> Option<AppServerEvent> {
        loop {
            {
                let mut state = self.0.state.lock().expect("event queue poisoned");
                if let Some((event, bytes)) = state.events.pop_front() {
                    state.bytes -= bytes;
                    return Some(event);
                }
                if state.closed {
                    return None;
                }
            }
            self.0.ready.notified().await;
        }
    }
}

impl Drop for HubState {
    fn drop(&mut self) {
        for queue in self
            .subscribers
            .get_mut()
            .expect("event subscribers poisoned")
            .iter()
            .filter_map(Weak::upgrade)
        {
            queue.state.lock().expect("event queue poisoned").closed = true;
            queue.ready.notify_one();
        }
    }
}

fn event_size(event: &AppServerEvent) -> usize {
    std::mem::size_of::<AppServerEvent>()
        + 32
        + match event {
            AppServerEvent::Notification { method, params } => {
                method.capacity() + value_size(params)
            }
            AppServerEvent::ServerRequest { id, method, params } => {
                method.capacity() + value_size(id) + value_size(params)
            }
            AppServerEvent::TransportError { message } => message.capacity(),
            AppServerEvent::ProcessExited { .. } => 0,
        }
}

fn value_size(value: &Value) -> usize {
    std::mem::size_of::<Value>()
        + match value {
            Value::String(text) => text.capacity(),
            Value::Array(items) => {
                items.iter().map(value_size).sum::<usize>()
                    + (items.capacity() - items.len()) * std::mem::size_of::<Value>()
            }
            Value::Object(fields) => fields
                .iter()
                .map(|(key, value)| key.capacity() + 128 + value_size(value))
                .sum(),
            _ => 0,
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(n: usize) -> AppServerEvent {
        AppServerEvent::Notification {
            method: "item/commandExecution/outputDelta".into(),
            params: json!({"n": n}),
        }
    }

    #[tokio::test]
    async fn stalled_consumer_preserves_burst_approval_completion_and_exit() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe_reliable();
        for n in 0..10_000 {
            hub.send(event(n));
        }
        hub.send(AppServerEvent::ServerRequest {
            id: json!(42),
            method: "approval".into(),
            params: json!({}),
        });
        hub.send(AppServerEvent::Notification {
            method: "turn/completed".into(),
            params: json!({}),
        });
        hub.send(AppServerEvent::ProcessExited {
            status: Some(0),
            signal: None,
        });
        drop(hub);
        for n in 0..10_000 {
            assert!(
                matches!(rx.recv().await, Some(AppServerEvent::Notification { params, .. }) if params["n"] == n)
            );
        }
        assert!(matches!(
            rx.recv().await,
            Some(AppServerEvent::ServerRequest { .. })
        ));
        assert!(
            matches!(rx.recv().await, Some(AppServerEvent::Notification { method, .. }) if method == "turn/completed")
        );
        assert!(matches!(
            rx.recv().await,
            Some(AppServerEvent::ProcessExited { .. })
        ));
        assert!(rx.recv().await.is_none());
        assert_eq!(rx.0.state.lock().unwrap().bytes, 0);
    }

    #[tokio::test]
    async fn overflow_is_terminal_and_preserves_prior_events() {
        for byte_limit in [false, true] {
            let hub = EventHub::new();
            let mut rx = hub.subscribe_reliable();
            let count = if byte_limit { 1 } else { MAX_EVENTS };
            for n in 0..count {
                hub.send(event(n));
            }
            if byte_limit {
                hub.send(AppServerEvent::Notification {
                    method: "large".into(),
                    params: json!("x".repeat(MAX_BYTES)),
                });
            } else {
                hub.send(event(count));
            }
            hub.send(event(count + 1));
            for n in 0..count {
                assert!(
                    matches!(rx.recv().await, Some(AppServerEvent::Notification { params, .. }) if params["n"] == n)
                );
            }
            assert!(
                matches!(rx.recv().await, Some(AppServerEvent::TransportError { message }) if message.contains("safety limit"))
            );
            assert!(rx.recv().await.is_none());
        }
    }

    #[tokio::test]
    async fn cumulative_byte_limit_releases_budget_after_receive() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe_reliable();
        let large = || AppServerEvent::Notification {
            method: "large".into(),
            params: json!("x".repeat(MAX_BYTES / 2)),
        };
        hub.send(large());
        assert!(matches!(
            rx.recv().await,
            Some(AppServerEvent::Notification { .. })
        ));
        hub.send(large()); // Receiving released enough budget for another payload.
        hub.send(large()); // Individually valid, but their combined size exceeds the cap.
        assert!(matches!(
            rx.recv().await,
            Some(AppServerEvent::Notification { .. })
        ));
        assert!(matches!(
            rx.recv().await,
            Some(AppServerEvent::TransportError { .. })
        ));
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn sole_consumer_takes_payload_ownership() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe_reliable();
        let method = "item/commandExecution/outputDelta".to_owned();
        let allocation = method.as_ptr();
        hub.send(AppServerEvent::Notification {
            method,
            params: json!({}),
        });
        let Some(AppServerEvent::Notification { method, .. }) = rx.recv().await else {
            panic!("notification")
        };
        assert_eq!(method.as_ptr(), allocation);
    }

    #[tokio::test]
    async fn fanout_preserves_each_subscriber_and_observer() {
        let hub = EventHub::new();
        let mut first = hub.subscribe_reliable();
        let mut second = hub.subscribe_reliable();
        let mut observer = hub.subscribe();
        for n in 0..3 {
            hub.send(event(n));
        }
        for n in 0..3 {
            for received in [
                first.recv().await.unwrap(),
                second.recv().await.unwrap(),
                observer.recv().await.unwrap(),
            ] {
                assert!(
                    matches!(received, AppServerEvent::Notification { params, .. } if params["n"] == n)
                );
            }
        }
    }

    #[tokio::test]
    async fn waiting_receiver_wakes_for_events_and_sender_close() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe_reliable();
        let consumer = tokio::spawn(async move {
            assert!(matches!(
                rx.recv().await,
                Some(AppServerEvent::Notification { .. })
            ));
            assert!(rx.recv().await.is_none());
        });
        tokio::task::yield_now().await;
        hub.send(event(1));
        tokio::task::yield_now().await;
        drop(hub);
        tokio::time::timeout(std::time::Duration::from_secs(1), consumer)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn consuming_events_releases_the_backlog_budget() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe_reliable();
        for n in 0..MAX_EVENTS + 1 {
            hub.send(event(n));
            assert!(matches!(
                rx.recv().await,
                Some(AppServerEvent::Notification { .. })
            ));
            assert_eq!(rx.0.state.lock().unwrap().bytes, 0);
        }
    }

    #[tokio::test]
    async fn dropping_receiver_releases_backlog_and_does_not_affect_other_subscribers() {
        let hub = EventHub::new();
        let rx = hub.subscribe_reliable();
        let weak = Arc::downgrade(&rx.0);
        let mut other = hub.subscribe_reliable();
        hub.send(event(1));
        drop(rx);
        assert!(weak.upgrade().is_none());
        hub.send(event(2));
        assert_eq!(hub.0.subscribers.lock().unwrap().len(), 1);
        for n in [1, 2] {
            assert!(
                matches!(other.recv().await, Some(AppServerEvent::Notification { params, .. }) if params["n"] == n)
            );
        }
    }
}
