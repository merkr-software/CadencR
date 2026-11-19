//! Bounded events for one plugin/conversation slot, surviving process restarts.

use std::sync::{Arc, Mutex};

use cadencr_tab_backend::protocol::Event;
use serde::Serialize;
use tokio::sync::broadcast;

use super::protocol::lock;

pub const EVENT_CAPACITY: usize = 64;

#[derive(Debug, Serialize)]
pub struct StampedEvent {
    pub run_id: String,
    pub seq: u64,
    pub topic: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone)]
pub enum Update {
    Event(Arc<StampedEvent>),
    Resync,
    Error { code: String, message: String },
}

#[derive(Default)]
struct Cursor {
    run_id: Option<String>,
    seq: u64,
}

#[derive(Clone)]
pub(super) struct Events {
    tx: broadcast::Sender<Update>,
    cursor: Arc<Mutex<Cursor>>,
}

impl Default for Events {
    fn default() -> Self {
        Self {
            tx: broadcast::channel(EVENT_CAPACITY).0,
            cursor: Arc::default(),
        }
    }
}

impl Events {
    pub fn subscribe(&self) -> broadcast::Receiver<Update> {
        self.tx.subscribe()
    }

    pub fn start(&self, run_id: &str) {
        let mut cursor = lock(&self.cursor);
        cursor.run_id = Some(run_id.to_owned());
        cursor.seq = 0;
        let _ = self.tx.send(Update::Resync);
    }

    pub fn emit(&self, run_id: &str, event: Event) {
        let mut cursor = lock(&self.cursor);
        if cursor.run_id.as_deref() != Some(run_id) {
            return; // An old stdout reader finishing after a replacement started.
        }
        cursor.seq += 1;
        let _ = self.tx.send(Update::Event(Arc::new(StampedEvent {
            run_id: run_id.to_owned(),
            seq: cursor.seq,
            topic: event.topic,
            payload: event.payload,
        })));
    }

    pub fn error(&self, run_id: &str, code: &str, message: &str) {
        if lock(&self.cursor).run_id.as_deref() == Some(run_id) {
            let _ = self.tx.send(Update::Error {
                code: code.to_owned(),
                message: message.to_owned(),
            });
            let _ = self.tx.send(Update::Resync);
        }
    }

    pub fn end(&self, run_id: &str, reason: &str) {
        let mut cursor = lock(&self.cursor);
        if cursor.run_id.as_deref() != Some(run_id) {
            return;
        }
        cursor.run_id = None;
        let _ = self.tx.send(Update::Resync);
        let _ = self.tx.send(Update::Error {
            code: "PLUGIN_BACKEND_EXITED".into(),
            message: reason.to_owned(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tick() -> Event {
        Event {
            topic: "clock.tick".into(),
            payload: json!({"tick": 1}),
        }
    }

    #[test]
    fn process_identity_is_host_owned_and_old_readers_cannot_emit_after_restart() {
        let events = Events::default();
        let mut rx = events.subscribe();
        events.start("one");
        assert!(matches!(rx.try_recv(), Ok(Update::Resync)));
        events.emit("one", tick());
        let Update::Event(first) = rx.try_recv().unwrap() else {
            panic!("event")
        };
        assert_eq!((&*first.run_id, first.seq), ("one", 1));
        events.start("two");
        rx.try_recv().unwrap();
        events.end("one", "late exit");
        events.emit("one", tick());
        assert!(rx.try_recv().is_err());
        events.emit("two", tick());
        let Update::Event(second) = rx.try_recv().unwrap() else {
            panic!("event")
        };
        assert_eq!((&*second.run_id, second.seq), ("two", 1));
        events.end("two", "stopped");
        assert!(matches!(rx.try_recv(), Ok(Update::Resync)));
        assert!(matches!(rx.try_recv(), Ok(Update::Error { .. })));
    }

    #[test]
    fn a_slow_receiver_lags_without_blocking_requests_or_other_slots() {
        let events = Events::default();
        let other = Events::default();
        let mut rx = events.subscribe();
        let mut isolated = other.subscribe();
        events.start("one");
        for _ in 0..EVENT_CAPACITY * 2 {
            events.emit("one", tick());
        }
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        assert!(isolated.try_recv().is_err());
    }
}
