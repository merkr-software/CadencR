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

use super::auth::{is_known_ws_path, is_websocket_upgrade};
use super::response::{misdirected, unauthorized};
use super::AUTH_HEADER;
use crate::app_state::AppState;
use crate::domain::remote::tokens;
use crate::remote::RemoteContext;

/// The authenticated device id, injected as a request extension by
/// [`remote_auth_middleware`] once a device token verifies. Handlers on the
/// remote router (e.g. push-subscription endpoints) read it via
/// `Extension<DeviceId>` to key per-device state; the response carries it too
/// (read by the remote rate limiter). Absent on bearer-exempt paths
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
    let Some(device_id) = tokens::verify_device_token(
        state.remote.token_cache(),
        &state.read_pool,
        &ctx.pepper,
        token,
    )
    .await
    else {
        return unauthorized();
    };

    // Expose the verified device id so downstream handlers (push subscription)
    // can key per-device state without re-hashing the token, and on the
    // response so the rate limiter can give the device its own budget.
    request.extensions_mut().insert(DeviceId(device_id));
    let mut response = next.run(request).await;
    response.extensions_mut().insert(DeviceId(device_id));
    response
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
        assert!(is_known_ws_path("/api/neovim/ws"));
        assert!(is_known_ws_path("/api/lsp/sessions/abc-123/connect"));
        // A future WS route is NOT auto-exempt — it must be added here, which is
        // the prompt to also wire it through `authenticate_ws`.
        assert!(!is_known_ws_path("/api/some/new/socket"));
        assert!(!is_known_ws_path("/api/lsp/sessions/abc-123"));
        assert!(!is_known_ws_path("/api/git/status"));
    }

    #[tokio::test]
    async fn cached_device_token_hits_cache_and_is_invalidated_immediately_by_revoke_handler() {
        use std::sync::Arc;

        use axum::{
            body::Body,
            extract::{Path, State},
            http::{header, Request, StatusCode},
            middleware,
            routing::get,
            Extension, Router,
        };
        use tower::ServiceExt;

        use crate::app_state::AppState;
        use crate::domain::remote::{repo, routes::revoke_handler, tokens};
        use crate::remote::RemoteContext;

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE remote_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, \
             token_hash TEXT NOT NULL UNIQUE, label TEXT, \
             created_at TEXT NOT NULL DEFAULT (datetime('now')), \
             last_seen_at TEXT, revoked_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE remote_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, \
             event TEXT NOT NULL, device_id INTEGER, detail TEXT, \
             created_at TEXT NOT NULL DEFAULT (datetime('now')))",
        )
        .execute(&pool)
        .await
        .unwrap();

        let pepper = Arc::new(b"middleware-cache-test-pepper".to_vec());
        let raw_token = tokens::mint_raw_token();
        let device_id = repo::insert_device(&pool, &tokens::hash_token(&pepper, &raw_token), "mac")
            .await
            .unwrap();

        let state = AppState::with_pool(pool.clone());
        let ctx = RemoteContext {
            allowed_hosts: Arc::new(vec!["remote.test".to_string()]),
            allowed_origins: Arc::new(vec!["https://remote.test".to_string()]),
            pepper: Arc::clone(&pepper),
        };
        let app = Router::new()
            .route("/api/ping", get(|| async { StatusCode::OK }))
            .layer(middleware::from_fn_with_state(
                state.clone(),
                super::remote_auth_middleware,
            ))
            .layer(Extension(ctx));

        let make_req = |token: &str| {
            Request::builder()
                .uri("/api/ping")
                .header(header::HOST, "remote.test")
                .header(super::AUTH_HEADER, token)
                .body(Body::empty())
                .unwrap()
        };

        // 1. First request misses cache, hits DB, succeeds, and caches.
        let resp = app.clone().oneshot(make_req(&raw_token)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // 2. Delete the row directly behind the cache to prove the second
        //    request is served purely from the in-memory cache (0 DB queries).
        //    Then restore it before testing `revoke_handler`.
        sqlx::query("UPDATE remote_devices SET revoked_at = datetime('now') WHERE id = ?")
            .bind(device_id)
            .execute(&pool)
            .await
            .unwrap();
        let cached_resp = app.clone().oneshot(make_req(&raw_token)).await.unwrap();
        assert_eq!(cached_resp.status(), StatusCode::OK, "expected cache hit");

        sqlx::query("UPDATE remote_devices SET revoked_at = NULL WHERE id = ?")
            .bind(device_id)
            .execute(&pool)
            .await
            .unwrap();

        // 3. `revoke_handler` synchronously evicts the cached token.
        let _ = revoke_handler(State(state), Path(device_id))
            .await
            .expect("revoke succeeds");
        let after_revoke = app.oneshot(make_req(&raw_token)).await.unwrap();
        assert_eq!(after_revoke.status(), StatusCode::UNAUTHORIZED);
    }
}
