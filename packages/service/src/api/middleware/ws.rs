use axum::{
    http::{header, HeaderMap},
    response::Response,
};

use super::response::{forbidden, unauthorized};
use crate::app_state::AppState;
use crate::remote::RemoteContext;
use crate::shared::security::constant_time_str_eq;

const WS_TOKEN_PREFIX: &str = "cadencr-token.";

/// Authenticate a WebSocket upgrade for whichever listener it arrived on.
/// Returns the optional subprotocol to echo back (the browser rejects the handshake
/// unless the server reflects it) plus, on the remote listener, the
/// authenticated device id (used for revoke force-close + audit) — `None` on
/// loopback, which trusts the launch token.
///
/// `remote` is `Some` only on the network listener (its `RemoteContext` is
/// injected as an extension); its absence means the loopback listener.
/// **Every** WS route (`/ws`, the terminal, the LSP proxy) must go through this
/// one helper: the remote auth middleware deliberately lets WS upgrades past the
/// bearer check (browsers can't set custom headers on an upgrade), so a route
/// that authenticated WS itself — rather than here — could silently accept the
/// wrong credential on the wrong listener.
pub async fn authenticate_ws(
    headers: &HeaderMap,
    state: &AppState,
    remote: Option<&RemoteContext>,
) -> Result<(Option<String>, Option<i64>), Response> {
    match remote {
        None => {
            validate_ws_origin(headers, state.frontend_port)?;
            // Electron main and the development proxy add this header outside
            // renderer JavaScript. Never echo it as a subprotocol: JS can read
            // WebSocket.protocol after the upgrade.
            if let Some(token) = headers.get(super::auth::AUTH_HEADER) {
                if token
                    .to_str()
                    .is_ok_and(|token| constant_time_str_eq(token, &state.auth_token))
                {
                    return Ok((None, None));
                }
                return Err(unauthorized());
            }
            let proto = validate_ws_token(headers, &state.auth_token)?;
            Ok((Some(proto.to_string()), None))
        }
        Some(ctx) => {
            validate_ws_origin_remote(headers, &ctx.allowed_origins)?;
            let (proto, device_id) =
                validate_ws_token_remote(headers, &state.read_pool, &ctx.pepper).await?;
            Ok((Some(proto), Some(device_id)))
        }
    }
}

/// CORS doesn't apply to WebSockets; this is the only gate against drive-by
/// upgrades. Non-browser clients may omit `Origin` — they still must present
/// the bearer token via subprotocol.
pub fn validate_ws_origin(headers: &HeaderMap, frontend_port: u16) -> Result<(), Response> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(());
    };
    let origin = match origin.to_str() {
        Ok(s) => s,
        Err(_) => return Err(forbidden("invalid origin")),
    };
    if is_allowed_ws_origin(origin, frontend_port) {
        Ok(())
    } else {
        Err(forbidden("origin not allowed"))
    }
}

fn is_allowed_ws_origin(origin: &str, frontend_port: u16) -> bool {
    // Packaged Electron renderers connect from file:// and may present a
    // serialized `null` origin. This broadens origin acceptance only for the
    // local desktop shell; the per-launch WebSocket token remains the real
    // authorization gate.
    if origin == "file://" || origin == "null" {
        return true;
    }
    if !cfg!(debug_assertions) {
        return false;
    }

    origin == format!("http://localhost:{frontend_port}")
        || origin == format!("http://127.0.0.1:{frontend_port}")
}

/// Returns the matched subprotocol string. The caller MUST echo it back via
/// `WebSocketUpgrade::protocols`, or the browser rejects the handshake.
pub fn validate_ws_token<'a>(
    headers: &'a HeaderMap,
    expected_token: &str,
) -> Result<&'a str, Response> {
    offered_subprotocols(headers)
        .find(|offered| {
            offered
                .strip_prefix(WS_TOKEN_PREFIX)
                .is_some_and(|rest| constant_time_str_eq(rest, expected_token))
        })
        .ok_or_else(unauthorized)
}

/// Every subprotocol the client offered. `Sec-WebSocket-Protocol` can be a
/// single comma-list or repeated headers; non-UTF-8 values are skipped.
pub fn offered_subprotocols(headers: &HeaderMap) -> impl Iterator<Item = &str> {
    headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
}

