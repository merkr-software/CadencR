//! Remote listener rate limiting keyed by who is calling, not only by where
//! the TCP connection comes from.
//!
//! Behind a tunnel every device reaches the listener from the same peer
//! address (`127.0.0.1`, or the tunnel's local proxy), so a per-address budget
//! would let one device spend everyone's allowance, and its failed credentials
//! would lock the others out. A device whose token has already been verified
//! is therefore charged to its own budget, found by a fingerprint of the token
//! it presents. Everything else (pairing, static assets, first contact, wrong
//! tokens) is keyed by the TCP peer address and never by a client-supplied
//! header such as `X-Forwarded-For`, which anyone can forge.
//!
//! Once a peer exhausts its failure budget, anonymous requests and tokens
//! already answered with 401 are shed before any DB work. A token never seen
//! still gets a few verifications per window, so a device reconnecting after
//! a restart is not locked out by another device retrying a revoked token.
//!
//! The fingerprint only picks a budget: `remote_auth_middleware` (or
//! `authenticate_ws`) still verifies the token on every request.

use std::net::IpAddr;
use std::time::Instant;

use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::Extension;

use super::fingerprints::Credential;
use super::{client_ip, Bucket, Client, RateLimiter};
use crate::api::middleware::auth::{is_known_ws_path, is_websocket_upgrade, AUTH_HEADER};
use crate::api::middleware::remote_auth::DeviceId;
use crate::api::middleware::response::{connection_metadata_unavailable, too_many_requests};
use crate::api::middleware::ws::presented_ws_token;

/// Middleware for the remote listener. Runs outside the auth layer so abuse
/// (pairing brute force, credential guessing) is shed before any DB work.
pub async fn rate_limit_middleware(
    Extension(limiter): Extension<std::sync::Arc<RateLimiter>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(ip) = client_ip(&request) else {
        tracing::error!("rate limiter missing peer connection metadata");
        return connection_metadata_unavailable();
    };
    let now = Instant::now();
    if request.method() == Method::POST && request.uri().path() == "/api/remote/pair" {
        if let Err(retry_after) = limiter.check(Client::Peer(ip), Bucket::Pair, now) {
            return too_many_requests(retry_after);
        }
        return settle(&limiter, ip, None, next.run(request).await);
    }

    let presented = presented_token(&request).map(|token| {
        let known = limiter.fingerprints();
        let fingerprint = known.fingerprint(token);
        (fingerprint, known.credential(fingerprint, now))
    });
    let credential = presented.map(|(_, credential)| credential);
    if let Err(retry_after) = admit(&limiter, ip, credential, now) {
        return too_many_requests(retry_after);
    }
    let fingerprint = presented.map(|(fingerprint, _)| fingerprint);
    settle(&limiter, ip, fingerprint, next.run(request).await)
}

/// Charge the request to its budget. `None` is an anonymous request.
fn admit(
    limiter: &RateLimiter,
    ip: IpAddr,
    credential: Option<Credential>,
    now: Instant,
) -> Result<(), u64> {
    if let Some(Credential::Device(device)) = credential {
        return limiter.check(Client::Device(device), Bucket::General, now);
    }
    limiter.check(Client::Peer(ip), Bucket::General, now)?;
    let Some(retry_after) = limiter.auth_retry_after(ip, now) else {
        return Ok(());
    };
    match credential {
        Some(Credential::Unknown) => limiter
            .check(Client::Peer(ip), Bucket::FirstContact, now)
            .map_err(|_| retry_after),
        _ => Err(retry_after),
    }
}

/// Record what the response proved about the presented token: a verified
/// device (stamped by the auth layer) earns its own budget; a 401 marks the
/// token rejected and counts against the peer's failure budget.
fn settle(
    limiter: &RateLimiter,
    ip: IpAddr,
    fingerprint: Option<u64>,
    response: Response,
) -> Response {
    let now = Instant::now();
    if response.status() == StatusCode::UNAUTHORIZED {
        if let Some(fingerprint) = fingerprint {
            limiter.fingerprints().rejected(fingerprint, now);
        }
        if let Err(retry_after) = limiter.check(Client::Peer(ip), Bucket::AuthFailure, now) {
            return too_many_requests(retry_after);
        }
    } else if let (Some(fingerprint), Some(DeviceId(device))) =
        (fingerprint, response.extensions().get::<DeviceId>())
    {
        limiter.fingerprints().verified(fingerprint, *device, now);
    }
    response
}

/// The device token a request carries, read where the auth layer reads it:
/// the subprotocol entry of an upgrade to a known WebSocket route, otherwise
/// the bearer header.
fn presented_token(request: &Request) -> Option<&str> {
    if is_websocket_upgrade(request) && is_known_ws_path(request.uri().path()) {
        return presented_ws_token(request.headers());
    }
    request.headers().get(AUTH_HEADER)?.to_str().ok()
}
