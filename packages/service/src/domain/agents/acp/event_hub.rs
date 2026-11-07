//! Ordered, lossless ACP event delivery, independent of the best-effort
//! broadcast used by short-lived observers (probes, tests).
//!
//! Adapted from the Codex app-server SDK's `event_queue.rs`. The transport
//! reader never waits for consumers: JSON-RPC responses must stay readable
//! while a consumer awaits an RPC. A reliable subscription therefore buffers
//! without bound up to a safety limit; exceeding it ends that subscription
//! with a terminal [`AcpEvent::TransportError`] after the events it already
//! retains. Events are never overwritten or skipped silently — a skipped
//! server request would leave its responder (and the agent) waiting forever,
//! and a skipped [`AcpEvent::EventBarrier`] would wedge turn completion.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, Weak};

use serde_json::Value;
use tokio::sync::{broadcast, Notify};

use crate::domain::agents::acp::incoming::{AcpNotification, AcpServerRequest};
use crate::domain::agents::acp::types::AcpEvent;

const MAX_EVENTS: usize = 65_536;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const OBSERVER_CAPACITY: usize = 4096;

#[derive(Clone)]
pub(crate) struct AcpEventHub(Arc<HubState>);

struct HubState {
    broadcast: broadcast::Sender<AcpEvent>,
    subscribers: Mutex<Vec<Weak<Queue>>>,
}

#[derive(Default)]
struct Queue {
    state: Mutex<QueueState>,
    ready: Notify,
}

#[derive(Default)]
struct QueueState {
    events: VecDeque<(AcpEvent, usize)>,
    bytes: usize,
    closed: bool,
    /// Set while a `session/load` transcript replay may stream in before the
    /// event loop runs: notifications are dropped on arrival instead of
    /// filling the backlog (and possibly overflowing it) only to be
    /// discarded later. Every other event is still queued.
    discard_notifications: bool,
}

/// An ordered subscription. A backlog exceeding an estimated 64 MiB or
/// 65,536 events ends with `AcpEvent::TransportError`; unread events are never
/// overwritten. Dropping the receiver releases its backlog (and with it any
/// queued barrier, whose waiter then observes the loss).
pub struct AcpReliableEventReceiver(Arc<Queue>);

impl AcpEventHub {
    pub(crate) fn new() -> Self {
        Self(Arc::new(HubState {
            broadcast: broadcast::channel(OBSERVER_CAPACITY).0,
            subscribers: Mutex::new(Vec::new()),
        }))
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<AcpEvent> {
        self.0.broadcast.subscribe()
    }

    pub(crate) fn subscribe_reliable(&self) -> AcpReliableEventReceiver {
        let queue = Arc::new(Queue::default());
        let mut subscribers = self.subscribers();
        subscribers.retain(|queue| queue.strong_count() > 0);
        subscribers.push(Arc::downgrade(&queue));
        AcpReliableEventReceiver(queue)
    }

    /// Deliver to every subscriber. Returns whether anyone accepted the event.
    /// A server request counts as accepted only by a reliable subscriber:
    /// best-effort observers never answer one, so counting them would leave
    /// the agent waiting for a response nobody sends.
    pub(crate) fn send(&self, event: AcpEvent) -> bool {
        let answerable_by_observer = !matches!(event, AcpEvent::ServerRequest(_));
        let observed =
            self.0.broadcast.receiver_count() > 0 && self.0.broadcast.send(event.clone()).is_ok();
        self.send_reliable(event) || (observed && answerable_by_observer)
    }

    /// Deliver only to reliable subscribers. Barriers use this: a lagging
    /// broadcast slot would otherwise retain the barrier and hide its loss.
    pub(crate) fn send_reliable(&self, event: AcpEvent) -> bool {
        let mut subscribers = self.subscribers();
        let mut event = Some(event);
        let mut bytes = None;
        let mut remaining = subscribers.len();
        let mut accepted = false;
        subscribers.retain(|subscriber| {
            remaining -= 1;
            let Some(queue) = subscriber.upgrade() else {
                return false;
            };
            let mut state = queue.state.lock().expect("ACP event queue poisoned");
            if state.closed {
                return false;
            }
            let retained = event
                .as_ref()
                .expect("event retained until last subscriber");
            if state.discard_notifications && matches!(retained, AcpEvent::Notification(_)) {
                return true;
            }
            let bytes = *bytes.get_or_insert_with(|| event_size(retained));
            if state.events.len() >= MAX_EVENTS || bytes > MAX_BYTES - state.bytes {
                let message = format!(
                    "ACP event backlog exceeded its safety limit ({} MiB or {MAX_EVENTS} events)",
                    MAX_BYTES / (1024 * 1024)
                );
                state
                    .events
                    .push_back((AcpEvent::TransportError { message }, 0));
                state.closed = true;
            } else {
                state.bytes += bytes;
                // The final queue takes ownership; only real fan-out copies.
                let queued = if remaining == 0 {
                    event.take().expect("event retained until last subscriber")
                } else {
                    retained.clone()
                };
                state.events.push_back((queued, bytes));
                accepted = true;
            }
            queue.ready.notify_one();
            !state.closed
        });
        accepted
    }

    fn subscribers(&self) -> std::sync::MutexGuard<'_, Vec<Weak<Queue>>> {
        self.0
            .subscribers
            .lock()
            .expect("ACP event subscribers poisoned")
    }
}

