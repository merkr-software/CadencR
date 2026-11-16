//! `GET /visual-frame`: the sandbox shell agent-drawn HTML visuals render in.
//!
//! A `cadencr-html` fence in an agent reply becomes an iframe pointed here; the
//! renderer posts the assembled document and the shell writes it over itself.
//! The shell holds no data and needs no credential (an iframe navigation cannot
//! carry `X-Cadencr-Token`), so both listeners serve it outside their auth
//! layers. Containment comes from the response itself, whoever frames it:
//!
//!  - the CSP `sandbox allow-scripts` directive gives the document an opaque
//!    origin even when the embedder omits the iframe `sandbox` attribute, so it
//!    can never read the app origin's storage (the remote SPA's device token);
//!  - `connect-src 'none'` and data-only images and fonts keep it offline;
//!  - no forms, popups, plugins, workers or nested frames.

use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

/// Path of the shell. The remote security-headers layer leaves this path's own
/// CSP in place, and the Electron shell exempts it from its renderer CSP.
pub const VISUAL_FRAME_PATH: &str = "/visual-frame";

const FRAME_HTML: &str = include_str!("frame.html");

pub const CONTENT_SECURITY_POLICY: &str = "sandbox allow-scripts; default-src 'none'; \
script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; \
font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; \
worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// The public route, merged into both routers outside their auth layers.
pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new().route(VISUAL_FRAME_PATH, get(serve))
}

async fn serve() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CONTENT_SECURITY_POLICY),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        ],
        FRAME_HTML,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn get_frame(router: Router, host: &str) -> Response {
        router
            .oneshot(
                Request::get(VISUAL_FRAME_PATH)
                    .header(header::HOST, host)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn serves_the_shell_under_a_sandboxing_offline_csp() {
        let response = get_frame(router(), "127.0.0.1").await;
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(csp.starts_with("sandbox allow-scripts;"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains("form-action 'none'"));
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert!(headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let html = String::from_utf8_lossy(&body);
        assert!(html.contains("cadencr-visual:render"));
        assert!(html.contains("cadencr-visual:ready"));
    }

    #[tokio::test]
    async fn loopback_router_serves_the_shell_without_the_launch_token() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let state = crate::app_state::AppState::with_pool(pool);
        let host = format!("127.0.0.1:{}", state.port);
        let peer = std::net::SocketAddr::from(([127, 0, 0, 1], 40_000));
        let router = crate::api::build_router(state)
            .layer(axum::Extension(axum::extract::ConnectInfo(peer)));

        let frame = get_frame(router.clone(), &host).await;
        assert_eq!(frame.status(), StatusCode::OK);

        // The DNS-rebinding Host check still guards it.
        let rebound = get_frame(router.clone(), "attacker.example").await;
        assert_eq!(rebound.status(), StatusCode::MISDIRECTED_REQUEST);

        // Everything else on loopback still demands the token.
        let api = router
            .oneshot(
                Request::get("/api/projects")
                    .header(header::HOST, host)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(api.status(), StatusCode::UNAUTHORIZED);
    }
}
