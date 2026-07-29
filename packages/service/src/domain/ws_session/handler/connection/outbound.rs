//! Bounded WebSocket outbound queue and priority close delivery.

use std::fmt::Display;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message};
use futures::{Sink, SinkExt};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, warn};

pub(super) const OUTBOUND_SOCKET_CAPACITY: usize = 256;
pub(super) const OUTBOUND_SOCKET_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_CLOSE_SEND_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OutboundBridgeExit {
    SendTimeout,
    SocketClosed,
}

pub(super) fn retryable_close(reason: &'static str) -> CloseFrame {
    CloseFrame {
        code: 1013,
        reason: reason.into(),
    }
}

pub(super) fn spawn_outbound_bridge(
    outbound_rx: mpsc::UnboundedReceiver<Message>,
    socket_tx: mpsc::Sender<Message>,
) -> (
    tokio::task::JoinHandle<()>,
    oneshot::Receiver<OutboundBridgeExit>,
) {
    spawn_outbound_bridge_with_timeout(outbound_rx, socket_tx, OUTBOUND_SOCKET_SEND_TIMEOUT)
}

fn spawn_outbound_bridge_with_timeout(
    mut outbound_rx: mpsc::UnboundedReceiver<Message>,
    socket_tx: mpsc::Sender<Message>,
    send_timeout: Duration,
) -> (
    tokio::task::JoinHandle<()>,
    oneshot::Receiver<OutboundBridgeExit>,
) {
    let (exit_tx, exit_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            let message = match socket_tx.try_send(message) {
                Ok(()) => continue,
                Err(mpsc::error::TrySendError::Full(message)) => message,
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    let _ = exit_tx.send(OutboundBridgeExit::SocketClosed);
                    return;
                }
            };
            match tokio::time::timeout(send_timeout, socket_tx.send(message)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    let _ = exit_tx.send(OutboundBridgeExit::SocketClosed);
                    return;
                }
                Err(_) => {
                    let _ = exit_tx.send(OutboundBridgeExit::SendTimeout);
                    return;
                }
            }
        }
    });
    (task, exit_rx)
}

pub(super) fn spawn_socket_sender<S>(
    sink: S,
    socket_rx: mpsc::Receiver<Message>,
) -> (tokio::task::JoinHandle<()>, mpsc::Sender<CloseFrame>)
where
    S: Sink<Message> + Unpin + Send + 'static,
    S::Error: Display + Send + 'static,
{
    let (close_tx, close_rx) = mpsc::channel(1);
    let task = tokio::spawn(run_socket_sender(sink, socket_rx, close_rx));
    (task, close_tx)
}

async fn run_socket_sender<S>(
    mut sink: S,
    mut socket_rx: mpsc::Receiver<Message>,
    mut close_rx: mpsc::Receiver<CloseFrame>,
) where
    S: Sink<Message> + Unpin,
    S::Error: Display,
{
    loop {
        let message = tokio::select! {
            biased;
            close = close_rx.recv() => {
                if let Some(frame) = close {
                    send_retry_close(&mut sink, frame).await;
                }
                break;
            }
            message = socket_rx.recv() => {
                let Some(message) = message else { break };
                message
            }
        };
        let close_after_send = matches!(message, Message::Close(_));
        tokio::select! {
            biased;
            close = close_rx.recv() => {
                if let Some(frame) = close {
                    send_retry_close(&mut sink, frame).await;
                }
                break;
            }
            result = sink.send(message) => {
                if let Err(error) = result {
                    debug!(%error, "WebSocket sink send failed");
                    break;
                }
                if close_after_send {
                    break;
                }
            }
        }
    }
}

async fn send_retry_close<S>(sink: &mut S, frame: CloseFrame)
where
    S: Sink<Message> + Unpin,
    S::Error: Display,
{
    match tokio::time::timeout(
        RETRY_CLOSE_SEND_TIMEOUT,
        sink.send(Message::Close(Some(frame))),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => debug!(%error, "WebSocket retry close send failed"),
        Err(_) => warn!("WebSocket retry close send timed out"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn outbound_bridge_waits_before_signalling_a_slow_socket() {
        let (socket_tx, _socket_rx) = mpsc::channel(1);
        socket_tx
            .try_send(Message::Text("already full".into()))
            .expect("prefill bounded queue");
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel();
        let (task, exit) =
            spawn_outbound_bridge_with_timeout(outbound_rx, socket_tx, Duration::from_millis(20));

        outbound_tx
            .send(Message::Text("overflow".into()))
            .expect("enqueue outbound message");

        let reason = tokio::time::timeout(Duration::from_secs(1), exit)
            .await
            .expect("slow socket should be signalled")
            .expect("exit sender should not drop");
        assert_eq!(reason, OutboundBridgeExit::SendTimeout);
        task.await.expect("bridge should exit cleanly");
    }

    #[tokio::test]
    async fn outbound_bridge_drains_after_temporary_backpressure() {
        let (socket_tx, mut socket_rx) = mpsc::channel(1);
        socket_tx
            .try_send(Message::Text("already full".into()))
            .expect("prefill bounded queue");
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel();
        let (task, _exit) =
            spawn_outbound_bridge_with_timeout(outbound_rx, socket_tx, Duration::from_secs(1));
        outbound_tx
            .send(Message::Text("event".into()))
            .expect("enqueue outbound message");

        let _ = socket_rx.recv().await;
        assert!(matches!(socket_rx.recv().await, Some(Message::Text(_))));
        drop(outbound_tx);
        task.await.expect("bridge should exit cleanly");
    }

    #[tokio::test]
    async fn retry_close_bypasses_queued_socket_messages() {
        let (socket_tx, socket_rx) = mpsc::channel(2);
        socket_tx
            .send(Message::Text("stale event".into()))
            .await
            .expect("queue normal message");
        let (close_tx, close_rx) = mpsc::channel(1);
        close_tx
            .send(retryable_close("overloaded"))
            .await
            .expect("queue priority close");

        let recorded = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded_for_sink = recorded.clone();
        let sink = Box::pin(futures::sink::unfold((), move |(), message| {
            let recorded = recorded_for_sink.clone();
            async move {
                recorded
                    .lock()
                    .expect("recording sink poisoned")
                    .push(message);
                Ok::<_, std::convert::Infallible>(())
            }
        }));

        run_socket_sender(sink, socket_rx, close_rx).await;

        let messages = recorded.lock().expect("recording sink poisoned");
        assert_eq!(messages.len(), 1);
        assert!(matches!(
            messages.first(),
            Some(Message::Close(Some(frame))) if frame.code == 1013 && frame.reason == "overloaded"
        ));
    }
}
