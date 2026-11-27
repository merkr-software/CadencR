//! The plugin socket `GET /api/plugin-tabs/ws` (`docs/CUSTOM_TABS.md` §4.4).
//!
//! Same `WsEnvelope` as `/ws`, but a closed vocabulary: the only client
//! domain is `plugin` (`subscribe` / `unsubscribe`), and every server event is
//! an internal envelope wrapped in `plugin/event` for one subscription. The
//! grant arrives in the `cadencr-plugin.<token>` subprotocol (browsers cannot
//! set headers on an upgrade) and is checked once; its revocation or expiry
//! closes the socket with 1008 (policy violation).

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Extension;
use futures::StreamExt;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::grants::{Grant, GrantStore};
use super::principal::token_invalid;
use crate::api::middleware::{offered_subprotocols, validate_ws_origin};
use crate::app_state::AppState;
use crate::error::AppError;
use crate::remote::RemoteContext;

mod backend;
mod emitter;
mod outbound;
mod session_stream;
mod subscriptions;
mod topics;

use subscriptions::Subscriptions;

pub const SOCKET_PATH: &str = "/api/plugin-tabs/ws";

/// `Sec-WebSocket-Protocol` entry carrying the grant token.
pub const PROTOCOL_PREFIX: &str = "cadencr-plugin.";

/// Native requests allow 1 MiB of params plus their envelope.
const MAX_INBOUND_BYTES: usize = 1024 * 1024 + 4096;

/// Inbound budget: subscribing can compute a git status, so a guest cannot
/// spin on it. Past it, frames are dropped unread (one error per window), and
/// a client over budget this many windows in a row is disconnected.
const MAX_INBOUND_PER_SECOND: u32 = 20;
const MAX_BACKEND_PER_SECOND: u32 = 200;
const MAX_WINDOWS_OVER_BUDGET: u32 = 5;

/// Events queued for a peer before its subscriptions start dropping and
/// owing resyncs.
const OUTBOUND_CAPACITY: usize = 256;

/// How long the writer may take to deliver the policy close frame.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// Every stream topic and the scope it needs (§4.4).
pub fn topic_scopes() -> Vec<(&'static str, super::policy::Scope)> {
    topics::Topic::ALL
        .into_iter()
        .filter_map(|topic| topic.scope().map(|scope| (topic.name(), scope)))
        .collect()
}

/// The upgrade. Loopback only — the route is not on the remote listener, and
/// a remote context here would mean it was mounted there by mistake.
pub async fn plugin_tab_socket_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
    remote: Option<Extension<RemoteContext>>,
) -> Response {
    if remote.is_some() {
        return AppError::coded(
            StatusCode::FORBIDDEN,
            "PLUGIN_TAB_REMOTE_UNSUPPORTED",
            "custom tabs are desktop-only",
        )
        .into_response();
    }
    if let Err(response) = validate_ws_origin(&headers, state.frontend_port) {
        return response;
    }
    let Some((protocol, grant)) = authenticate(&headers, &state.plugin_tab_grants) else {
        return token_invalid().into_response();
    };
    ws.max_message_size(MAX_INBOUND_BYTES)
        .max_frame_size(MAX_INBOUND_BYTES)
        .protocols([protocol])
        .on_upgrade(move |socket| run(socket, state, grant))
        .into_response()
}

/// The offered `cadencr-plugin.<token>` entry (to echo back) and its grant.
fn authenticate(headers: &HeaderMap, grants: &GrantStore) -> Option<(String, Grant)> {
    offered_subprotocols(headers).find_map(|offered| {
        let token = offered.strip_prefix(PROTOCOL_PREFIX)?;
        grants
            .resolve(token)
            .map(|grant| (offered.to_string(), grant))
    })
}

