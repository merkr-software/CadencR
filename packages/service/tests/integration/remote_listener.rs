//! End-to-end check that the remote-access listener binds and serves over TLS.
//! Auth/pairing behavior is covered by inline unit tests once it lands (M1b);
//! this test only proves the transport: bind -> TLS handshake -> routed
//! response, plus clean teardown.

use std::sync::Arc;
use std::time::Duration;

use cadencr_service::app_state::AppState;
use cadencr_service::remote::{RemoteConfig, RemoteController};

#[tokio::test]
async fn remote_listener_serves_over_tls_then_stops() {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite");

    let renderer = tempfile::tempdir().unwrap();
    std::fs::write(
        renderer.path().join("index.html"),
        "<!doctype html><title>cadencr</title>",
    )
    .unwrap();
    let data = tempfile::tempdir().unwrap();

    let controller = Arc::new(RemoteController::new(RemoteConfig {
        renderer_dir: Some(renderer.path().to_path_buf()),
        remote_port: 0, // OS-assigned, reported back via RemoteInfo.port
        data_dir: data.path().to_path_buf(),
    }));

    let mut state = AppState::with_pool(pool);
    state.remote = controller.clone();

    let info = controller
        .start(&state)
        .await
        .expect("remote listener should start");
    assert_ne!(info.port, 0, "should report the OS-assigned port");
    assert_eq!(
        info.fingerprint.matches(':').count(),
        31,
        "SHA-256 fingerprint should be 32 colon-grouped bytes"
    );

    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let resp = client
        .get(format!("https://127.0.0.1:{}/", info.port))
        .send()
        .await
        .expect("HTTPS request should reach the TLS listener");

    // With `remote_port = 0` the OS assigns the port; the `Host` allowlist is
    // built from the *bound* port, so `127.0.0.1:<port>` is allowed and `/` (a
    // static asset, bearer-exempt) serves the SPA shell. A 200 here proves the
    // TLS handshake completed, the host check passed on the real port, and the
    // SPA fallback served — i.e. the port-0 allowlist mismatch is fixed.
    assert_eq!(resp.status().as_u16(), 200, "SPA shell should serve");
    let csp = resp.headers()[reqwest::header::CONTENT_SECURITY_POLICY]
        .to_str()
        .expect("CSP header");
    let directives: Vec<_> = csp.split(';').map(str::trim).collect();
    assert!(
        directives.contains(&"script-src 'self' 'wasm-unsafe-eval'"),
        "The remote SPA must allow terminal WASM compilation: {csp}"
    );
    assert!(
        directives
            .contains(&format!("connect-src 'self' data: wss://127.0.0.1:{}", info.port).as_str()),
        "The remote SPA must allow bundled terminal WASM fetches: {csp}"
    );
    let body = resp.text().await.expect("body");
    assert!(
        body.contains("cadencr"),
        "served the SPA index, got: {body}"
    );

    controller.stop().await;
    assert!(controller.status().await.is_none(), "stop clears state");
}
