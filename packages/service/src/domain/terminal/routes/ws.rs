//! `/api/terminal/ws`: authenticate, then attach to an existing PTY or create
//! one, and hand the socket to the PTY bridge.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use futures::SinkExt;
use futures::StreamExt;
use serde::Deserialize;
use tracing::{error, info};

use super::bridge::{run_pty_ws_loop, WsSink};
use crate::api::middleware::authenticate_ws;
use crate::app_state::AppState;
use crate::domain::terminal::cwd::resolve_pty_cwd;
use crate::domain::terminal::protocol::ServerMessage;
use crate::domain::terminal::service::PtyManager;
use crate::remote::RemoteContext;
use crate::shared::discard::IgnoreClosed;

#[derive(Debug, Deserialize)]
pub(super) struct TerminalWsParams {
    feature_id: Option<i64>,
    project_id: Option<i64>,
    pty_id: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    /// See [`crate::domain::terminal::cwd::resolve_pty_cwd`] for semantics.
    cwd: Option<String>,
}

pub(super) async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<TerminalWsParams>,
    State(state): State<AppState>,
    headers: HeaderMap,
    // Present only on the remote listener; its absence means loopback.
    remote: Option<Extension<RemoteContext>>,
) -> Response {
    let (selected_proto, device_id) =
        match authenticate_ws(&headers, &state, remote.as_ref().map(|e| &e.0)).await {
            Ok(resolved) => resolved,
            Err(resp) => return resp,
        };
    let ws = ws.protocols(selected_proto);
    match device_id {
        Some(device_id) => ws
            .on_upgrade(move |socket| handle_remote_terminal_ws(socket, params, state, device_id))
            .into_response(),
        None => ws
            .on_upgrade(move |socket| handle_terminal_ws(socket, params, state))
            .into_response(),
    }
}

/// Remote terminal connection wrapped so a device revoke force-closes it. The
/// `/ws` handler records the `connect` audit; terminals only register for
/// force-close to avoid double-counting sessions.
async fn handle_remote_terminal_ws(
    socket: WebSocket,
    params: TerminalWsParams,
    state: AppState,
    device_id: i64,
) {
    // A terminal socket is a secondary connection for an already-paired device;
    // the "connected" event fires for the main WS only, so ignore the flag here.
    let (guard, _) = state.remote.live().register(device_id);
    tokio::select! {
        _ = handle_terminal_ws(socket, params, state) => {}
        _ = guard.token.cancelled() => {
            info!(device_id, "remote terminal force-closed (device revoked)");
        }
    }
}

async fn handle_terminal_ws(socket: WebSocket, params: TerminalWsParams, state: AppState) {
    let pty_manager = &state.pty_manager;

    if let (Some(pty_id), Some(feature_id)) = (params.pty_id.as_deref(), params.feature_id) {
        handle_reconnect(socket, pty_id, feature_id, pty_manager).await;
    } else if params.pty_id.is_some() {
        send_error(socket, "Missing required feature_id for PTY reconnection").await;
    } else if let (Some(feature_id), Some(project_id)) = (params.feature_id, params.project_id) {
        let cols = params.cols.unwrap_or(80);
        let rows = params.rows.unwrap_or(24);
        handle_new_pty(
            socket,
            feature_id,
            project_id,
            cols,
            rows,
            params.cwd.as_deref(),
            &state,
        )
        .await;
    } else {
        send_error(
            socket,
            "Missing required params: pty_id or (feature_id + project_id)",
        )
        .await;
    }
}

async fn handle_reconnect(
    socket: WebSocket,
    pty_id: &str,
    feature_id: i64,
    pty_manager: &PtyManager,
) {
    match pty_manager.reconnect_for_feature(pty_id, feature_id) {
        Some(reconnect) => {
            let (mut ws_sink, ws_stream) = socket.split();
            let msg = ServerMessage::Reconnected {
                scrollback: reconnect.scrollback,
                alive: reconnect.alive,
                cwd: Some(reconnect.cwd),
            };
            if send_msg(&mut ws_sink, &msg).await.is_err() {
                return;
            }

            if reconnect.alive {
                run_pty_ws_loop(
                    ws_sink,
                    ws_stream,
                    pty_id.to_string(),
                    reconnect.handle,
                    pty_manager.clone(),
                    reconnect.data_rx,
                )
                .await;
            }
            // If not alive, WS stays open briefly for client to read scrollback, then closes
        }
        None => {
            send_error(socket, "PTY not found for feature").await;
        }
    }
}

async fn handle_new_pty(
    socket: WebSocket,
    feature_id: i64,
    project_id: i64,
    cols: u16,
    rows: u16,
    requested_cwd: Option<&str>,
    state: &AppState,
) {
    let cwd = match resolve_pty_cwd(&state.read_pool, feature_id, project_id, requested_cwd).await {
        Ok(cwd) => cwd,
        Err(e) => {
            send_error(socket, &format!("Failed to resolve CWD: {e}")).await;
            return;
        }
    };

    let pty_manager = state.pty_manager.clone();
    let spawn_cwd = cwd.clone();
    let (pty_id, handle) = match tokio::task::spawn_blocking(move || {
        pty_manager.create_pty(feature_id, &spawn_cwd, cols, rows)
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => {
            send_error(socket, &format!("Failed to create PTY: {e}")).await;
            return;
        }
        Err(e) => {
            send_error(socket, &format!("Failed to create PTY: {e}")).await;
            return;
        }
    };

    info!(pty_id = %pty_id, cwd = %cwd, "Created new PTY");

    let (scrollback, data_rx) = handle.subscribe_with_scrollback();
    let (mut ws_sink, ws_stream) = socket.split();
    let ready_msg = ServerMessage::Ready {
        pty_id: pty_id.clone(),
        cwd: cwd.clone(),
    };
    if send_msg(&mut ws_sink, &ready_msg).await.is_err() {
        return;
    }
    if !scrollback.is_empty()
        && send_msg(&mut ws_sink, &ServerMessage::Data { data: scrollback })
            .await
            .is_err()
    {
        return;
    }

    run_pty_ws_loop(
        ws_sink,
        ws_stream,
        pty_id,
        handle,
        state.pty_manager.clone(),
        data_rx,
    )
    .await;
}

async fn send_msg(sink: &mut WsSink, msg: &ServerMessage) -> Result<(), ()> {
    sink.send(Message::Text(msg.to_json().into()))
        .await
        .map_err(|e| {
            error!("Failed to send WebSocket message: {e}");
        })
}

async fn send_error(socket: WebSocket, message: &str) {
    let (mut sink, _) = socket.split();
    let msg = ServerMessage::Error {
        message: message.to_string(),
    };
    // The socket closes right after: a peer already gone has nothing to show.
    let frame = Message::Text(msg.to_json().into());
    sink.send(frame).await.ignore_closed();
}
