//! Cancellation-safe outbound frames, retained until accepted by the WebSocket sink.
use std::pin::Pin;

use axum::extract::ws::Message;
use futures::{Sink, SinkExt};
use tokio::sync::mpsc;

/// Outbound channel → WS sink, borrowed until another proxy direction finishes.
pub(super) async fn ws_sender<S>(
    sink: &mut S,
    rx: &mut mpsc::UnboundedReceiver<Message>,
    pending: &mut Option<Message>,
) where
    S: Sink<Message> + Unpin,
{
    loop {
        if pending.is_none() {
            *pending = rx.recv().await;
        }
        if pending.is_none() {
            return;
        }
        // Keep the frame outside this future until the sink accepts it, so
        // cancelling the pump at stdout EOF cannot discard its last response.
        if futures::future::poll_fn(|cx| Pin::new(&mut *sink).poll_ready(cx))
            .await
            .is_err()
        {
            return;
        }
        if Pin::new(&mut *sink)
            .start_send(pending.take().unwrap())
            .is_err()
            || sink.flush().await.is_err()
        {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        task::{Context, Poll},
    };

    use super::*;

    #[derive(Default)]
    struct Backpressure {
        ready_blocked: bool,
        flush_blocked: bool,
        sent: Vec<Message>,
    }

    impl Sink<Message> for Backpressure {
        type Error = Infallible;

        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            if self.ready_blocked {
                Poll::Pending
            } else {
                Poll::Ready(Ok(()))
            }
        }

        fn start_send(mut self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.sent.push(item);
            Ok(())
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            if self.flush_blocked {
                Poll::Pending
            } else {
                Poll::Ready(Ok(()))
            }
        }

        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn cancelling_during_readiness_or_flush_preserves_order_without_duplicates() {
        for during_flush in [false, true] {
            let mut sink = Backpressure {
                ready_blocked: !during_flush,
                flush_blocked: during_flush,
                ..Default::default()
            };
            let (sender, mut receiver) = mpsc::unbounded_channel();
            sender.send(Message::Text("first".into())).unwrap();
            sender.send(Message::Text("last".into())).unwrap();
            drop(sender);
            let mut pending = None;
            let mut pump = Box::pin(ws_sender(&mut sink, &mut receiver, &mut pending));
            assert!(futures::poll!(pump.as_mut()).is_pending());
            drop(pump);
            assert_eq!(pending.is_none(), during_flush);
            assert_eq!(sink.sent.len(), usize::from(during_flush));
            sink.ready_blocked = false;
            sink.flush_blocked = false;
            ws_sender(&mut sink, &mut receiver, &mut pending).await;
            let frames: Vec<_> = sink
                .sent
                .into_iter()
                .map(|m| m.into_text().unwrap())
                .collect();
            assert_eq!(frames, ["first", "last"]);
            assert!(pending.is_none());
        }
    }
}
