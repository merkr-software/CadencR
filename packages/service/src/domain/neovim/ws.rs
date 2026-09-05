//! Dedicated WebSocket transport for a feature's Neovim PTY.
//!
//! Deliberately not routed through `ws_session`'s `WsEnvelope`: this carries a
//! continuous stream of raw terminal bytes, which does not fit that JSON
//! envelope. `/api/terminal/ws` sets the same precedent for the same reason.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::info;

use crate::api::middleware::authenticate_ws;
use crate::app_state::AppState;
use crate::remote::RemoteContext;

/// Client → server messages over the Neovim PTY socket.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Raw bytes to feed Neovim's stdin, already encoded by the client's
    /// terminal emulator (escape sequences included).
    Write {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Stop streaming to this client. The Neovim process keeps running.
    Detach,
}

/// Server → client messages over the Neovim PTY socket.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Raw terminal output from Neovim.
    Data {
        data: String,
    },
    /// Sent once on attach, carrying the PTY's buffered output so a
    /// reattaching client can redraw without waiting for Neovim to repaint.
    Attached {
        scrollback: String,
    },
    Error {
        message: String,
    },
}

impl ServerMessage {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("ServerMessage serialization should not fail")
    }
}

#[derive(Debug, Deserialize)]
pub struct NeovimWsQuery {
    pub feature_id: i64,
}

/// GET /api/neovim/ws?feature_id=<id> — upgrade to a Neovim PTY stream.
///
/// Authenticated exactly like `/api/terminal/ws`: browsers cannot set headers
/// on a WebSocket, so the token travels as the `cadencr-token.<token>`
/// subprotocol. The matched subprotocol MUST be echoed via
/// `WebSocketUpgrade::protocols` — a 101 without it makes the browser fail the
/// handshake ("Server did not respond with sent protocols") and reconnect
/// forever.
pub async fn neovim_ws_handler(
    ws: WebSocketUpgrade,
    State(app_state): State<AppState>,
    Query(query): Query<NeovimWsQuery>,
    headers: HeaderMap,
    // Present only on the remote listener; its absence means loopback.
    remote: Option<Extension<RemoteContext>>,
) -> Response {
    let (selected_proto, device_id) =
        match authenticate_ws(&headers, &app_state, remote.as_ref().map(|e| &e.0)).await {
            Ok(resolved) => resolved,
            Err(response) => return response,
        };
    ws.protocols([selected_proto])
        .on_upgrade(move |socket| async move {
            if let Some(device_id) = device_id {
                let (guard, _) = app_state.remote.live().register(device_id);
                tokio::select! {
                    _ = handle_socket(socket, app_state, query.feature_id) => {}
                    _ = guard.token.cancelled() => {
                        info!(device_id, "remote neovim force-closed (device revoked)");
                    }
                }
            } else {
                handle_socket(socket, app_state, query.feature_id).await;
            }
        })
        .into_response()
}

type WsSink = futures::stream::SplitSink<WebSocket, Message>;
type WsStream = futures::stream::SplitStream<WebSocket>;

struct AttachedPty {
    id: String,
    handle: std::sync::Arc<crate::domain::terminal::service::PtyHandle>,
    data: broadcast::Receiver<String>,
}

async fn send_error(sink: &mut WsSink, message: impl Into<String>) {
    let _ = sink
        .send(Message::Text(
            ServerMessage::Error {
                message: message.into(),
            }
            .to_json()
            .into(),
        ))
        .await;
}

async fn attach_pty(
    app_state: &AppState,
    feature_id: i64,
) -> Result<(AttachedPty, String), String> {
    app_state
        .neovim_manager
        .ensure_started(feature_id)
        .await
        .map_err(|error| error.to_string())?;
    let id = app_state
        .neovim_manager
        .pty_id(feature_id)
        .await
        .ok_or_else(|| format!("no neovim process running for feature {feature_id}"))?;
    let handle = app_state
        .pty_manager
        .terminals
        .get(&id)
        .map(|entry| entry.value().clone())
        .ok_or_else(|| format!("neovim pty {id} is gone"))?;
    let (scrollback, data) = handle.subscribe_with_scrollback();
    Ok((AttachedPty { id, handle, data }, scrollback))
}

