use axum::{
    extract::{Request, State},
    http::header,
    middleware::Next,
    response::Response,
};

use super::response::{misdirected, unauthorized};
use crate::app_state::AppState;

/// Non-CORS-safelisted header name, so any cross-origin `fetch` must trigger
/// a preflight — which our CORS layer denies.
pub const AUTH_HEADER: &str = "x-cadencr-token";
pub const MCP_CONTROL_HEADER: &str = "x-cadencr-mcp-token";

pub async fn auth_middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if !is_allowed_host(&request, state.port) {
        return misdirected();
    }

    // Browser WebSocket clients can't set custom headers; they authenticate
    // via Sec-WebSocket-Protocol, validated inside the upgrade handler.
    if is_websocket_upgrade(&request) {
        return next.run(request).await;
    }

    if request.uri().path().starts_with("/internal/mcp/") {
        let presented = request
            .headers()
            .get(MCP_CONTROL_HEADER)
            .and_then(|v| v.to_str().ok());
        if presented != Some(state.mcp_control_token.as_str()) {
            return unauthorized();
        }
        return next.run(request).await;
    }

    let presented = request
        .headers()
        .get(AUTH_HEADER)
        .and_then(|v| v.to_str().ok());

    if presented != Some(state.auth_token.as_str()) {
        return unauthorized();
    }

    next.run(request).await
}

pub(crate) fn is_websocket_upgrade(request: &Request) -> bool {
    request
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// DNS-rebinding defense: `Host` must name the loopback interface and carry
/// our bound port. Absent `Host` is rejected — HTTP/1.1 requires it.
fn is_allowed_host(request: &Request, expected_port: u16) -> bool {
    let Some(host) = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some((hostname, Some(port))) = split_host_port(host) else {
        return false;
    };
    port == expected_port && matches!(hostname, "127.0.0.1" | "localhost" | "[::1]")
}

/// Per RFC 7230 §5.4 a `Host` is `uri-host [":" port]` where `uri-host` may
/// be an IP-literal (`[::1]`), so naive `split(':')` would misparse IPv6.
fn split_host_port(host: &str) -> Option<(&str, Option<u16>)> {
    if let Some(end) = host.rfind(']') {
        let hostname = &host[..=end];
        let rest = &host[end + 1..];
        if rest.is_empty() {
            return Some((hostname, None));
        }
        let port_str = rest.strip_prefix(':')?;
        let port = port_str.parse::<u16>().ok()?;
        Some((hostname, Some(port)))
    } else {
        match host.rsplit_once(':') {
            Some((hostname, port_str)) => {
                let port = port_str.parse::<u16>().ok()?;
                Some((hostname, Some(port)))
            }
            None => Some((host, None)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request as HttpRequest, http::StatusCode, routing::get, Router};
    use tower::ServiceExt;

    const TEST_PORT: u16 = 5005;

    async fn app_with_token(token: &str) -> Router {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("pool");
        let mut state = AppState::with_pool(pool);
        state.auth_token = token.to_string();
        state.port = TEST_PORT;
        Router::new()
            .route("/api/health", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            ))
            .with_state(state)
    }

    fn req_builder() -> axum::http::request::Builder {
        HttpRequest::builder()
            .uri("/api/health")
            .header(header::HOST, format!("127.0.0.1:{TEST_PORT}"))
    }

    fn get_req() -> HttpRequest<Body> {
        req_builder().body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn rejects_missing_token_when_configured() {
        let resp = app_with_token("secret")
            .await
            .oneshot(get_req())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn internal_mcp_accepts_control_token() {
        let app = app_with_token("ui-secret").await;
        let req = HttpRequest::builder()
            .uri("/internal/mcp/project/context")
            .header(header::HOST, format!("127.0.0.1:{TEST_PORT}"))
            .header(MCP_CONTROL_HEADER, "test-mcp-token")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn accepts_matching_token() {
        let req = req_builder()
            .header(AUTH_HEADER, "secret")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn rejects_wrong_token() {
        let req = req_builder()
            .header(AUTH_HEADER, "wrong")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn internal_mcp_requires_control_token_not_ui_token() {
        let app = app_with_token("ui-secret").await;
        let req = HttpRequest::builder()
            .uri("/internal/mcp/project/context")
            .header(header::HOST, format!("127.0.0.1:{TEST_PORT}"))
            .header(AUTH_HEADER, "ui-secret")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn skips_ws_upgrades() {
        let req = req_builder()
            .header(header::UPGRADE, "websocket")
            .header(header::CONNECTION, "Upgrade")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn rejects_unknown_host_with_misdirected() {
        let req = HttpRequest::builder()
            .uri("/api/health")
            .header(header::HOST, "attacker.example")
            .header(AUTH_HEADER, "secret")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
    }

    #[tokio::test]
    async fn rejects_missing_host_header() {
        let req = HttpRequest::builder()
            .uri("/api/health")
            .header(AUTH_HEADER, "secret")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
    }

    #[tokio::test]
    async fn accepts_localhost_host() {
        let req = HttpRequest::builder()
            .uri("/api/health")
            .header(header::HOST, format!("localhost:{TEST_PORT}"))
            .header(AUTH_HEADER, "secret")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn accepts_ipv6_loopback_host() {
        let req = HttpRequest::builder()
            .uri("/api/health")
            .header(header::HOST, format!("[::1]:{TEST_PORT}"))
            .header(AUTH_HEADER, "secret")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn rejects_loopback_with_wrong_port() {
        let req = HttpRequest::builder()
            .uri("/api/health")
            .header(header::HOST, "127.0.0.1:80")
            .header(AUTH_HEADER, "secret")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
    }

    #[tokio::test]
    async fn rejects_loopback_without_port() {
        let req = HttpRequest::builder()
            .uri("/api/health")
            .header(header::HOST, "127.0.0.1")
            .header(AUTH_HEADER, "secret")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
    }
}