/// The token a WebSocket upgrade presents in its `cadencr-token.<token>`
/// subprotocol, unverified.
pub(super) fn presented_ws_token(headers: &HeaderMap) -> Option<&str> {
    offered_subprotocols(headers).find_map(|protocol| protocol.strip_prefix(WS_TOKEN_PREFIX))
}

/// Remote-listener origin check: the served SPA's `Origin` must exactly match
/// one of the listener's `https://<host>` origins. Missing `Origin` (non-browser
/// clients) is allowed — the device token via subprotocol is the real gate.
pub fn validate_ws_origin_remote(
    headers: &HeaderMap,
    allowed_origins: &[String],
) -> Result<(), Response> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(());
    };
    let origin = match origin.to_str() {
        Ok(s) => s,
        Err(_) => return Err(forbidden("invalid origin")),
    };
    if allowed_origins.iter().any(|allowed| allowed == origin) {
        Ok(())
    } else {
        Err(forbidden("origin not allowed"))
    }
}

/// Remote-listener token check: resolve the `cadencr-token.<raw>` subprotocol to
/// an active device id. Returns the matched subprotocol (to echo back) and the
/// device id. Unlike the loopback path, this accepts device tokens only — never
/// the launch token.
pub async fn validate_ws_token_remote(
    headers: &HeaderMap,
    pool: &sqlx::SqlitePool,
    pepper: &[u8],
) -> Result<(String, i64), Response> {
    for token in offered_subprotocols(headers) {
        if let Some(rest) = token.strip_prefix(WS_TOKEN_PREFIX) {
            if let Some(id) =
                crate::domain::remote::tokens::verify_device_token(pool, pepper, rest).await
            {
                return Ok((token.to_string(), id));
            }
        }
    }

    Err(unauthorized())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue, StatusCode};

    fn make_headers(entries: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in entries {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn origin_accepts_desktop_webviews() {
        for origin in ["file://", "null"] {
            let h = make_headers(&[("origin", origin)]);
            assert!(validate_ws_origin(&h, 1420).is_ok());
        }
    }

    #[test]
    fn origin_accepts_dev_server_in_debug() {
        let h = make_headers(&[("origin", "http://localhost:1420")]);
        assert!(validate_ws_origin(&h, 1420).is_ok());
    }

    #[test]
    fn origin_rejects_unknown() {
        let h = make_headers(&[("origin", "https://evil.example")]);
        let err = validate_ws_origin(&h, 1420).unwrap_err();
        assert_eq!(err.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn origin_allows_missing() {
        let h = make_headers(&[]);
        assert!(validate_ws_origin(&h, 1420).is_ok());
    }

    #[test]
    fn origin_accepts_custom_debug_port() {
        let h = make_headers(&[("origin", "http://127.0.0.1:4242")]);
        assert!(validate_ws_origin(&h, 4242).is_ok());
    }

    #[test]
    fn token_accepts_matching_subprotocol() {
        let h = make_headers(&[("sec-websocket-protocol", "cadencr-token.secret")]);
        let picked = validate_ws_token(&h, "secret").unwrap();
        assert_eq!(picked, "cadencr-token.secret");
    }

    #[test]
    fn token_accepts_comma_list_with_match() {
        let h = make_headers(&[(
            "sec-websocket-protocol",
            "other-proto, cadencr-token.secret",
        )]);
        assert_eq!(
            validate_ws_token(&h, "secret").unwrap(),
            "cadencr-token.secret"
        );
    }

    #[test]
    fn token_accepts_repeated_header() {
        let h = make_headers(&[
            ("sec-websocket-protocol", "other-proto"),
            ("sec-websocket-protocol", "cadencr-token.secret"),
        ]);
        assert_eq!(
            validate_ws_token(&h, "secret").unwrap(),
            "cadencr-token.secret"
        );
    }

    #[test]
    fn token_rejects_wrong_value() {
        let h = make_headers(&[("sec-websocket-protocol", "cadencr-token.wrong")]);
        let err = validate_ws_token(&h, "secret").unwrap_err();
        assert_eq!(err.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn token_rejects_missing_subprotocol() {
        let h = make_headers(&[]);
        let err = validate_ws_token(&h, "secret").unwrap_err();
        assert_eq!(err.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn remote_origin_matches_served_https_origin() {
        let allowed = vec!["https://192.168.1.5:5006".to_string()];
        let ok = make_headers(&[("origin", "https://192.168.1.5:5006")]);
        assert!(validate_ws_origin_remote(&ok, &allowed).is_ok());

        let bad = make_headers(&[("origin", "https://evil.example")]);
        assert_eq!(
            validate_ws_origin_remote(&bad, &allowed)
                .unwrap_err()
                .status(),
            StatusCode::FORBIDDEN
        );

        // Missing origin (non-browser client) is allowed; the device token gates.
        assert!(validate_ws_origin_remote(&make_headers(&[]), &allowed).is_ok());
    }

    use std::sync::Arc;

    async fn test_state(auth_token: &str) -> AppState {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("pool");
        let mut state = AppState::with_pool(pool);
        state.auth_token = auth_token.into();
        state.frontend_port = 1420;
        state
    }

    fn remote_ctx() -> RemoteContext {
        RemoteContext {
            allowed_hosts: Arc::new(vec!["192.168.1.5:5006".to_string()]),
            allowed_origins: Arc::new(vec!["https://192.168.1.5:5006".to_string()]),
            pepper: Arc::new(vec![0u8; 32]),
        }
    }

    #[tokio::test]
    async fn loopback_ws_accepts_the_launch_token() {
        let state = test_state("launch-token").await;
        let headers = make_headers(&[
            ("origin", "file://"),
            ("sec-websocket-protocol", "cadencr-token.launch-token"),
        ]);
        let (proto, device_id) = authenticate_ws(&headers, &state, None).await.unwrap();
        assert_eq!(proto.as_deref(), Some("cadencr-token.launch-token"));
        assert!(device_id.is_none(), "loopback carries no device id");
    }

    #[tokio::test]
    async fn loopback_header_auth_never_echoes_the_launch_credential() {
        let state = test_state("launch-token").await;
        let headers = make_headers(&[("origin", "file://"), ("x-cadencr-token", "launch-token")]);
        let (protocol, device_id) = authenticate_ws(&headers, &state, None).await.unwrap();
        assert!(
            protocol.is_none(),
            "the bearer must not become WebSocket.protocol"
        );
        assert!(device_id.is_none());
        let wrong = make_headers(&[
            ("x-cadencr-token", "wrong"),
            ("sec-websocket-protocol", "cadencr-token.launch-token"),
        ]);
        assert_eq!(
            authenticate_ws(&wrong, &state, None)
                .await
                .unwrap_err()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn remote_ws_never_accepts_a_launch_header() {
        let state = test_state("launch-token").await;
        let headers = make_headers(&[
            ("origin", "https://192.168.1.5:5006"),
            ("x-cadencr-token", "launch-token"),
        ]);
        assert_eq!(
            authenticate_ws(&headers, &state, Some(&remote_ctx()))
                .await
                .unwrap_err()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn remote_ws_rejects_the_launch_token() {
        // The launch token is loopback-only. On the remote listener it isn't a
        // device token (not in the DB), so the upgrade must be unauthorized —
        // this is the property the shared helper guarantees for every WS route.
        let state = test_state("launch-token").await;
        let ctx = remote_ctx();
        let headers = make_headers(&[
            ("origin", "https://192.168.1.5:5006"),
            ("sec-websocket-protocol", "cadencr-token.launch-token"),
        ]);
        let err = authenticate_ws(&headers, &state, Some(&ctx))
            .await
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn remote_ws_rejects_a_foreign_origin() {
        let state = test_state("launch-token").await;
        let ctx = remote_ctx();
        let headers = make_headers(&[
            ("origin", "https://evil.example"),
            ("sec-websocket-protocol", "cadencr-token.whatever"),
        ]);
        let err = authenticate_ws(&headers, &state, Some(&ctx))
            .await
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::FORBIDDEN);
    }
}
