//! CORS for the loopback listener: the renderer is a cross-origin client in
//! dev (`http://localhost:<frontend port>`) and a `null` origin when packaged.

use axum::http::header::{HeaderName, CONTENT_TYPE};
use axum::http::Method;
use tower_http::cors::CorsLayer;

pub fn build_cors_layer(frontend_port: u16) -> CorsLayer {
    let mut origins = vec!["null".parse().expect("static origin")];
    if cfg!(debug_assertions) {
        origins.push(
            format!("http://localhost:{frontend_port}")
                .parse()
                .expect("frontend origin"),
        );
        origins.push(
            format!("http://127.0.0.1:{frontend_port}")
                .parse()
                .expect("frontend origin"),
        );
    }

    CorsLayer::new()
        .allow_origin(origins)
        .allow_headers([
            HeaderName::from_static(super::middleware::AUTH_HEADER),
            HeaderName::from_static(crate::domain::plugin_tabs::principal::PLUGIN_TOKEN_HEADER),
            HeaderName::from_static(crate::domain::plugin_tabs::net::NET_HEADERS_HEADER),
            CONTENT_TYPE,
        ])
        // The renderer is cross-origin (file:// in packaged builds): response
        // headers it reads (the egress relay's, a workbook's formula status)
        // must be exposed explicitly.
        .expose_headers([
            HeaderName::from_static(crate::domain::plugin_tabs::net::NET_STATUS_HEADER),
            HeaderName::from_static(crate::domain::plugin_tabs::net::NET_HEADERS_HEADER),
            HeaderName::from_static(crate::domain::editor::document_routes::FORMULAS_HEADER),
        ])
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
        ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use axum::routing::post;
    use tower::ServiceExt;

    #[tokio::test]
    async fn the_relay_headers_are_allowed_and_exposed() {
        let app = axum::Router::new()
            .route("/x", post(|| async { StatusCode::OK }))
            .layer(build_cors_layer(1420));
        let preflight = Request::builder()
            .method(Method::OPTIONS)
            .uri("/x")
            .header(header::ORIGIN, "null")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS,
                "x-cadencr-plugin-token,x-cadencr-net-headers,content-type",
            )
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(preflight).await.unwrap();
        let allowed = response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
            .to_str()
            .unwrap()
            .to_string();
        assert!(allowed.contains("x-cadencr-net-headers"), "{allowed}");
        let request = Request::builder()
            .method(Method::POST)
            .uri("/x")
            .header(header::ORIGIN, "null")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let exposed = response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS]
            .to_str()
            .unwrap()
            .to_string();
        assert!(exposed.contains("x-cadencr-net-status"), "{exposed}");
        assert!(exposed.contains("x-cadencr-net-headers"), "{exposed}");
    }
}
