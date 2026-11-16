use super::response::{misdirected, unauthorized};
use crate::app_state::AppState;
use crate::domain::mcp::control_grant::McpControlGrant;
use crate::domain::plugin_tabs::principal::{self, PLUGIN_TOKEN_HEADER};
use crate::domain::visual_frame::VISUAL_FRAME_PATH;
use crate::error::AppError;
use crate::shared::security::constant_time_str_eq;
use axum::{
    extract::{Request, State},
    http::{header, request::Parts, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

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

    // The static visual sandbox shell loads in an iframe, which cannot present
    // the token; the Host check above still applies.
    if request.uri().path() == VISUAL_FRAME_PATH {
        return next.run(request).await;
    }

    // Only known WebSocket routes authenticate inside their upgrade handler.
    // An Upgrade header on an ordinary API route must not bypass token checks.
    if is_websocket_upgrade(&request) && is_known_loopback_ws_path(request.uri().path()) {
        return next.run(request).await;
    }

    if request.uri().path().starts_with("/internal/mcp/") {
        return match authorize_mcp_control(&state, request).await {
            Ok(request) => next.run(request).await,
            Err(response) => response,
        };
    }

    if request.headers().contains_key(PLUGIN_TOKEN_HEADER) {
        let (mut parts, body) = request.into_parts();
        return match authorize_plugin(&state, &mut parts).await {
            Ok(principal) => {
                parts.extensions.insert(principal);
                next.run(Request::from_parts(parts, body)).await
            }
            Err(error) => error.into_response(),
        };
    }

    let presented = request
        .headers()
        .get(AUTH_HEADER)
        .and_then(|v| v.to_str().ok());

    if !presented.is_some_and(|value| constant_time_str_eq(value, &state.auth_token)) {
        return unauthorized();
    }

    next.run(request).await
}

/// Largest control request body the middleware reads to check its source:
/// axum's default `Json` limit, which the control handlers keep.
const MAX_MCP_CONTROL_BODY_BYTES: usize = 2 * 1024 * 1024;

/// A Cadencr MCP subprocess's control grant: 401 without a valid one, 403
/// `MCP_CONTROL_OUT_OF_SCOPE` when the request names another source or calls
/// another server's route, 400 `MCP_CONTROL_REQUEST_INVALID` when its source
/// cannot be read. The request comes back with its body restored.
async fn authorize_mcp_control(state: &AppState, request: Request) -> Result<Request, Response> {
    let grant = McpControlGrant::from_headers(request.headers(), &state.mcp_control_secret)
        .ok_or_else(unauthorized)?;
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, MAX_MCP_CONTROL_BODY_BYTES)
        .await
        .map_err(|_| {
            AppError::coded(
                StatusCode::PAYLOAD_TOO_LARGE,
                "MCP_CONTROL_BODY_TOO_LARGE",
                "control request body is unreadable or too large",
            )
            .into_response()
        })?;
    grant
        .check_request(&parts.uri, &bytes)
        .map_err(IntoResponse::into_response)?;
    Ok(Request::from_parts(parts, axum::body::Body::from(bytes)))
}

