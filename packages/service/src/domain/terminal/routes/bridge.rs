//! Bridges one PTY and one terminal WebSocket: PTY output to the socket,
//! client writes/resizes/kills to the PTY, and the exit notice.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures::{Sink, SinkExt, Stream, StreamExt};
use tokio::sync::broadcast;
use tracing::{error, info};

use crate::domain::terminal::input::InputPump;
use crate::domain::terminal::protocol::{ClientMessage, ServerMessage};
use crate::domain::terminal::service::{PtyHandle, PtyManager};
use crate::shared::discard::IgnoreClosed;

pub(super) type WsSink = futures::stream::SplitSink<WebSocket, Message>;
type WsStream = futures::stream::SplitStream<WebSocket>;

/// Spawn task that forwards PTY broadcast data to the WebSocket sink.
fn spawn_pty_to_ws_forwarder(
    sink: Arc<tokio::sync::Mutex<WsSink>>,
    mut data_rx: broadcast::Receiver<String>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match data_rx.recv().await {
                Ok(data) => {
                    let msg = ServerMessage::Data { data };
                    let json = msg.to_json();
                    if sink
                        .lock()
                        .await
                        .send(Message::Text(json.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let message = ServerMessage::Error {
                        message: "Terminal output fell behind; reconnect to restore the display"
                            .to_string(),
                    };
                    sink.lock()
                        .await
                        .send(Message::Text(message.to_json().into()))
                        .await
                        .ignore_closed();
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

/// Spawn task that reads WebSocket messages and dispatches writes/resizes/kills
/// to the PTY.
fn spawn_ws_to_pty_writer(
    ws_stream: WsStream,
    pty_id: String,
    pty_manager: PtyManager,
    sink: Arc<tokio::sync::Mutex<WsSink>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(pump_client_messages(ws_stream, pty_id, pty_manager, sink))
}

/// Read client messages until the socket closes. Writes go to an
/// [`InputPump`] and are never awaited here: a paste stuck on a child that
/// does not read stdin must not hold back the kill or resize behind it.
async fn pump_client_messages<St, Si>(
    mut stream: St,
    pty_id: String,
    pty_manager: PtyManager,
    sink: Arc<tokio::sync::Mutex<Si>>,
) where
    St: Stream<Item = Result<Message, axum::Error>> + Unpin,
    Si: Sink<Message, Error = axum::Error> + Unpin + Send + 'static,
{
    let mut input = InputPump::for_pty(&pty_manager, &pty_id);
    loop {
        let incoming = tokio::select! {
            result = input.next_result() => {
                report_input_result(&sink, &pty_id, result);
                continue;
            }
            incoming = stream.next() => incoming,
        };
        let text = match incoming {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            Some(Ok(_)) => continue,
        };
        let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) else {
            continue;
        };
        match client_msg {
            ClientMessage::Write { data } => {
                let queued = input.push(data.into_bytes());
                report_input_result(&sink, &pty_id, queued);
            }
            ClientMessage::Resize { cols, rows } => {
                if let Err(e) = pty_manager.resize_pty(&pty_id, cols, rows) {
                    error!(pty_id = %pty_id, error = %e, "Resize failed");
                }
            }
            ClientMessage::Kill => {
                if let Err(e) = pty_manager.kill_pty(&pty_id) {
                    error!(pty_id = %pty_id, error = %e, "Kill failed");
                }
            }
        }
    }
    input.finish_detached(pty_id);
}

/// Tell the client its input did not reach the PTY instead of dropping it.
/// Sent from its own task: the output forwarder may hold the sink while a
/// slow client drains, and the read loop must keep reading meanwhile.
fn report_input_result<Si>(
    sink: &Arc<tokio::sync::Mutex<Si>>,
    pty_id: &str,
    result: anyhow::Result<()>,
) where
    Si: Sink<Message, Error = axum::Error> + Unpin + Send + 'static,
{
    let Err(error) = result else {
        return;
    };
    let message = format!("{error:#}");
    error!(pty_id = %pty_id, error = %message, "Terminal input failed");
    let frame = Message::Text(ServerMessage::InputError { message }.to_json().into());
    let sink = Arc::clone(sink);
    tokio::spawn(async move {
        sink.lock().await.send(frame).await.ignore_closed();
    });
}

/// Spawn task that sends an Exit message to the WebSocket when the PTY process ends.
fn spawn_exit_watcher(
    sink: Arc<tokio::sync::Mutex<WsSink>>,
    pty_id: String,
    handle: Arc<PtyHandle>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut alive_rx = handle.alive.subscribe();
        loop {
            if alive_rx.borrow_and_update().is_some() {
                break;
            }
            if alive_rx.changed().await.is_err() {
                break;
            }
        }
        let exit_code = alive_rx.borrow().unwrap_or(-1);
        let msg = ServerMessage::Exit { code: exit_code };
        let json = msg.to_json();
        let frame = Message::Text(json.into());
        sink.lock().await.send(frame).await.ignore_closed();
        info!(pty_id = %pty_id, "Sent exit message");
    })
}

/// Orchestrate PTY ↔ WebSocket bridging using the PTY's persistent broadcast channel.
pub(super) async fn run_pty_ws_loop(
    ws_sink: WsSink,
    ws_stream: WsStream,
    pty_id: String,
    handle: Arc<PtyHandle>,
    pty_manager: PtyManager,
    data_rx: broadcast::Receiver<String>,
) {
    let sink = Arc::new(tokio::sync::Mutex::new(ws_sink));

    let mut forward_task = spawn_pty_to_ws_forwarder(Arc::clone(&sink), data_rx);
    let mut write_task =
        spawn_ws_to_pty_writer(ws_stream, pty_id.clone(), pty_manager, Arc::clone(&sink));
    let mut exit_task = spawn_exit_watcher(Arc::clone(&sink), pty_id.clone(), Arc::clone(&handle));
    let tasks = SocketTasks([
        forward_task.abort_handle(),
        write_task.abort_handle(),
        exit_task.abort_handle(),
    ]);

    tokio::select! {
        _ = &mut write_task => {
            info!(pty_id = %pty_id, "WebSocket closed, PTY kept alive");
        }
        _ = &mut forward_task => {
            info!(pty_id = %pty_id, "PTY broadcast channel closed");
        }
        _ = &mut exit_task => {
            info!(pty_id = %pty_id, "PTY exited");
        }
    }

    drop(tasks);

    let close = Message::Close(None);
    sink.lock().await.send(close).await.ignore_closed();
}

/// Dropping a revoked remote connection must stop its independently spawned
/// reader/writer tasks too; dropping JoinHandle alone would detach them.
struct SocketTasks([tokio::task::AbortHandle; 3]);

impl Drop for SocketTasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn revoked_connection_cancels_all_bridge_tasks() {
        let forward = tokio::spawn(std::future::pending::<()>());
        let write = tokio::spawn(std::future::pending::<()>());
        let exit = tokio::spawn(std::future::pending::<()>());
        drop(SocketTasks([
            forward.abort_handle(),
            write.abort_handle(),
            exit.abort_handle(),
        ]));
        assert!(forward.await.unwrap_err().is_cancelled());
        assert!(write.await.unwrap_err().is_cancelled());
        assert!(exit.await.unwrap_err().is_cancelled());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_and_resize_are_applied_while_input_is_stuck() {
        use crate::domain::terminal::service::PtyKind;
        use crate::domain::terminal::test_support::{spawn_stuck_child, wait_for_size};
        use std::time::Duration;

        let manager = PtyManager::new();
        let (pty_id, handle) = spawn_stuck_child(&manager, PtyKind::Terminal).await;
        let (client_tx, client_rx) = futures::channel::mpsc::unbounded::<Message>();
        let (server_tx, mut server_rx) = futures::channel::mpsc::unbounded::<Message>();
        let sink = Arc::new(tokio::sync::Mutex::new(
            server_tx.sink_map_err(axum::Error::new),
        ));
        let pump = tokio::spawn(pump_client_messages(
            client_rx.map(Ok),
            pty_id.clone(),
            manager.clone(),
            sink,
        ));
        let send = |json: serde_json::Value| {
            client_tx
                .unbounded_send(Message::Text(json.to_string().into()))
                .unwrap()
        };

        // A paste the child never reads, then a keystroke queued behind it.
        send(serde_json::json!({"type": "write", "data": "y".repeat(3 * 1024 * 1024)}));
        send(serde_json::json!({"type": "write", "data": "\u{3}"}));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            handle.alive.borrow().is_none(),
            "the child is still running"
        );
        assert!(
            server_rx.try_recv().is_err(),
            "the input is pending, not failed"
        );

        send(serde_json::json!({"type": "resize", "cols": 101, "rows": 33}));
        assert!(
            wait_for_size(&handle, 101, 33).await,
            "resize stuck behind pending input"
        );

        send(serde_json::json!({"type": "kill"}));
        let mut alive = handle.alive.subscribe();
        tokio::time::timeout(Duration::from_secs(5), alive.wait_for(Option::is_some))
            .await
            .expect("kill stuck behind pending input")
            .unwrap();

        // The stuck input is reported once (keystroke included), not dropped.
        let reported = tokio::time::timeout(Duration::from_secs(5), server_rx.next())
            .await
            .expect("pending input reported after the kill")
            .unwrap();
        let Message::Text(text) = reported else {
            panic!("unexpected frame: {reported:?}");
        };
        assert!(text.contains("input_error"), "{text}");
        assert!(text.contains("1 later write(s) discarded"), "{text}");

        drop(client_tx);
        tokio::time::timeout(Duration::from_secs(5), pump)
            .await
            .expect("the loop ends with the socket")
            .unwrap();
        manager.kill_all();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_keystroke_sent_right_before_close_still_reaches_the_shell() {
        use crate::domain::terminal::service::PtyKind;
        use std::time::Duration;

        let manager = PtyManager::new();
        let mut cmd = portable_pty::CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "stty raw -echo; printf 'READY\\n'; exec cat"]);
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let (pty_id, handle) = manager
            .create_pty_with_command(9, cmd, &cwd, 80, 24, PtyKind::Terminal)
            .unwrap();
        let (_, mut output) = handle.subscribe_with_scrollback();

        // The write and the close are already buffered when the loop starts.
        let frames = vec![
            Ok(Message::Text(
                serde_json::json!({"type": "write", "data": "typed-before-close"})
                    .to_string()
                    .into(),
            )),
            Ok(Message::Close(None)),
        ];
        let (server_tx, _server_rx) = futures::channel::mpsc::unbounded::<Message>();
        let sink = Arc::new(tokio::sync::Mutex::new(
            server_tx.sink_map_err(axum::Error::new),
        ));
        pump_client_messages(futures::stream::iter(frames), pty_id, manager.clone(), sink).await;

        let mut seen = String::new();
        let delivered = tokio::time::timeout(Duration::from_secs(5), async {
            while !seen.contains("typed-before-close") {
                seen.push_str(&output.recv().await.unwrap());
            }
        })
        .await;
        manager.kill_all();
        assert!(delivered.is_ok(), "input lost at close: {seen:?}");
    }
}
