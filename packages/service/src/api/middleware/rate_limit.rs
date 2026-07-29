//! Per-IP fixed-window rate limiting for loopback and remote listeners.
//!
//! The pairing endpoint is pre-auth and brute-forceable (a short pairing code
//! is the only secret), so it gets a tight bucket; everything else gets a loose
//! bucket that bounds general abuse. Loopback requests carrying the per-launch
//! credential use a separate bucket so anonymous local traffic cannot starve
//! the authenticated renderer. State is in-memory and lives for the life of one
//! listener (each router receives its own limiter), keyed by source IP from
//! `ConnectInfo<SocketAddr>`.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;
use axum::{extract::State, Extension};

use super::auth::{is_websocket_upgrade, AUTH_HEADER, MCP_CONTROL_HEADER};
use super::response::{connection_metadata_unavailable, too_many_requests};
use super::ws::validate_ws_token;
use crate::app_state::AppState;
use crate::shared::security::constant_time_str_eq;

const WINDOW: Duration = Duration::from_secs(60);
/// Pairing-code attempts per IP per window. A code is single-use and expires in
/// ~120s, so a legitimate device needs only one or two attempts.
const PAIR_LIMIT: u32 = 5;
/// All other requests per IP per window, counted *before* listener-specific
/// auth, so SPA assets and rejected tokens count too. A client opening the app
/// bursts well past a "reasonable" steady rate — hashed chunks and fonts,
/// agent catalog, per-project settings, git stats, WS handshakes — and tripping
/// this only produced 429s the client retried into. Sized as a runaway backstop
/// rather than a traffic policy; pairing brute-force is bounded separately by
/// `PAIR_LIMIT`.
const GENERAL_LIMIT: u32 = 6000;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Bucket {
    Pair,
    General,
    LoopbackAuthenticated,
}

struct Window {
    start: Instant,
    count: u32,
}

/// In-memory per-(IP, bucket) fixed-window counter.
#[derive(Default)]
pub struct RateLimiter {
    windows: Mutex<HashMap<(IpAddr, Bucket), Window>>,
}

impl RateLimiter {
    /// Record a hit and report whether it is within the bucket's limit. Returns
    /// `Err(retry_after_secs)` when the limit is exceeded.
    fn check(&self, ip: IpAddr, bucket: Bucket, now: Instant) -> Result<(), u64> {
        let limit = match bucket {
            Bucket::Pair => PAIR_LIMIT,
            Bucket::General | Bucket::LoopbackAuthenticated => GENERAL_LIMIT,
        };
        let mut windows = self.windows.lock().expect("rate-limit mutex poisoned");
        // Bound map growth: drop windows that have fully elapsed.
        windows.retain(|_, w| now.duration_since(w.start) < WINDOW);

        let window = windows.entry((ip, bucket)).or_insert(Window {
            start: now,
            count: 0,
        });
        if now.duration_since(window.start) >= WINDOW {
            window.start = now;
            window.count = 0;
        }
        window.count += 1;
        if window.count > limit {
            let retry = WINDOW
                .saturating_sub(now.duration_since(window.start))
                .as_secs()
                .max(1);
            return Err(retry);
        }
        Ok(())
    }
}

/// Middleware: rate-limit by source IP, with a tight bucket for `POST
/// /api/remote/pair`. Runs outside the auth/host checks so abuse is shed early.
pub async fn rate_limit_middleware(
    Extension(limiter): Extension<std::sync::Arc<RateLimiter>>,
    request: Request,
    next: Next,
) -> Response {
    let bucket = if request.method() == Method::POST && request.uri().path() == "/api/remote/pair" {
        Bucket::Pair
    } else {
        Bucket::General
    };
    apply_limit(&limiter, bucket, request, next).await
}

/// Loopback middleware with credential-isolated buckets. The rate limit still
/// runs before auth so rejected requests and tokenless upgrades are bounded,
/// but they cannot consume the renderer's authenticated allowance.
pub async fn loopback_rate_limit_middleware(
    State(state): State<AppState>,
    Extension(limiter): Extension<std::sync::Arc<RateLimiter>>,
    request: Request,
    next: Next,
) -> Response {
    let bucket = if has_valid_loopback_credential(&request, &state) {
        Bucket::LoopbackAuthenticated
    } else {
        Bucket::General
    };
    apply_limit(&limiter, bucket, request, next).await
}

async fn apply_limit(
    limiter: &RateLimiter,
    bucket: Bucket,
    request: Request,
    next: Next,
) -> Response {
    let Some(ip) = client_ip(&request) else {
        tracing::error!("rate limiter missing peer connection metadata");
        return connection_metadata_unavailable();
    };
    if let Err(retry_after) = limiter.check(ip, bucket, Instant::now()) {
        return too_many_requests(retry_after);
    }
    next.run(request).await
}

fn has_valid_loopback_credential(request: &Request, state: &AppState) -> bool {
    if is_websocket_upgrade(request) {
        return validate_ws_token(request.headers(), &state.auth_token).is_ok();
    }

    let (header, expected) = if request.uri().path().starts_with("/internal/mcp/") {
        (MCP_CONTROL_HEADER, state.mcp_control_token.as_str())
    } else {
        (AUTH_HEADER, state.auth_token.as_str())
    };
    request
        .headers()
        .get(header)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|presented| constant_time_str_eq(presented, expected))
}

/// Source IP from the connection info axum injects via
/// `into_make_service_with_connect_info`. Missing metadata is a server wiring
/// error rather than a shared fallback bucket that one caller could exhaust.
fn client_ip(request: &Request) -> Option<IpAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u8) -> IpAddr {
        IpAddr::from([10, 0, 0, n])
    }

    #[test]
    fn pair_bucket_trips_after_limit() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        for _ in 0..PAIR_LIMIT {
            assert!(limiter.check(ip(1), Bucket::Pair, now).is_ok());
        }
        assert!(
            limiter.check(ip(1), Bucket::Pair, now).is_err(),
            "6th pair attempt is limited"
        );
    }

    /// The general bucket has to absorb a phone's cold-open burst (SPA assets
    /// plus a few hundred API calls) without shedding; only a runaway loop
    /// should reach it.
    #[test]
    fn general_bucket_absorbs_a_client_burst_then_trips() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        for i in 0..GENERAL_LIMIT {
            assert!(
                limiter.check(ip(1), Bucket::General, now).is_ok(),
                "request {i} is within the general limit"
            );
        }
        assert!(
            limiter.check(ip(1), Bucket::General, now).is_err(),
            "the general bucket still has a ceiling"
        );
    }

    #[test]
    fn buckets_and_ips_are_independent() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        for _ in 0..PAIR_LIMIT {
            let _ = limiter.check(ip(1), Bucket::Pair, now);
        }
        // A different IP and a different bucket are unaffected.
        assert!(limiter.check(ip(2), Bucket::Pair, now).is_ok());
        assert!(limiter.check(ip(1), Bucket::General, now).is_ok());
        assert!(limiter
            .check(ip(1), Bucket::LoopbackAuthenticated, now)
            .is_ok());
    }

    #[test]
    fn window_resets_after_elapse() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        for _ in 0..PAIR_LIMIT {
            let _ = limiter.check(ip(1), Bucket::Pair, now);
        }
        assert!(limiter.check(ip(1), Bucket::Pair, now).is_err());
        let later = now + WINDOW + Duration::from_secs(1);
        assert!(
            limiter.check(ip(1), Bucket::Pair, later).is_ok(),
            "window resets after elapse"
        );
    }
}
