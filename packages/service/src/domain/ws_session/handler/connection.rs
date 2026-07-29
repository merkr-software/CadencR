//! WebSocket upgrade + per-connection loop, dispatch, and disconnect cleanup.

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{debug, warn};

use crate::api::middleware::authenticate_ws;
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{SessionErrorPayload, WsEnvelope};
use crate::remote::RemoteContext;

use super::dispatch::dispatch_envelope;
use super::types::{QueryState, SdkSessions};

mod outbound;

use outbound::{
    retryable_error_shutdown, retryable_shutdown, spawn_outbound_bridge, spawn_socket_sender,
    OutboundBridgeExit, OUTBOUND_SOCKET_CAPACITY, OUTBOUND_SOCKET_SEND_TIMEOUT,
    RETRY_CLOSE_SEND_TIMEOUT,
};

const MAX_INBOUND_MESSAGES_PER_SECOND: u16 = 120;
const INBOUND_RATE_RETRY_AFTER_MS: u64 = 5_000;
const GRACEFUL_CLOSE_SEND_TIMEOUT: Duration =
    Duration::from_secs(RETRY_CLOSE_SEND_TIMEOUT.as_secs() + 1);
const GRACEFUL_CLOSE_ECHO_TIMEOUT: Duration = Duration::from_secs(1);

struct InboundRateLimit {
    window_started: Instant,
    count: u16,
}

impl InboundRateLimit {
    fn new() -> Self {
        Self {
            window_started: Instant::now(),
            count: 0,
        }
    }

    fn allow(&mut self, now: Instant) -> bool {
        if now.duration_since(self.window_started) >= Duration::from_secs(1) {
            self.window_started = now;
            self.count = 0;
        }
        self.count = self.count.saturating_add(1);
        self.count <= MAX_INBOUND_MESSAGES_PER_SECOND
    }
}

