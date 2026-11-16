//! Security response headers for the network (remote) listener.
//!
//! The remote SPA holds a device token in browser storage, so it's served with
//! a strict CSP plus hardening headers to blunt token exfiltration via injected
//! or XSS content. This is layered outermost on the remote router so it covers
//! every response, including 401/429 short-circuits and static SPA assets. The
//! loopback listener is untouched — the Electron shell sets its own CSP.

use axum::extract::Request;
use axum::http::{header, HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;

/// Same-origin network CSP, built per-request so `connect-src` can name the exact
/// `wss://<host>` origin in addition to `'self'`. Modern browsers treat
/// same-origin `wss:` as covered by `'self'`, but that was historically
/// inconsistent, so we spell out the WebSocket origin to keep remote streaming
/// robust. CeleriTTY fetches its bundled WASM from a `data:` URL, then compiles
/// it, so both `data:` connections and `'wasm-unsafe-eval'` are needed, just as
/// in the packaged Electron renderer CSP. JavaScript eval stays disabled.
/// The Office document preview starts its parser workers from `blob:` URLs the
/// library mints itself, hence `worker-src 'self' blob:` (`script-src` keeps
/// refusing `blob:`), matching the Electron renderer CSP.
/// When the `Host` is missing or malformed we omit the WebSocket origin (the
/// request is about to be 421'd by the auth layer anyway).
fn content_security_policy(host: Option<&str>) -> String {
    let connect = match host.filter(|h| is_plain_host(h)) {
        Some(host) => format!("connect-src 'self' data: wss://{host}"),
        None => "connect-src 'self' data:".to_string(),
    };
    format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; {connect}; \
         object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    )
}

/// Conservative check that a `Host` value is a bare host[:port] before it's
/// interpolated into the CSP. Rejects anything with spaces or odd characters so
/// a weird `Host` can't produce a malformed (or injected) policy.
fn is_plain_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
}

/// Disable browser capabilities the workspace UI never legitimately needs from a
/// remote tab, so injected content can't reach for them either.
const PERMISSIONS_POLICY: &str = "camera=(), microphone=(), geolocation=(), payment=()";

pub async fn remote_security_headers_middleware(request: Request, next: Next) -> Response {
    let csp = content_security_policy(
        request
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok()),
    );
    // The visual sandbox shell is framed by the SPA and carries its own,
    // stricter sandboxing CSP (`domain::visual_frame`); the SPA policy's
    // `frame-ancestors 'none'` and X-Frame-Options would refuse the frame.
    let framed = request.uri().path() == crate::domain::visual_frame::VISUAL_FRAME_PATH;
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if !framed {
        if let Ok(value) = HeaderValue::from_str(&csp) {
            headers.insert(header::CONTENT_SECURITY_POLICY, value);
        }
        // CSP `frame-ancestors 'none'` already blocks framing; X-Frame-Options is the
        // legacy-browser belt to that suspenders.
        headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static(PERMISSIONS_POLICY),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    fn app() -> Router {
        Router::new()
            .route("/", get(|| async { "ok" }))
            .merge(crate::domain::visual_frame::router())
            .layer(axum::middleware::from_fn(
                remote_security_headers_middleware,
            ))
    }

    #[tokio::test]
    async fn sets_csp_and_hardening_headers() {
        let resp = app()
            .oneshot(
                HttpRequest::builder()
                    .uri("/")
                    .header(header::HOST, "192.168.1.5:5006")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let headers = resp.headers();
        let csp = headers
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            csp.contains("default-src 'self'"),
            "CSP must be same-origin"
        );
        // The exact same-origin wss origin is named so remote WebSocket streaming
        // works even on browsers that don't treat wss as covered by 'self'.
        assert!(
            csp.contains("connect-src 'self' data: wss://192.168.1.5:5006"),
            "CSP must name the same-origin wss endpoint: {csp}"
        );
        assert_eq!(
            headers.get(header::X_CONTENT_TYPE_OPTIONS).unwrap(),
            "nosniff"
        );
        assert_eq!(headers.get(header::X_FRAME_OPTIONS).unwrap(), "DENY");
        assert!(headers.get("permissions-policy").is_some());
    }

    #[tokio::test]
    async fn leaves_the_visual_frame_its_own_sandboxing_csp() {
        let resp = app()
            .oneshot(
                HttpRequest::builder()
                    .uri(crate::domain::visual_frame::VISUAL_FRAME_PATH)
                    .header(header::HOST, "192.168.1.5:5006")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let headers = resp.headers();
        assert_eq!(
            headers.get(header::CONTENT_SECURITY_POLICY).unwrap(),
            crate::domain::visual_frame::CONTENT_SECURITY_POLICY
        );
        assert!(headers.get(header::X_FRAME_OPTIONS).is_none());
        assert_eq!(
            headers.get(header::X_CONTENT_TYPE_OPTIONS).unwrap(),
            "nosniff"
        );
    }

    #[tokio::test]
    async fn csp_falls_back_to_self_without_a_usable_host() {
        let resp = app()
            .oneshot(HttpRequest::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let csp = resp
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(csp.contains("connect-src 'self' data:;"), "got: {csp}");
        assert!(!csp.contains("wss://"), "no host => no wss entry: {csp}");
    }

    #[test]
    fn allows_terminal_wasm_without_enabling_javascript_eval() {
        for (host, expected_connect) in [
            (
                Some("laptop.tail1234.ts.net"),
                "connect-src 'self' data: wss://laptop.tail1234.ts.net",
            ),
            (None, "connect-src 'self' data:"),
            (
                Some("evil.example/ ; script-src *"),
                "connect-src 'self' data:",
            ),
        ] {
            let csp = content_security_policy(host);
            let directives: Vec<_> = csp.split(';').map(str::trim).collect();
            assert!(
                directives.contains(&"script-src 'self' 'wasm-unsafe-eval'"),
                "Allow WASM compilation without enabling JavaScript eval or inline scripts: {csp}"
            );
            assert!(
                directives.contains(&"worker-src 'self' blob:"),
                "Allow the document preview's blob: workers: {csp}"
            );
            assert!(
                directives.contains(&expected_connect),
                "Allow bundled WASM fetches without adding external network origins: {csp}"
            );
        }
    }

    #[test]
    fn rejects_hosts_with_unusual_characters() {
        assert!(is_plain_host("192.168.1.5:5006"));
        assert!(is_plain_host("laptop.tail1234.ts.net"));
        assert!(!is_plain_host("evil.example/ ; script-src *"));
        assert!(!is_plain_host(""));
    }
}