async fn handle_socket(socket: WebSocket, app_state: AppState, feature_id: i64) {
    let (mut sink, stream) = socket.split();
    let (pty, scrollback) = match attach_pty(&app_state, feature_id).await {
        Ok(pty) => pty,
        Err(error) => {
            send_error(&mut sink, error).await;
            return;
        }
    };
    if sink
        .send(Message::Text(
            ServerMessage::Attached { scrollback }.to_json().into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    stream_pty(sink, stream, pty, &app_state.pty_manager).await;
    info!(feature_id, "neovim ws client detached");
}

async fn stream_pty(
    mut sink: WsSink,
    mut stream: WsStream,
    mut pty: AttachedPty,
    manager: &crate::domain::terminal::service::PtyManager,
) {
    let mut alive = pty.handle.alive.subscribe();
    loop {
        if alive.borrow_and_update().is_some() {
            send_error(&mut sink, "Neovim exited").await;
            break;
        }
        tokio::select! {
            data = pty.data.recv() => match data {
                Ok(data) => {
                    if sink.send(Message::Text(ServerMessage::Data { data }.to_json().into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // ANSI output contains deltas, not independently repaintable frames.
                    send_error(&mut sink, "Neovim output fell behind; reconnect to restore the display").await;
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            changed = alive.changed() => {
                if changed.is_err() { break; }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        match handle_input(&text, &pty.id, manager) {
                            Ok(true) => {}
                            Ok(false) => break,
                            Err(error) => { send_error(&mut sink, error).await; break; }
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => break,
                }
            }
        }
    }
}

fn handle_input(
    text: &str,
    pty_id: &str,
    manager: &crate::domain::terminal::service::PtyManager,
) -> Result<bool, String> {
    let message = serde_json::from_str::<ClientMessage>(text).map_err(|error| error.to_string())?;
    let result = match message {
        ClientMessage::Write { data } => manager.write_pty(pty_id, data.as_bytes()),
        ClientMessage::Resize { cols, rows } => manager.resize_pty(pty_id, cols, rows),
        ClientMessage::Detach => return Ok(false),
    };
    result.map(|()| true).map_err(|error| error.to_string())
}

/// Register the Neovim websocket route.
pub fn ws_routes() -> Router<AppState> {
    Router::new().route("/api/neovim/ws", get(neovim_ws_handler))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_message_parses_write_resize_and_detach() {
        let write: ClientMessage =
            serde_json::from_str(r#"{"type":"write","data":"ihello"}"#).unwrap();
        assert!(matches!(write, ClientMessage::Write { data } if data == "ihello"));

        let resize: ClientMessage =
            serde_json::from_str(r#"{"type":"resize","cols":120,"rows":40}"#).unwrap();
        assert!(matches!(
            resize,
            ClientMessage::Resize {
                cols: 120,
                rows: 40
            }
        ));

        let detach: ClientMessage = serde_json::from_str(r#"{"type":"detach"}"#).unwrap();
        assert!(matches!(detach, ClientMessage::Detach));
    }

    #[test]
    fn server_message_serializes_with_a_type_tag() {
        let data = ServerMessage::Data {
            data: "hello".to_string(),
        };
        assert_eq!(data.to_json(), r#"{"type":"data","data":"hello"}"#);

        let attached = ServerMessage::Attached {
            scrollback: "hello".to_string(),
        };
        assert_eq!(
            attached.to_json(),
            r#"{"type":"attached","scrollback":"hello"}"#
        );

        let error = ServerMessage::Error {
            message: "no neovim running for this feature".to_string(),
        };
        assert_eq!(
            error.to_json(),
            r#"{"type":"error","message":"no neovim running for this feature"}"#
        );
    }
}
