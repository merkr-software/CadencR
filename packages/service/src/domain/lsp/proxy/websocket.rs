//! The sink stays owned by the proxy so its close reply survives worker teardown.
use std::time::Duration;

use axum::extract::ws::Message;
use futures::{Sink, SinkExt};
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// Outbound channel → WS sink, borrowed until another proxy direction finishes.
pub(super) async fn ws_sender<S>(mut sink: S, mut rx: mpsc::UnboundedReceiver<Message>)
where
    S: SinkExt<Message> + Unpin,
{
    while let Some(msg) = rx.recv().await {
        if sink.send(msg).await.is_err() {
            return;
        }
    }
}

pub(super) async fn close<S>(sink: &mut S, display_name: &str)
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    // Reading Close queues the peer's reply inside tungstenite; drive it before drop.
    // A stalled or already disconnected peer must not keep the LSP child alive.
    let close = async {
        if let Err(error) = sink.close().await {
            // SplitSink may reject a pending text frame after receiving Close. That
            // consumes the frame; retry so the queued close reply can still flush.
            debug!(%error, "lsp {display_name} retrying WebSocket close after initial failure");
            sink.close().await
        } else {
            Ok(())
        }
    };
    match tokio::time::timeout(Duration::from_secs(1), close).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => debug!(%error, "lsp {display_name} socket unavailable during close"),
        Err(error) => warn!(%error, "lsp {display_name} WebSocket close timed out"),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::process::Stdio;
    use std::sync::Arc;

    use axum::{extract::WebSocketUpgrade, routing::get, Router};
    use futures::{SinkExt, StreamExt};
    use tokio::process::Command;
    use tokio::sync::{mpsc, Mutex};
    use tokio::time::{timeout, Duration};
    use tokio_tungstenite::tungstenite::{protocol::CloseFrame, Message};

    use super::super::{run_proxy, CrashKey, CrashTracker};

    async fn exercise_close(code: Option<u16>) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let key = CrashKey {
            workspace_root: root,
            language_id: "proxy-close-regression".into(),
        };
        let tracker = CrashTracker::new();
        tracker.record_crash(key.clone()).await;
        let child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap() as libc::pid_t;
        let child = Arc::new(Mutex::new(Some(child)));
        let (finished, mut completion) = mpsc::unbounded_channel();
        let handler_tracker = tracker.clone();
        let handler_key = key.clone();
        let app = Router::new().route(
            "/",
            get(move |upgrade: WebSocketUpgrade| {
                let child = child.clone();
                let tracker = handler_tracker.clone();
                let key = handler_key.clone();
                let finished = finished.clone();
                async move {
                    let child = child.lock().await.take().unwrap();
                    upgrade.on_upgrade(move |socket| async move {
                        run_proxy()
                            .ws(socket)
                            .child(child)
                            .display_name("close-regression")
                            .crash_tracker(tracker)
                            .crash_key(key)
                            .call()
                            .await;
                        finished.send(()).unwrap();
                    })
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
            .await
            .unwrap();
        let text = r#"{"jsonrpc":"2.0","id":1,"result":null}"#;
        client.send(Message::Text(text.into())).await.unwrap();
        let echo = timeout(Duration::from_secs(2), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(echo.into_text().unwrap(), text);
        if let Some(code) = code {
            client
                .send(Message::Close(Some(CloseFrame {
                    code: code.into(),
                    reason: "peer-complete".into(),
                })))
                .await
                .unwrap();
            let reply = timeout(Duration::from_secs(2), client.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let Message::Close(Some(reply)) = reply else {
                panic!("missing close reply: {reply:?}")
            };
            assert_eq!(u16::from(reply.code), code);
            assert_eq!(reply.reason, "peer-complete");
            assert!(timeout(Duration::from_secs(2), client.next())
                .await
                .unwrap()
                .is_none());
        }
        drop(client);
        timeout(Duration::from_secs(2), completion.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tracker.check(&key).await.is_ok(), code == Some(1000));
        // SAFETY: signal 0 only checks this test's child PID; no signal is delivered.
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "proxy child still exists"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn pending_outbound_frame_does_not_prevent_normal_close_acknowledgement() {
        let (finished, mut completion) = mpsc::unbounded_channel();
        let app = Router::new().route(
            "/",
            get(move |upgrade: WebSocketUpgrade| {
                let finished = finished.clone();
                async move {
                    upgrade.on_upgrade(move |socket| async move {
                        let (mut sink, mut stream) = socket.split();
                        // Feed leaves the text in SplitSink's slot without flushing.
                        sink.feed(axum::extract::ws::Message::Text("pending".into()))
                            .await
                            .unwrap();
                        assert!(matches!(
                            stream.next().await.unwrap().unwrap(),
                            axum::extract::ws::Message::Close(Some(frame)) if frame.code == 1000
                        ));
                        super::close(&mut sink, "pending-close-regression").await;
                        finished.send(()).unwrap();
                    })
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
            .await
            .unwrap();
        client
            .send(Message::Close(Some(CloseFrame {
                code: 1000.into(),
                reason: "pending-complete".into(),
            })))
            .await
            .unwrap();
        let reply = timeout(Duration::from_secs(2), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Close(Some(reply)) = reply else {
            panic!("missing close reply: {reply:?}")
        };
        assert_eq!(u16::from(reply.code), 1000);
        assert_eq!(reply.reason, "pending-complete");
        assert!(timeout(Duration::from_secs(2), client.next())
            .await
            .unwrap()
            .is_none());
        timeout(Duration::from_secs(2), completion.recv())
            .await
            .unwrap()
            .unwrap();
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn normal_peer_close_is_acknowledged_and_reaps_child_without_backoff() {
        exercise_close(Some(1000)).await;
    }

    #[tokio::test]
    async fn abnormal_peer_close_is_acknowledged_and_preserves_backoff() {
        exercise_close(Some(1008)).await;
    }

    #[tokio::test]
    async fn abrupt_disconnect_reaps_child_and_preserves_backoff() {
        exercise_close(None).await;
    }
}
