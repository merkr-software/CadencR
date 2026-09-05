use std::sync::Arc;

use tokio::sync::Notify;

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

/// Events fanned out by the ACP transport to subscribers.
///
/// Provider-neutral. Adapters subscribe via `AcpClient::subscribe()` and
/// translate these into `RuntimeEvent`s. The notification/request payloads
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
    /// final `session/update` frame.
    EventBarrier(Arc<Notify>),
    /// The subprocess exited. Sent at most once (idempotent via `exit_sent`
    /// AtomicBool in the reader). Pending requests are drained with
    /// `AcpError::ProcessExited` immediately before this fires.
    ProcessExited {
        status: Option<i32>,
        signal: Option<i32>,
    },
}
