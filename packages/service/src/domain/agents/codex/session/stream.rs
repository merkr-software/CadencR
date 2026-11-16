use tokio::sync::mpsc;
use tracing::warn;

use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent, RuntimeMessageRx};

type LocalRx = mpsc::UnboundedReceiver<Result<RuntimeEvent, RuntimeError>>;
type StreamTx = mpsc::Sender<Result<RuntimeEvent, RuntimeError>>;

const STREAM_CAPACITY: usize = 256;

/// Stream channel pre-filled with the local events queued before the stream
/// was taken (the init event). The first turn may already be running by then,
/// and the event loop would otherwise race the local forwarder for the head of
/// the stream.
pub(super) fn stream_channel(local_rx: &mut LocalRx) -> (StreamTx, RuntimeMessageRx) {
    let queued: Vec<_> = std::iter::from_fn(|| local_rx.try_recv().ok()).collect();
    let (tx, rx) = mpsc::channel(STREAM_CAPACITY.max(queued.len()));
    for event in queued {
        // Cannot fail: the capacity covers every queued event and `rx` is alive.
        if tx.try_send(event).is_err() {
            warn!("Codex dropped a queued local event");
        }
    }
    (tx, rx)
}

pub(super) fn spawn_local_forwarder(mut local_rx: LocalRx, tx: StreamTx) {
    tokio::spawn(async move {
        while let Some(event) = local_rx.recv().await {
            if tx.send(event).await.is_err() {
                break;
            }
        }
    });
}

pub(super) fn error_receiver(message: &'static str) -> RuntimeMessageRx {
    let (tx, rx) = mpsc::channel(1);
    let _ = tx.try_send(Err(RuntimeError::new(message)));
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::codex::event_system::init_event;

    #[tokio::test]
    async fn queued_local_events_lead_the_stream() {
        let (local_tx, mut local_rx) = mpsc::unbounded_channel();
        local_tx
            .send(Ok(init_event("thread", None, None, Vec::new())))
            .unwrap();

        let (tx, mut rx) = stream_channel(&mut local_rx);
        // The event loop starts sending as soon as it is spawned.
        tx.try_send(Err(RuntimeError::new("turn event"))).unwrap();

        assert!(rx.recv().await.unwrap().is_ok(), "init event comes first");
        assert!(rx.recv().await.unwrap().is_err());
    }
}
