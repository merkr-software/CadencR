use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A paired (non-revoked) remote device, as shown in the host UI.
#[derive(Debug, Serialize, ToSchema)]
pub struct RemoteDevice {
    pub id: i64,
    pub label: Option<String>,
    pub created_at: String,
    pub last_seen_at: Option<String>,
}

/// One audit-trail entry (`pair` / `connect` / `revoke` / `pair_rejected`).
#[derive(Debug, Serialize, ToSchema)]
pub struct RemoteAuditEntry {
    pub event: String,
    pub device_id: Option<i64>,
    pub detail: Option<String>,
    pub created_at: String,
}

/// Listener metadata needed by the desktop browser's origin policy.
#[derive(Debug, Serialize, ToSchema)]
pub struct RemoteBrowserOrigins {
    pub enabled: bool,
    pub port: Option<u16>,
    pub lan_urls: Vec<String>,
    pub tunnel_host: Option<String>,
}

/// Full remote-access state for the host dialog.
#[derive(Debug, Serialize, ToSchema)]
pub struct RemoteStatus {
    pub enabled: bool,
    pub port: Option<u16>,
    /// SHA-256 fingerprint of the self-signed cert (for TOFU verification).
    pub fingerprint: Option<String>,
    /// `https://<lan-ip>:<port>/` for each detected interface.
    pub lan_urls: Vec<String>,
    /// Configured tunnel hostname (e.g. Tailscale), normalized; `None` if unset.
    /// Tunneled requests with this `Host` are allowed through.
    pub tunnel_host: Option<String>,
    pub devices: Vec<RemoteDevice>,
    /// Distinct devices with a live socket open right now (≤ `devices.len()`).
    pub connected_devices: usize,
    /// Lifecycle of the current pairing code, so the host can retire the QR the
    /// moment it's consumed (or expired) instead of guessing from device counts.
    pub pairing_state: crate::remote::pairing::PairingState,
    pub audit_tail: Vec<RemoteAuditEntry>,
}

/// Broadcast when a remote device opens its first live socket (so the host UI
/// can show a one-per-connection "device connected" toast). Forwarded to
/// subscribed clients as an `app/remote_connected` WS envelope; never part of
/// the REST surface.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteConnectedEvent {
    pub device_id: i64,
}

/// Response to a pairing-code mint: the code plus connect URLs/QR payloads. The
/// code — never a device token — is what the QR encodes.
#[derive(Debug, Serialize, ToSchema)]
pub struct PairingCodeResponse {
    pub code: String,
    pub expires_in_secs: u64,
    /// `https://<lan-ip>:<port>/#code=<code>` for each interface.
    pub urls: Vec<String>,
    pub fingerprint: String,
}

/// Body of `POST /api/remote/pair`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PairRequest {
    pub code: String,
}

/// Body of `PUT /api/remote/tunnel-host`. `null`/blank clears the tunnel host.
#[derive(Debug, Deserialize, ToSchema)]
pub struct TunnelHostRequest {
    pub host: Option<String>,
}

/// Result of a successful pairing: the durable device token (the only place the
/// raw token is ever transmitted, over TLS).
#[derive(Debug, Serialize, ToSchema)]
pub struct PairResponse {
    pub device_token: String,
    pub label: String,
}