async fn finish_graceful_close(
    send_task: &mut tokio::task::JoinHandle<()>,
    ws_stream: &mut futures::stream::SplitStream<WebSocket>,
) {
    if !matches!(
        tokio::time::timeout(GRACEFUL_CLOSE_SEND_TIMEOUT, send_task).await,
        Ok(Ok(()))
    ) {
        return;
    }
    // Wait for the close echo; dropping immediately produces code 1006.
    let _ = tokio::time::timeout(GRACEFUL_CLOSE_ECHO_TIMEOUT, async {
        while let Some(message) = ws_stream.next().await {
            match message {
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await;
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
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
        Some(device_id) => {
            record_remote_connect(&state, device_id);
            ws.on_upgrade(move |socket| handle_remote_connection(socket, state, device_id))
                .into_response()
        }
        None => ws
            .on_upgrade(move |socket| handle_connection(socket, state))
            .into_response(),
    }
}

/// Wrap the normal connection loop so that revoking the device cancels the
/// session immediately. Cancellation drops `handle_connection`, which drops the
/// socket; the live-session guard deregisters on scope exit.
async fn handle_remote_connection(socket: WebSocket, state: AppState, device_id: i64) {
    let (guard, first_connection) = state.remote.live().register(device_id);
    if first_connection {
        // One toast per device-connection: only the device's first live socket
        // emits (the registry deduped the rest). `send` errors only when no host
        // client is subscribed, which is fine — nothing to notify.
        let _ = state
            .remote_events_tx
            .send(crate::domain::remote::models::RemoteConnectedEvent { device_id });
    }
    tokio::select! {
        _ = handle_connection(socket, state) => {}
        _ = guard.token.cancelled() => {
            debug!(device_id, "remote session force-closed (device revoked)");
        }
    }
}

/// Best-effort: stamp `last_seen` and write a `connect` audit entry without
/// blocking the upgrade.
fn record_remote_connect(state: &AppState, device_id: i64) {
    let pool = state.write_pool.clone();
    tokio::spawn(async move {
        let _ = crate::domain::remote::repo::touch_last_seen(&pool, device_id).await;
        let _ = crate::domain::remote::repo::record_audit(&pool, "connect", Some(device_id), None)
            .await;
    });
}

/// Runs the WebSocket connection loop after upgrade.
async fn handle_connection(socket: WebSocket, state: AppState) {
    let (ws_sink, mut ws_stream) = socket.split();
    let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<Message>();
    let (socket_tx, socket_rx) = mpsc::channel::<Message>(OUTBOUND_SOCKET_CAPACITY);
    let (bridge_task, mut bridge_exit_rx) = spawn_outbound_bridge(outbound_rx, socket_tx);
    let sdk_sessions: SdkSessions = std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut inbound_rate = InboundRateLimit::new();
    let mut graceful_close_requested = false;

    // A separate priority channel lets overload shutdown bypass the full data
    // queue and cancel an in-progress normal `send`. The framed socket may
    // still need to flush bytes it already accepted before it can enqueue the
    // close, so graceful teardown gives that bounded flush time to recover.
    let (mut send_task, close_tx) = spawn_socket_sender(ws_sink, socket_rx);

    // Inbound loop: read messages from client. We `select!` against the
    // outbound task so a half-open TCP socket (e.g. laptop sleep, Wi-Fi
    // change) is detected within ~one outbound send attempt instead of
    // waiting minutes for OS-level TCP keepalive. Without this, the cleanup
    // block below — which broadcasts `Idle` for every active session —
    // never runs, leaving the UI stuck on "agent working" while the
    // streamed events drop into a subscriber that nobody reads.
    loop {
        tokio::select! {
            biased;
            _ = &mut send_task => {
                debug!("ws_sink closed; ending inbound loop");
                break;
            }
            bridge_exit = &mut bridge_exit_rx => {
                match bridge_exit {
                    Ok(OutboundBridgeExit::SendTimeout) => {
                        warn!(
                            capacity = OUTBOUND_SOCKET_CAPACITY,
                            timeout_ms = OUTBOUND_SOCKET_SEND_TIMEOUT.as_millis(),
                            "WebSocket peer did not drain the outbound queue before timeout"
                        );
                        if close_tx.send(retryable_shutdown("overloaded")).await.is_err() {
                            debug!("WebSocket sender closed before overload close could be requested");
                        }
                        graceful_close_requested = true;
                    }
                    Ok(OutboundBridgeExit::SocketClosed) | Err(_) => {
                        debug!("WebSocket outbound bridge closed");
                    }
                }
                break;
            }
            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if !inbound_rate.allow(Instant::now()) {
                            warn!(
                                max_messages_per_second = MAX_INBOUND_MESSAGES_PER_SECOND,
                                retry_after_ms = INBOUND_RATE_RETRY_AFTER_MS,
                                "WebSocket inbound message rate exceeded"
                            );
                            let err_env = WsEnvelope::new(
                                "session",
                                "error",
                                serde_json::to_value(SessionErrorPayload {
                                    code: "RATE_LIMITED".into(),
                                    message: "WebSocket message rate exceeded".into(),
                                    retry_after_ms: Some(INBOUND_RATE_RETRY_AFTER_MS),
                                    ..Default::default()
                                })
                                .unwrap(),
                            );
                            let shutdown = retryable_error_shutdown(
                                Message::Text(String::from(err_env).into()),
                                "rate-limited",
                            );
                            if close_tx.send(shutdown).await.is_err() {
                                debug!("WebSocket sender closed before rate-limit shutdown could be requested");
                            }
                            graceful_close_requested = true;
                            break;
                        }
                        let text_str: &str = &text;
                        match WsEnvelope::try_from(text_str.to_string()) {
                            Ok(envelope) => {
                                dispatch_envelope(
                                    envelope,
                                    &outbound_tx,
                                    &sdk_sessions,
                                    &state,
                                )
                                .await;
                            }
                            Err(e) => {
                                let err_env = WsEnvelope::new(
                                    "session",
                                    "error",
                                    serde_json::to_value(SessionErrorPayload {
                                        code: "PARSE_ERROR".into(),
                                        message: format!("Invalid envelope: {e}"),
                                        ..Default::default()
                                    })
                                    .unwrap(),
                                );
                                let _ = outbound_tx
                                    .send(Message::Text(String::from(err_env).into()));
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => {} // ignore binary, ping, pong
                    Some(Err(_)) | None => break,
                }
            }
        }
    }

    if graceful_close_requested {
        finish_graceful_close(&mut send_task, &mut ws_stream).await;
    }

    // Cleanup: this connection is going away, but a turn it started must keep
    // running on the host. Drop only `Pending` handles — viewers with no live
    // process. Every `Active` handle is left in place: its stream reader holds
    // this map alive and performs *deferred teardown* once the turn finishes
    // and the owner is gone (see `StreamReaderTask::maybe_teardown_orphaned`).
    // Closing it here is exactly what stopped the agent when a remote client
    // (e.g. a phone) went to sleep mid-turn. We deliberately do NOT mark the
    // session paused or broadcast Idle: it is still running, and a reconnecting
    // device should see it that way.
    let mut sessions = sdk_sessions.lock().await;
    let live_turns = sessions
        .values()
        .filter(|handle| matches!(handle.state, QueryState::Active { .. }))
        .count();
    debug!(
        total = sessions.len(),
        live_turns, "WS cleanup: keeping live turns, dropping pending handles"
    );
    sessions.retain(|_, handle| matches!(handle.state, QueryState::Active { .. }));
    drop(sessions);

    // A surviving turn keeps its weak registry ownership so other devices can
    // answer gates and render its timer. The reader clears it at completion.
    if live_turns == 0 {
        state.active_turns.remove_owned_by(&sdk_sessions).await;
    }

    // Drop any `git.status` subscriptions for this WS. The sender-keyed sweep
    // catches half-open shutdowns where the explicit unsubscribe never arrived.
    state.git_watcher.unsubscribe_sender(&outbound_tx).await;

    // Remove this connection's sender from every feature it was registered under.
    state
        .ws_feature_senders
        .unregister_sender(&outbound_tx)
        .await;

    bridge_task.abort();
    send_task.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbound_rate_limit_resets_after_one_second() {
        let mut limiter = InboundRateLimit::new();
        let start = limiter.window_started;
        for _ in 0..MAX_INBOUND_MESSAGES_PER_SECOND {
            assert!(limiter.allow(start));
        }
        assert!(!limiter.allow(start));
        assert!(limiter.allow(start + Duration::from_secs(1)));
    }
}