/// A custom tab's grant token (`docs/CUSTOM_TABS.md` §4.3): either it or the
/// main token, never both — a request presenting both is ambiguous about whose
/// authority it carries.
async fn authorize_plugin(
    state: &AppState,
    parts: &mut Parts,
) -> Result<principal::PluginPrincipal, AppError> {
    if parts.headers.contains_key(AUTH_HEADER) {
        return Err(AppError::coded(
            StatusCode::BAD_REQUEST,
            "PLUGIN_TOKEN_CONFLICT",
            "send either x-cadencr-token or x-cadencr-plugin-token, not both",
        ));
    }
    let token = parts
        .headers
        .get(PLUGIN_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    principal::authorize(&state.plugin_tab_grants, &token, parts).await
}

pub(crate) fn is_websocket_upgrade(request: &Request) -> bool {
    request
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// The routes that self-authenticate via `middleware::authenticate_ws`.
/// A new socket route must be added deliberately and wired to that check.
pub(super) fn is_known_ws_path(path: &str) -> bool {
    path == "/ws"
        || path == "/api/terminal/ws"
        || path == "/api/neovim/ws"
        || (path.starts_with("/api/lsp/sessions/") && path.ends_with("/connect"))
}

/// The loopback listener also hosts the plugin socket (self-authenticated by
/// its `cadencr-plugin.<token>` subprotocol). It is deliberately not in
/// [`is_known_ws_path`], which the remote listener shares: there the path is
/// unrouted and would otherwise reach `GET /api/plugin-tabs/{id}` unauthenticated.
fn is_known_loopback_ws_path(path: &str) -> bool {
    is_known_ws_path(path) || path == crate::domain::plugin_tabs::socket::SOCKET_PATH
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
    use axum::{
        body::Body,
        http::{Request as HttpRequest, StatusCode},
        routing::{get, post},
        Router,
    };
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
            .route(
                "/api/projects/1/publication-release",
                post(|| async { "ok" }),
            )
            .route("/ws", get(|| async { "ok" }))
            // Reads its source like the real control handlers do.
            .route(
                "/internal/mcp/project/send-message",
                post(|axum::Json(probe): axum::Json<ControlProbe>| async move {
                    format!("{}/{}", probe.source_feature_id, probe.source_session_id)
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            ))
            .with_state(state)
    }

    #[derive(serde::Deserialize)]
    struct ControlProbe {
        source_feature_id: i64,
        source_session_id: i64,
    }

    fn req_builder() -> axum::http::request::Builder {
        HttpRequest::builder()
            .uri("/api/health")
            .header(header::HOST, format!("127.0.0.1:{TEST_PORT}"))
    }

    fn get_req() -> HttpRequest<Body> {
        req_builder().body(Body::empty()).unwrap()
    }

    const CONTEXT_URI: &str = "/internal/mcp/project/context?feature_id=42&source_session_id=777";

    /// The project MCP grant of feature 42 / session 777 in a test state.
    fn control_token() -> String {
        McpControlGrant {
            server: crate::domain::mcp::control_grant::McpControlServer::Project,
            feature_id: 42,
            session_id: 777,
        }
        .mint("test-mcp-secret")
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
            .uri(CONTEXT_URI)
            .header(header::HOST, format!("127.0.0.1:{TEST_PORT}"))
            .header(MCP_CONTROL_HEADER, control_token())
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
            .uri(CONTEXT_URI)
            .header(header::HOST, format!("127.0.0.1:{TEST_PORT}"))
            .header(AUTH_HEADER, "ui-secret")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn skips_known_ws_upgrades() {
        let req = req_builder()
            .uri("/ws")
            .header(header::UPGRADE, "websocket")
            .header(header::CONNECTION, "Upgrade")
            .body(Body::empty())
            .unwrap();
        let resp = app_with_token("secret").await.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn ordinary_api_cannot_bypass_auth_with_upgrade() {
        let app = app_with_token("secret").await;
        for (method, path) in [
            ("GET", "/api/health"),
            ("POST", "/api/projects/1/publication-release"),
        ] {
            for token in [None, Some("wrong"), Some("secret")] {
                let mut builder = req_builder()
                    .method(method)
                    .uri(path)
                    .header(header::UPGRADE, "websocket")
                    .header(header::CONNECTION, "Upgrade");
                if let Some(token) = token {
                    builder = builder.header(AUTH_HEADER, token);
                }
                let response = app
                    .clone()
                    .oneshot(builder.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    if token == Some("secret") {
                        StatusCode::OK
                    } else {
                        StatusCode::UNAUTHORIZED
                    },
                    "{method} {path} must still validate the token"
                );
            }
        }
    }

    #[tokio::test]
    async fn internal_mcp_cannot_bypass_auth_with_upgrade() {
        let app = app_with_token("ui-secret").await;
        let granted = control_token();
        for token in [None, Some("ui-secret"), Some(granted.as_str())] {
            let mut builder = req_builder()
                .method("POST")
                .uri(CONTEXT_URI)
                .header(header::UPGRADE, "websocket");
            if let Some(token) = token {
                builder = builder.header(MCP_CONTROL_HEADER, token);
            }
            let response = app
                .clone()
                .oneshot(builder.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                if token == Some(granted.as_str()) {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::UNAUTHORIZED
                }
            );
        }
    }

    #[tokio::test]
    async fn internal_mcp_holds_a_grant_to_its_source_and_server() {
        let app = app_with_token("ui-secret").await;
        let call = |uri: &str, token: String, body: serde_json::Value| {
            req_builder()
                .method("POST")
                .uri(uri)
                .header(MCP_CONTROL_HEADER, token)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let own = serde_json::json!({"source_feature_id": 42, "source_session_id": 777});
        let cases = [
            // Its own source on its own server reaches the handler.
            (
                "/internal/mcp/project/send-message",
                control_token(),
                own.clone(),
                StatusCode::OK,
            ),
            // Another session or feature named in the body.
            (
                "/internal/mcp/project/send-message",
                control_token(),
                serde_json::json!({"source_feature_id": 42, "source_session_id": 1}),
                StatusCode::FORBIDDEN,
            ),
            (
                "/internal/mcp/project/send-message",
                control_token(),
                serde_json::json!({"source_feature_id": 1, "source_session_id": 777}),
                StatusCode::FORBIDDEN,
            ),
            // The workspace routes need the workspace server's grant.
            (
                "/internal/mcp/workspace/send-message",
                control_token(),
                own.clone(),
                StatusCode::FORBIDDEN,
            ),
            (
                "/internal/mcp/workspace/update-settings",
                control_token(),
                own.clone(),
                StatusCode::FORBIDDEN,
            ),
            // The process secret itself is not a grant.
            (
                "/internal/mcp/project/send-message",
                "test-mcp-secret".into(),
                own,
                StatusCode::UNAUTHORIZED,
            ),
        ];
        for (uri, token, body, expected) in cases {
            let response = app
                .clone()
                .oneshot(call(uri, token, body.clone()))
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "{uri} {body}");
        }

        // A body only the handler's serde could read (invalid UTF-8 in an
        // ignored field) names session 555; the query names the grant's own.
        let mut foreign = br#"{"source_feature_id":42,"source_session_id":555,"x":""#.to_vec();
        foreign.extend_from_slice(&[0xFF, b'"', b'}']);
        let response = app
            .oneshot(
                req_builder()
                    .method("POST")
                    .uri("/internal/mcp/project/send-message?source_session_id=777&feature_id=42")
                    .header(MCP_CONTROL_HEADER, control_token())
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(foreign))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(
            response.status(),
            StatusCode::OK,
            "spoke for another session"
        );
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