impl AcpReliableEventReceiver {
    /// Cancellation safe. Returns `None` after the hub closes and all queued
    /// events (including any terminal error) have been consumed.
    pub async fn recv(&mut self) -> Option<AcpEvent> {
        loop {
            {
                let mut state = self.0.state.lock().expect("ACP event queue poisoned");
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

    /// Drop notifications on arrival from now on (e.g. a `session/load`
    /// transcript replay with no consumer yet). Server requests, barriers,
    /// exits and transport errors are still queued in order.
    pub(crate) fn begin_discarding_notifications(&self) {
        self.0
            .state
            .lock()
            .expect("ACP event queue poisoned")
            .discard_notifications = true;
    }

    /// Resume queueing notifications, and discard the ones queued before
    /// [`Self::begin_discarding_notifications`]. Returns how many were dropped.
    pub(crate) fn finish_discarding_notifications(&mut self) -> usize {
        self.0
            .state
            .lock()
            .expect("ACP event queue poisoned")
            .discard_notifications = false;
        self.discard_queued_notifications()
    }

    /// Discard queued notifications while keeping server requests, barriers,
    /// exits and transport errors in order: those must still reach the event
    /// loop or something hangs.
    fn discard_queued_notifications(&mut self) -> usize {
        let mut state = self.0.state.lock().expect("ACP event queue poisoned");
        let before = state.events.len();
        let mut released = 0;
        state.events.retain(|(event, bytes)| {
            let keep = !matches!(event, AcpEvent::Notification(_));
            if !keep {
                released += bytes;
            }
            keep
        });
        state.bytes -= released;
        before - state.events.len()
    }
}

impl Drop for HubState {
    fn drop(&mut self) {
        for queue in self
            .subscribers
            .get_mut()
            .expect("ACP event subscribers poisoned")
            .iter()
            .filter_map(Weak::upgrade)
        {
            queue.state.lock().expect("ACP event queue poisoned").closed = true;
            queue.ready.notify_one();
        }
    }
}

fn event_size(event: &AcpEvent) -> usize {
    std::mem::size_of::<AcpEvent>()
        + 32
        + match event {
            AcpEvent::Notification(AcpNotification::SessionUpdate { raw }) => value_size(raw),
            AcpEvent::Notification(AcpNotification::Extension { method, params }) => {
                method.capacity() + value_size(params)
            }
            AcpEvent::ServerRequest(AcpServerRequest::Known {
                id,
                method,
                raw,
                typed,
            }) => {
                // The typed parse roughly duplicates the raw payload.
                let raw_size = value_size(raw);
                let typed_size = if typed.is_some() { raw_size } else { 0 };
                method.capacity() + value_size(id) + raw_size + typed_size
            }
            AcpEvent::ServerRequest(AcpServerRequest::Extension { id, method, params }) => {
                method.capacity() + value_size(id) + value_size(params)
            }
            AcpEvent::TransportError { message } => message.capacity(),
            AcpEvent::EventBarrier(_) | AcpEvent::ProcessExited { .. } => 0,
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
    use crate::domain::agents::acp::types::AcpEventBarrier;
    use serde_json::json;

    fn update(n: usize) -> AcpEvent {
        AcpEvent::Notification(AcpNotification::SessionUpdate {
            raw: json!({"n": n}),
        })
    }

    fn request(id: i64) -> AcpEvent {
        AcpEvent::ServerRequest(AcpServerRequest::from_parts(
            json!(id),
            "session/request_permission".into(),
            json!({}),
        ))
    }

    fn update_n(event: Option<AcpEvent>) -> Option<u64> {
        match event {
            Some(AcpEvent::Notification(AcpNotification::SessionUpdate { raw })) => {
                raw["n"].as_u64()
            }
            _ => None,
        }
    }

    #[tokio::test]
    async fn stalled_consumer_preserves_burst_permission_barrier_and_exit() {
        // The old broadcast(4096) dropped everything past its capacity,
        // including the permission request and the turn-end barrier.
        let hub = AcpEventHub::new();
        let mut rx = hub.subscribe_reliable();
        for n in 0..10_000 {
            assert!(hub.send(update(n)));
        }
        assert!(hub.send(request(42)));
        let (barrier, released) = AcpEventBarrier::new();
        assert!(hub.send_reliable(AcpEvent::EventBarrier(barrier)));
        hub.send(AcpEvent::ProcessExited {
            status: Some(0),
            signal: None,
        });
        drop(hub);
        for n in 0..10_000 {
            assert_eq!(update_n(rx.recv().await), Some(n));
        }
        assert!(
            matches!(rx.recv().await, Some(AcpEvent::ServerRequest(r)) if r.id() == &json!(42))
        );
        let Some(AcpEvent::EventBarrier(barrier)) = rx.recv().await else {
            panic!("barrier must survive the burst");
        };
        barrier.release();
        released.await.expect("barrier released");
        assert!(matches!(
            rx.recv().await,
            Some(AcpEvent::ProcessExited { .. })
        ));
        assert!(rx.recv().await.is_none());
        assert_eq!(rx.0.state.lock().unwrap().bytes, 0);
    }

    #[tokio::test]
    async fn overflow_is_terminal_visible_and_preserves_prior_events() {
        let hub = AcpEventHub::new();
        let mut rx = hub.subscribe_reliable();
        for n in 0..MAX_EVENTS {
            assert!(hub.send(update(n)));
        }
        assert!(!hub.send(update(MAX_EVENTS)), "overflow must be reported");
        assert!(!hub.send(request(7)), "a closed queue accepts nothing");
        for n in 0..MAX_EVENTS {
            assert_eq!(update_n(rx.recv().await), Some(n as u64));
        }
        assert!(matches!(
            rx.recv().await,
            Some(AcpEvent::TransportError { message }) if message.contains("safety limit")
        ));
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn byte_limit_overflows_and_receiving_releases_budget() {
        let hub = AcpEventHub::new();
        let mut rx = hub.subscribe_reliable();
        let large = || {
            AcpEvent::Notification(AcpNotification::SessionUpdate {
                raw: json!("x".repeat(MAX_BYTES / 2)),
            })
        };
        assert!(hub.send(large()));
        assert!(rx.recv().await.is_some());
        assert!(hub.send(large()));
        assert!(!hub.send(large()));
        assert!(rx.recv().await.is_some());
        assert!(matches!(
            rx.recv().await,
            Some(AcpEvent::TransportError { .. })
        ));
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn dropping_a_queued_barrier_wakes_its_waiter_with_an_error() {
        let hub = AcpEventHub::new();
        let rx = hub.subscribe_reliable();
        let (barrier, released) = AcpEventBarrier::new();
        assert!(hub.send_reliable(AcpEvent::EventBarrier(barrier)));
        drop(rx);
        assert!(released.await.is_err(), "a lost barrier must not hang");
        let (barrier, released) = AcpEventBarrier::new();
        assert!(!hub.send_reliable(AcpEvent::EventBarrier(barrier)));
        assert!(released.await.is_err());
    }

    #[tokio::test]
    async fn observers_never_receive_barriers_but_see_everything_else() {
        let hub = AcpEventHub::new();
        let mut observer = hub.subscribe();
        let mut reliable = hub.subscribe_reliable();
        let (barrier, _released) = AcpEventBarrier::new();
        hub.send_reliable(AcpEvent::EventBarrier(barrier));
        hub.send(update(1));
        assert_eq!(update_n(observer.recv().await.ok()), Some(1));
        assert!(matches!(
            reliable.recv().await,
            Some(AcpEvent::EventBarrier(_))
        ));
        assert_eq!(update_n(reliable.recv().await), Some(1));
    }

    #[tokio::test]
    async fn discarding_notifications_keeps_requests_and_exit_in_order() {
        let hub = AcpEventHub::new();
        let mut rx = hub.subscribe_reliable();
        hub.send(update(1));
        hub.send(request(5));
        hub.send(update(2));
        hub.send(AcpEvent::ProcessExited {
            status: Some(1),
            signal: None,
        });
        assert_eq!(rx.finish_discarding_notifications(), 2);
        assert!(matches!(rx.recv().await, Some(AcpEvent::ServerRequest(_))));
        assert!(matches!(
            rx.recv().await,
            Some(AcpEvent::ProcessExited { .. })
        ));
        assert_eq!(rx.0.state.lock().unwrap().bytes, 0);
    }

    #[tokio::test]
    async fn discarded_replay_never_overflows_and_keeps_concurrent_requests() {
        // A 70k-update `session/load` replay used to be queued (and close the
        // queue past MAX_EVENTS) only to be thrown away before the loop ran.
        let hub = AcpEventHub::new();
        let mut rx = hub.subscribe_reliable();
        hub.send(update(0));
        rx.begin_discarding_notifications();
        let (barrier, _released) = AcpEventBarrier::new();
        for n in 1..=70_000 {
            if n == 35_000 {
                assert!(hub.send(request(9)), "requests are still accepted");
                assert!(hub.send_reliable(AcpEvent::EventBarrier(barrier.clone())));
            }
            hub.send(update(n));
        }
        {
            let state = rx.0.state.lock().unwrap();
            assert!(!state.closed, "replay must not overflow the queue");
            assert_eq!(state.events.len(), 3);
        }
        assert_eq!(rx.finish_discarding_notifications(), 1);
        assert!(hub.send(update(70_001)));
        assert!(matches!(rx.recv().await, Some(AcpEvent::ServerRequest(r)) if r.id() == &json!(9)));
        assert!(matches!(rx.recv().await, Some(AcpEvent::EventBarrier(_))));
        assert_eq!(update_n(rx.recv().await), Some(70_001));
        assert_eq!(rx.0.state.lock().unwrap().bytes, 0);
    }

    #[tokio::test]
    async fn server_request_seen_only_by_an_observer_is_not_accepted() {
        let hub = AcpEventHub::new();
        let mut observer = hub.subscribe();
        assert!(!hub.send(request(3)), "an observer cannot answer a request");
        assert!(matches!(
            observer.recv().await,
            Ok(AcpEvent::ServerRequest(_))
        ));
        assert!(hub.send(update(1)), "observers still accept notifications");
        let _reliable = hub.subscribe_reliable();
        assert!(hub.send(request(4)));
    }

    #[tokio::test]
    async fn waiting_receiver_wakes_for_events_and_hub_close() {
        let hub = AcpEventHub::new();
        let mut rx = hub.subscribe_reliable();
        let consumer = tokio::spawn(async move {
            assert!(rx.recv().await.is_some());
            assert!(rx.recv().await.is_none());
        });
        tokio::task::yield_now().await;
        hub.send(update(1));
        tokio::task::yield_now().await;
        drop(hub);
        tokio::time::timeout(std::time::Duration::from_secs(1), consumer)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn sole_reliable_consumer_takes_payload_ownership() {
        let hub = AcpEventHub::new();
        let mut rx = hub.subscribe_reliable();
        let method = "_qa/extension".to_owned();
        let allocation = method.as_ptr();
        hub.send(AcpEvent::Notification(AcpNotification::Extension {
            method,
            params: json!({}),
        }));
        let Some(AcpEvent::Notification(AcpNotification::Extension { method, .. })) =
            rx.recv().await
        else {
            panic!("extension notification");
        };
        assert_eq!(method.as_ptr(), allocation, "no copy for a single consumer");
    }

    #[test]
    fn send_without_any_subscriber_reports_no_delivery() {
        let hub = AcpEventHub::new();
        assert!(!hub.send(update(1)));
    }
}
