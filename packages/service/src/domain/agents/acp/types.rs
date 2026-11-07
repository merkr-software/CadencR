use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::domain::agents::acp::incoming::{AcpNotification, AcpServerRequest};

/// Identification block included in `initialize` requests so agents can log
/// who called them. Matches the Codex SDK shape; used here verbatim because
/// ACP `initialize` accepts an open `clientInfo` object.
#[derive(Debug, Clone)]
pub struct AcpClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

impl Default for AcpClientInfo {
    fn default() -> Self {
        Self {
            name: "cadencr".into(),
            title: "Cadencr".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}

/// One-shot ordering fence. Released by the event loop once every preceding
/// event has been handled; dropping it unreleased (queue closed, loop gone)
/// wakes the waiter with an error instead of leaving it hanging.
#[derive(Debug, Clone)]
pub struct AcpEventBarrier(Arc<Mutex<Option<oneshot::Sender<()>>>>);

impl AcpEventBarrier {
    pub(crate) fn new() -> (Self, oneshot::Receiver<()>) {
        let (tx, rx) = oneshot::channel();
        (Self(Arc::new(Mutex::new(Some(tx)))), rx)
    }

    pub(crate) fn release(&self) {
        let sender = self.0.lock().ok().and_then(|mut slot| slot.take());
        if let Some(sender) = sender {
            // The waiter may have given up (turn cancelled); nothing to signal.
            let _ = sender.send(());
        }
    }
}

/// Events fanned out by the ACP transport to subscribers.
///
/// Provider-neutral. The runtime event loop consumes them losslessly via
/// `AcpClient::subscribe_reliable()`; short-lived observers may use the
/// best-effort `AcpClient::subscribe()`. Adapters translate them into
/// `RuntimeEvent`s. The notification/request payloads
/// are typed envelopes (`AcpNotification`/`AcpServerRequest`) that retain raw
/// JSON so OpenCode-style provider extensions survive routing even when they
/// fail the official-schema deserializer.
#[derive(Debug, Clone)]
pub enum AcpEvent {
    /// One-way notification from the agent (no `id`). Examples:
    /// `session/update`, `current_mode_update`.
    Notification(AcpNotification),
    /// A request initiated *by the agent* that we (the client) must answer.
    /// Used for `session/request_permission`, `fs/*`, `terminal/*`. The
    /// adapter handles `request.method()`, then calls
    /// `respond_server_request(id, ...)` or `reject_server_request(id, ...)`.
    ServerRequest(AcpServerRequest),
    /// Internal ordering fence inserted after a JSON-RPC response. The runtime
    /// event loop acknowledges it only after every preceding notification has
    /// been translated, preventing a terminal `Result` from racing ahead of a
    /// final `session/update` frame. Only delivered to reliable subscribers.
    EventBarrier(AcpEventBarrier),
    /// A reliable subscription exceeded its backlog safety limit. Terminal:
    /// nothing follows it on that subscription.
    TransportError { message: String },
    /// The subprocess exited. Sent at most once (idempotent via `exit_sent`
    /// AtomicBool in the reaper). Pending server-request responders are
    /// dropped just before this fires; requests we sent fail once the
    /// connection closes.
    ProcessExited {
        status: Option<i32>,
        signal: Option<i32>,
    },
}
