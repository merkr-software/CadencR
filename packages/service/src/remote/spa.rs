use std::path::Path;

use tower_http::services::{ServeDir, ServeFile};

/// Serve the built SPA, falling back to `index.html` for any unmatched path so
/// the client-side router (TanStack) can handle deep links. Mounted as the
/// remote router's `fallback_service`, so it only runs for paths the API
/// routers didn't claim.
///
/// The renderer build writes a Brotli copy beside each compressible file
/// (`app.js.br`, see the desktop's `electron/precompress-renderer.ts`): a
/// client accepting `br` gets it as is, so an asset is compressed once at
/// build time, at a high quality, instead of on every request. Files
/// without one (or a client without `br`) go through the remote compression
/// layer as before, which leaves an already-encoded response alone.
pub fn spa_service(renderer_dir: &Path) -> ServeDir<ServeFile> {
    ServeDir::new(renderer_dir)
        .precompressed_br()
        .fallback(ServeFile::new(renderer_dir.join("index.html")).precompressed_br())
}

/// The remote router serving a renderer, for tests here and in `api`.
#[cfg(test)]
pub(crate) mod test_support {
    use axum::body::Body;
    use axum::http::{Request, Response};
    use tower::ServiceExt;

    pub(crate) const SCRIPT: &str = "let x = 1;\n";
    pub(crate) const PRECOMPRESSED: &[u8] = b"brotli bytes from the build";

    /// `assets/app.js` and `index.html`, with their build-time Brotli copies
    /// when `copies` is set.
    pub(crate) fn renderer(copies: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/app.js"), SCRIPT.repeat(4096)).unwrap();
        std::fs::write(dir.path().join("index.html"), "<html></html>").unwrap();
        if copies {
            std::fs::write(dir.path().join("assets/app.js.br"), PRECOMPRESSED).unwrap();
            std::fs::write(dir.path().join("index.html.br"), PRECOMPRESSED).unwrap();
        }
        dir
    }

    /// A GET from a LAN device through the whole remote router (public SPA
    /// paths need no device token).
    pub(crate) async fn get(renderer: &std::path::Path, uri: &str, accept: &str) -> Response<Body> {
        let context = crate::remote::RemoteContext {
            allowed_hosts: std::sync::Arc::new(vec!["remote.test".to_string()]),
            allowed_origins: std::sync::Arc::new(Vec::new()),
            pepper: std::sync::Arc::new(vec![7; 32]),
        };
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let state = crate::app_state::AppState::with_pool(pool);
        let request = Request::get(uri)
            .header("host", "remote.test")
            .header("accept-encoding", accept)
            .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [192, 168, 1, 20],
                50_000,
            ))))
            .body(Body::empty())
            .unwrap();
        crate::api::build_remote_router(state, renderer, context)
            .oneshot(request)
            .await
            .unwrap()
    }

    pub(crate) async fn body(response: Response<Body>) -> Vec<u8> {
        axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{body, get, renderer, PRECOMPRESSED, SCRIPT};

    #[tokio::test]
    async fn serves_the_build_time_brotli_copy_as_is() {
        let renderer = renderer(true);
        for uri in ["/assets/app.js", "/", "/ws-session/deep-link"] {
            let response = get(renderer.path(), uri, "gzip, br").await;
            assert!(
                response.status().is_success(),
                "{uri}: {:?}",
                response.status()
            );
            assert_eq!(response.headers()["content-encoding"], "br", "{uri}");
            assert_eq!(response.headers()["vary"], "accept-encoding", "{uri}");
            let content_type = response.headers()["content-type"].to_str().unwrap();
            let expected = if uri == "/assets/app.js" {
                "javascript"
            } else {
                "text/html"
            };
            assert!(content_type.contains(expected), "{uri}: {content_type}");
            // Not compressed a second time by the remote compression layer.
            assert_eq!(body(response).await, PRECOMPRESSED, "{uri}");
        }
    }

    #[tokio::test]
    async fn a_client_without_brotli_still_gets_the_file_compressed() {
        let renderer = renderer(true);
        let response = get(renderer.path(), "/assets/app.js", "gzip").await;
        assert_eq!(response.headers()["content-encoding"], "gzip");

        let plain = get(renderer.path(), "/assets/app.js", "identity").await;
        assert!(plain.headers().get("content-encoding").is_none());
        assert_eq!(body(plain).await, SCRIPT.repeat(4096).as_bytes());
    }
}