/// The read loop. Writing happens in its own task, so a peer that stops
/// reading cannot keep this loop from acting on revocation or expiry.
async fn run(socket: WebSocket, state: AppState, grant: Grant) {
    let (sink, mut stream) = socket.split();
    let (out, out_rx) = outbound::channel(OUTBOUND_CAPACITY);
    let stalled = out.stalled();
    let (close_tx, close_rx) = oneshot::channel();
    let mut writer = tokio::spawn(outbound::write(sink, out_rx, out.shared(), close_rx));
    let mut subscriptions = Subscriptions::new(state, grant.clone(), out);
    let expiry = async {
        match grant.expires {
            Some(expires) => tokio::time::sleep_until(Instant::from_std(expires)).await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(expiry);
    let mut budget = InboundBudget::new();
    let mut backend_budget = InboundBudget::new();
    backend_budget.limit = MAX_BACKEND_PER_SECOND;
    let mut writer_done = false;
    let close = loop {
        tokio::select! {
            () = grant.revoked.cancelled() => break Some("grant revoked"),
            () = &mut expiry => break Some("grant expired"),
            () = stalled.cancelled() => break Some("the client stopped reading"),
            _ = &mut writer, if !writer_done => {
                writer_done = true;
                break None;
            }
            inbound = stream.next() => match inbound {
                Some(Ok(Message::Text(text))) => match if backend_request(&text) {
                    backend_budget.admit(Instant::now())
                } else { budget.admit(Instant::now()) } {
                    // A slow subscribe (git status, tree walk) still yields to
                    // revocation and expiry.
                    Admit::Yes => tokio::select! {
                        () = subscriptions.handle(&text) => {}
                        () = grant.revoked.cancelled() => break Some("grant revoked"),
                        () = &mut expiry => break Some("grant expired"),
                    },
                    Admit::RejectOnce => subscriptions.rate_limited(&text),
                    Admit::Drop => {}
                    Admit::Close => break Some("too many plugin socket messages"),
                },
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                Some(Ok(_)) => {}
            },
        }
    };
    subscriptions.close_all().await;
    drop(subscriptions);
    if !writer_done {
        finish(writer, close_tx, close).await;
    }
}

/// Let the writer flush and send the close frame, within [`CLOSE_GRACE`].
async fn finish(
    mut writer: JoinHandle<()>,
    close_tx: oneshot::Sender<&'static str>,
    reason: Option<&'static str>,
) {
    match reason {
        // The writer may have just exited on its own; then there is no peer.
        Some(reason) => {
            if close_tx.send(reason).is_err() {
                tracing::debug!("plugin socket writer gone before the close frame");
            }
        }
        // The peer left: dropping the sender lets the writer stop now
        // instead of waiting out the grace for a frame that never comes.
        None => drop(close_tx),
    }
    if tokio::time::timeout(CLOSE_GRACE, &mut writer)
        .await
        .is_err()
    {
        tracing::debug!("plugin socket peer not reading; dropping the connection");
        writer.abort();
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Admit {
    Yes,
    /// First frame over budget this window: answer `RATE_LIMITED` once.
    RejectOnce,
    Drop,
    Close,
}

struct InboundBudget {
    limit: u32,
    window: Instant,
    count: u32,
    windows_over: u32,
}

impl InboundBudget {
    fn new() -> Self {
        Self {
            limit: MAX_INBOUND_PER_SECOND,
            window: Instant::now(),
            count: 0,
            windows_over: 0,
        }
    }

    fn admit(&mut self, now: Instant) -> Admit {
        if now.duration_since(self.window) >= Duration::from_secs(1) {
            let was_over = self.count > self.limit;
            self.windows_over = if was_over { self.windows_over + 1 } else { 0 };
            self.window = now;
            self.count = 0;
        }
        self.count += 1;
        if self.count <= self.limit {
            Admit::Yes
        } else if self.windows_over >= MAX_WINDOWS_OVER_BUDGET {
            Admit::Close
        } else if self.count == self.limit + 1 {
            Admit::RejectOnce
        } else {
            Admit::Drop
        }
    }
}

/// Borrow the head only: native calls have a separate bounded input budget.
fn backend_request(text: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct Head<'a> {
        domain: &'a str,
        action: &'a str,
    }
    serde_json::from_str::<Head<'_>>(text)
        .is_ok_and(|head| head.domain == "plugin" && head.action == "backend.request")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::grants::GrantRequest;
    use crate::domain::plugin_tabs::policy::Scope;
    use axum::http::header;

    #[test]
    fn authenticates_from_the_plugin_subprotocol_only() {
        let grants = GrantStore::default();
        let token = grants
            .mint(
                GrantRequest::builder()
                    .plugin_id("graph".into())
                    .project_id(1)
                    .feature_id(2)
                    .scopes(vec![Scope::GitRead])
                    .permissions_hash("h".into())
                    .build(),
            )
            .token;
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            format!("cadencr-token.{token}, {PROTOCOL_PREFIX}{token}")
                .parse()
                .unwrap(),
        );
        let (protocol, grant) = authenticate(&headers, &grants).unwrap();
        assert_eq!(protocol, format!("{PROTOCOL_PREFIX}{token}"));
        assert_eq!(grant.feature_id, 2);
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            format!("cadencr-token.{token}").parse().unwrap(),
        );
        assert!(authenticate(&headers, &grants).is_none());
    }

    #[tokio::test]
    async fn a_peer_that_left_does_not_wait_out_the_close_grace() {
        let (out, rx) = outbound::channel(4);
        let (sink, _peer) = futures::channel::mpsc::unbounded();
        let (close_tx, close_rx) = oneshot::channel();
        let writer = tokio::spawn(outbound::write(sink, rx, out.shared(), close_rx));
        drop(out);
        let start = Instant::now();
        finish(writer, close_tx, None).await;
        assert!(start.elapsed() < CLOSE_GRACE);
    }

    #[test]
    fn inbound_budget_rejects_once_drops_then_closes_a_persistent_flood() {
        let mut budget = InboundBudget::new();
        let start = budget.window;
        let second = Duration::from_secs(1);
        for _ in 0..MAX_INBOUND_PER_SECOND {
            assert_eq!(budget.admit(start), Admit::Yes);
        }
        assert_eq!(budget.admit(start), Admit::RejectOnce);
        assert_eq!(budget.admit(start), Admit::Drop);
        // A quiet window forgives; a flood that keeps going is cut off.
        assert_eq!(budget.admit(start + second), Admit::Yes);
        assert_eq!(budget.admit(start + second * 2), Admit::Yes);
        assert_eq!(budget.windows_over, 0);
        let mut now = start + second * 2;
        for _ in 0..MAX_WINDOWS_OVER_BUDGET {
            for _ in 0..=MAX_INBOUND_PER_SECOND {
                budget.admit(now);
            }
            now += second;
        }
        for _ in 0..MAX_INBOUND_PER_SECOND {
            assert_eq!(budget.admit(now), Admit::Yes);
        }
        assert_eq!(budget.admit(now), Admit::Close);
    }
}
