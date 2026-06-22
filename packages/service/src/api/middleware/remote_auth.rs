//! Auth middleware for the remote (network) listener. Distinct from the
//! loopback `auth_middleware`:
//!
//! - `Host` must be one of the explicit allowed hosts (LAN IPs / localhost on
//!   the remote port) — never a wildcard. This is the DNS-rebinding defense for
//!   the network listener.
//! - The bearer credential is a **device token**, not the launch token. The
//!   launch token is loopback-only and is never accepted here.
//! - Static SPA assets, the pairing endpoint, and WebSocket upgrades bypass the
//!   bearer check (they self-authenticate or must load before a token exists),
//!   but every request still passes the host allowlist.

use axum::{
    extract::{Request, State},
    http::header,
    middleware::Next,
    response::Response,
    Extension,
};

use super::auth::is_websocket_upgrade;
use super::response::{misdirected, unauthorized};
use super::AUTH_HEADER;
use crate::app_state::AppState;
use crate::domain::remote::tokens;
use crate::remote::RemoteContext;

/// The authenticated device id, injected as a request extension by
/// [`remote_auth_middleware`] once a device token verifies. Handlers on the
/// remote router (e.g. push-subscription endpoints) read it via
/// `Extension<DeviceId>` to key per-device state. Absent on bearer-exempt paths
/// (pairing, static SPA assets, WS upgrades).
#[derive(Clone, Copy, Debug)]
pub struct DeviceId(pub i64);

pub async fn remote_auth_middleware(
    State(state): State<AppState>,
    Extension(ctx): Extension<RemoteContext>,
    mut request: Request,
    next: Next,
) -> Response {
    if !host_allowed(&request, &ctx.allowed_hosts) {
        return misdirected();
    }

    // SPA assets and the pairing endpoint carry no device token (they must load
    // or run before one exists). A WebSocket upgrade can't carry one either —
    // browsers can't set headers on an upgrade — so the *known* WS routes are
    // exempt here and instead self-authenticate via `middleware::authenticate_ws`
    // (device token + origin). Scoping the WS exemption to known paths means a
    // future WS route can't silently inherit the bypass: it would 401 here until
    // it's added to `is_known_ws_path` and wired to `authenticate_ws`. All of
    // these still passed the host check above.
    let path = request.uri().path();
    if is_bearer_exempt(path) || (is_websocket_upgrade(&request) && is_known_ws_path(path)) {
        return next.run(request).await;
    }

    let presented = request
        .headers()
        .get(AUTH_HEADER)
        .and_then(|value| value.to_str().ok());
    let Some(token) = presented else {
        return unauthorized();
    };
    let Some(device_id) = tokens::verify_device_token(&state.read_pool, &ctx.pepper, token).await
    else {
        return unauthorized();
    };

    // Expose the verified device id so downstream handlers (push subscription)
    // can key per-device state without re-hashing the token.
    request.extensions_mut().insert(DeviceId(device_id));
    next.run(request).await
}

/// Exact-match the `Host` header against the allowlist. A DNS-rebound request
/// carries the attacker's domain in `Host`, so it fails to match and is 421'd.
fn host_allowed(request: &Request, allowed: &[String]) -> bool {
    request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| allowed.iter().any(|entry| entry == host))
}

/// Paths that bypass the device-token bearer check: the pairing endpoint, and
/// any static SPA asset (everything not under `/api/` and not the WS route).
fn is_bearer_exempt(path: &str) -> bool {
    path == "/api/remote/pair" || (!path.starts_with("/api/") && path != "/ws")
}

/// The WebSocket routes that self-authenticate via `middleware::authenticate_ws`.
/// Kept in sync with the `get(...)` WS handlers: `/ws` (agent stream),
/// `/api/terminal/ws`, and the LSP connect upgrade
/// (`/api/lsp/sessions/{session_id}/connect`). A WS upgrade to any other path is
/// not exempt, so a new socket route must be added here deliberately.
fn is_known_ws_path(path: &str) -> bool {
    path == "/ws"
        || path == "/api/terminal/ws"
        || (path.starts_with("/api/lsp/sessions/") && path.ends_with("/connect"))
}

#[cfg(test)]
mod tests {
    use super::{is_bearer_exempt, is_known_ws_path};

    #[test]
    fn pair_and_static_assets_are_exempt() {
        assert!(is_bearer_exempt("/api/remote/pair"));
        assert!(is_bearer_exempt("/")); // index.html
        assert!(is_bearer_exempt("/assets/app.js"));
        assert!(is_bearer_exempt("/favicon.ico"));
    }

    #[test]
    fn api_and_ws_require_auth() {
        assert!(!is_bearer_exempt("/api/remote/status"));
        assert!(!is_bearer_exempt("/api/git/status"));
        assert!(!is_bearer_exempt("/ws"));
    }

    #[test]
    fn only_the_known_ws_routes_are_exempt() {
        assert!(is_known_ws_path("/ws"));
        assert!(is_known_ws_path("/api/terminal/ws"));
        assert!(is_known_ws_path("/api/lsp/sessions/abc-123/connect"));
        // A future WS route is NOT auto-exempt — it must be added here, which is
        // the prompt to also wire it through `authenticate_ws`.
        assert!(!is_known_ws_path("/api/some/new/socket"));
        assert!(!is_known_ws_path("/api/lsp/sessions/abc-123"));
        assert!(!is_known_ws_path("/api/git/status"));
    }
}
