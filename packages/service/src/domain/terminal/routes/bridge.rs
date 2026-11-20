//! Bridges one PTY and one terminal WebSocket: PTY output to the socket,
//! client writes/resizes/kills to the PTY, and the exit notice.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures::SinkExt;
use futures::StreamExt;
use tokio::sync::broadcast;
use tracing::{error, info};

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

/// Spawn task that reads WebSocket messages and dispatches writes/resizes/kills to the PTY.
fn spawn_ws_to_pty_writer(
    mut ws_stream: WsStream,
    pty_id: String,
    pty_manager: PtyManager,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_stream.next().await {
            match msg {
                Message::Text(text) => {
                    let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) else {
                        continue;
                    };
                    match client_msg {
                        ClientMessage::Write { data } => {
                            if let Err(e) = pty_manager.write_pty(&pty_id, data.as_bytes()) {
                                error!(pty_id = %pty_id, error = %e, "Write failed");
                            }
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
                Message::Close(_) => break,
                _ => {}
            }
        }
    })
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
    let mut write_task = spawn_ws_to_pty_writer(ws_stream, pty_id.clone(), pty_manager);
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
    use super::SocketTasks;

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
}
