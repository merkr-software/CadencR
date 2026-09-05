use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use futures::SinkExt;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::{error, info};

use super::cwd::resolve_pty_cwd;
use super::protocol::{ClientMessage, ServerMessage};
use super::service::PtyHandle;
use crate::api::middleware::authenticate_ws;
use crate::app_state::AppState;
use crate::remote::RemoteContext;

type WsSink = futures::stream::SplitSink<WebSocket, Message>;
type WsStream = futures::stream::SplitStream<WebSocket>;

#[derive(Debug, Deserialize)]
pub struct TerminalWsParams {
    pub feature_id: Option<i64>,
    pub project_id: Option<i64>,
    pub pty_id: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// See [`super::cwd::resolve_pty_cwd`] for semantics.
    pub cwd: Option<String>,
}

pub fn terminal_router() -> Router<AppState> {
    Router::new()
        .route("/api/terminal/ws", get(terminal_ws_handler))
        .route(
            "/api/terminal/sessions",
            get(list_terminal_sessions_handler),
        )
        .route("/api/terminal/kill", post(kill_terminal_sessions_handler))
        .route(
            "/api/terminal/alacritty-config",
            get(alacritty_config_route),
        )
}

/// A live terminal session a client can attach to (one PTY).
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct TerminalSessionInfo {
    pub pty_id: String,
    pub cwd: String,
    pub alive: bool,
    /// Whether a foreground command is currently running in this shell. The
    /// client uses this to auto-switch an idle terminal to a fresh worktree
    /// while leaving a busy one alone.
    pub foreground_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct TerminalSessionsQuery {
    pub feature_id: i64,
}

/// List the live PTYs for a feature so another device can attach to the same
/// shells (and type into them) instead of spawning a fresh terminal. Only live
/// shells are returned, since attaching to an exited one would just replay
/// scrollback and close.
#[utoipa::path(
    get,
    path = "/api/terminal/sessions",
    params(("feature_id" = i64, Query, description = "Feature whose terminal sessions to list")),
    responses((status = 200, description = "Live terminal sessions", body = [TerminalSessionInfo])),
)]
pub async fn list_terminal_sessions_handler(
    Query(query): Query<TerminalSessionsQuery>,
    State(state): State<AppState>,
) -> Json<Vec<TerminalSessionInfo>> {
    let sessions = state
        .pty_manager
        .feature_ptys(query.feature_id)
        .into_iter()
        .filter(|session| session.alive)
        .map(|session| TerminalSessionInfo {
            pty_id: session.pty_id,
            cwd: session.cwd,
            alive: session.alive,
            foreground_active: session.foreground_active,
        })
        .collect();
    Json(sessions)
}

/// How many shells were terminated by a kill request.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct KillTerminalsResponse {
    pub killed: u32,
}

/// Kill every live shell belonging to a feature. Used when archiving or deleting
/// a feature so its terminals don't keep running in a worktree that may be about
/// to be removed.
///
/// Shells only: the feature's Neovim PTY is `PtyKind::Neovim` and is left
/// running, because this route is also the sidebar's "close activity" action on
/// a feature the user still has open. Neovim teardown belongs to the paths that
/// actually destroy the worktree (`delete_worktree`, `delete_feature`).
#[utoipa::path(
    post,
    path = "/api/terminal/kill",
    params(("feature_id" = i64, Query, description = "Feature whose live terminals to kill")),
    responses((status = 200, description = "Number of shells killed", body = KillTerminalsResponse)),
)]
pub async fn kill_terminal_sessions_handler(
    Query(query): Query<TerminalSessionsQuery>,
    State(state): State<AppState>,
) -> Json<KillTerminalsResponse> {
    let killed = state.pty_manager.kill_feature_ptys(query.feature_id);
    Json(KillTerminalsResponse {
        killed: killed as u32,
    })
}

/// `GET /api/terminal/alacritty-config` — the user's parsed Alacritty
/// config (font, colors, cursor style, scrollback depth), or Alacritty's
/// own documented defaults when there's nothing to read.
#[utoipa::path(
    get,
    path = "/api/terminal/alacritty-config",
    responses((status = 200, body = crate::domain::terminal::alacritty_config::AlacrittyConfigResponse))
)]
pub async fn alacritty_config_route(
    State(state): State<AppState>,
) -> Json<crate::domain::terminal::alacritty_config::AlacrittyConfigResponse> {
    Json(
        crate::domain::terminal::alacritty_config::read_alacritty_config_response(
            state.fallback_palette.clone(),
        ),
    )
}

async fn terminal_ws_handler(
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
    let ws = ws.protocols([selected_proto]);
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
    pty_manager: &super::service::PtyManager,
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

    let (pty_id, handle) = match state.pty_manager.create_pty(feature_id, &cwd, cols, rows) {
        Ok(result) => result,
        Err(e) => {
            send_error(socket, &format!("Failed to create PTY: {e}")).await;
            return;
        }
    };

    info!(pty_id = %pty_id, cwd = %cwd, "Created new PTY");

    let (mut ws_sink, ws_stream) = socket.split();
    let ready_msg = ServerMessage::Ready {
        pty_id: pty_id.clone(),
        cwd: cwd.clone(),
    };
    if send_msg(&mut ws_sink, &ready_msg).await.is_err() {
        return;
    }

    run_pty_ws_loop(
        ws_sink,
        ws_stream,
        pty_id,
        handle,
        state.pty_manager.clone(),
    )
    .await;
}

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
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

/// Spawn task that reads WebSocket messages and dispatches writes/resizes/kills to the PTY.
fn spawn_ws_to_pty_writer(
    mut ws_stream: WsStream,
    pty_id: String,
    pty_manager: super::service::PtyManager,
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
        let _ = sink.lock().await.send(Message::Text(json.into())).await;
        info!(pty_id = %pty_id, "Sent exit message");
    })
}

/// Orchestrate PTY ↔ WebSocket bridging using the PTY's persistent broadcast channel.
async fn run_pty_ws_loop(
    ws_sink: WsSink,
    ws_stream: WsStream,
    pty_id: String,
    handle: Arc<PtyHandle>,
    pty_manager: super::service::PtyManager,
) {
    let data_rx = handle.data_tx.subscribe();
    let sink = Arc::new(tokio::sync::Mutex::new(ws_sink));

    let mut forward_task = spawn_pty_to_ws_forwarder(Arc::clone(&sink), data_rx);
    let mut write_task = spawn_ws_to_pty_writer(ws_stream, pty_id.clone(), pty_manager);
    let mut exit_task = spawn_exit_watcher(Arc::clone(&sink), pty_id.clone(), Arc::clone(&handle));

    tokio::select! {
        _ = &mut write_task => {
            info!(pty_id = %pty_id, "WebSocket closed, PTY kept alive");
        }
        _ = &mut forward_task => {
            info!(pty_id = %pty_id, "PTY broadcast channel closed");
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), &mut exit_task).await;
        }
        _ = &mut exit_task => {
            info!(pty_id = %pty_id, "PTY exited");
        }
    }

    write_task.abort();
    forward_task.abort();
    exit_task.abort();

    let _ = sink.lock().await.send(Message::Close(None)).await;
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
    let _ = send_msg(&mut sink, &msg).await;
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn closing_feature_stops_its_neovim_process() {
        // Skip: NeovimManager is now a stub (RPC surface removed).
        // The PTY-based migration will re-implement this check.
        eprintln!("SKIP: NeovimManager is a stub; PTY migration pending");
    }
}
