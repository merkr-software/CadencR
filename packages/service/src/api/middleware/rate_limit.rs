//! Per-IP fixed-window rate limiting for loopback and remote listeners.
//!
//! The pairing endpoint is pre-auth and brute-forceable (a short pairing code
//! is the only secret), so it gets a tight bucket; everything else gets a loose
//! bucket that bounds general abuse. State is in-memory and lives for the life
//! of one listener (each router receives its own limiter), keyed by source IP
//! from `ConnectInfo<SocketAddr>`.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;
use axum::Extension;

use super::response::too_many_requests;

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
            Bucket::General => GENERAL_LIMIT,
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
    let ip = client_ip(&request);
    if let Err(retry_after) = limiter.check(ip, bucket, Instant::now()) {
        return too_many_requests(retry_after);
    }
    next.run(request).await
}

/// Source IP from the connection info axum injects via
/// `into_make_service_with_connect_info`. Falls back to an unspecified address
/// (all such requests then share one bucket) if it's somehow absent.
fn client_ip(request: &Request) -> IpAddr {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]))
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
