//! End-to-end remote-access auth: pairing-code exchange, device-token auth, the
//! launch-token-rejected-remotely rule, the Host allowlist (DNS-rebinding
//! defense), and revoke. Runs against the real self-signed TLS listener using a
//! rustls client.

use crate::common;

use std::sync::Arc;
use std::time::Duration;

use cadencr_service::app_state::AppState;
use cadencr_service::domain::remote::repo;
use cadencr_service::remote::{RemoteConfig, RemoteController};
use common::apply_ws_upgrade_headers;
use reqwest::StatusCode;
use serde_json::Value;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn pool_with_remote_tables() -> SqlitePool {
    // File-backed temp DB: an in-memory pool would give each connection its own
    // database, so the tables created here wouldn't be visible to handlers.
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("remote.db");
    let pool = SqlitePoolOptions::new()
        .connect(&format!("sqlite:{}?mode=rwc", db.display()))
        .await
        .unwrap();
    // Leak the tempdir so the file outlives this fn (pool keeps it open anyway).
    std::mem::forget(dir);
    sqlx::query(
        "CREATE TABLE remote_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, \
         token_hash TEXT NOT NULL UNIQUE, label TEXT, \
         created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen_at TEXT, revoked_at TEXT)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TABLE remote_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, \
         device_id INTEGER, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(&pool)
    .await
    .unwrap();
    pool
}

fn rustls_client() -> reqwest::Client {
    reqwest::Client::builder()
        .use_rustls_tls()
        .danger_accept_invalid_certs(true)
        .http1_only() // make Host-header override deterministic
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

async fn ws_status(
    client: &reqwest::Client,
    base: &str,
    origin: &str,
    protocol: Option<String>,
) -> StatusCode {
    let mut req = apply_ws_upgrade_headers(client.get(format!("{base}/ws")), origin);
    if let Some(protocol) = protocol {
        req = req.header("sec-websocket-protocol", protocol);
    }
    req.send().await.unwrap().status()
}

#[tokio::test]
async fn remote_pairing_device_auth_and_revoke() {
    let pool = pool_with_remote_tables().await;
    let port = free_port();

    let renderer = tempfile::tempdir().unwrap();
    std::fs::write(renderer.path().join("index.html"), "<!doctype html>").unwrap();
    let data = tempfile::tempdir().unwrap();

    let controller = Arc::new(RemoteController::new(RemoteConfig {
        renderer_dir: Some(renderer.path().to_path_buf()),
        remote_port: port,
        data_dir: data.path().to_path_buf(),
    }));
    let mut state = AppState::with_pool(pool.clone());
    state.remote = controller.clone();

    controller.start(&state).await.expect("listener starts");
    let base = format!("https://127.0.0.1:{port}");
    let client = rustls_client();

    // A request to a protected API path without any token is rejected.
    let resp = client
        .get(format!("{base}/api/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401, "no token => unauthorized");
    // Security headers are stamped on every remote response, including 401s.
    assert!(
        resp.headers().contains_key("content-security-policy"),
        "remote responses must carry a CSP"
    );
    assert_eq!(
        resp.headers()
            .get("x-content-type-options")
            .and_then(|v| v.to_str().ok()),
        Some("nosniff"),
    );

    // The launch token is loopback-only; it must NOT authenticate remotely.
    let resp = client
        .get(format!("{base}/api/health"))
        .header("x-cadencr-token", "test-token")
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        401,
        "launch token rejected remotely"
    );

    // DNS-rebinding defense: a foreign Host is 421'd even with a (would-be) token.
    let resp = client
        .get(format!("{base}/api/health"))
        .header("host", "evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 421, "foreign Host => misdirected");

    // An unknown pairing code is rejected (no token minted).
    let resp = client
        .post(format!("{base}/api/remote/pair"))
        .json(&serde_json::json!({ "code": "bogus" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 400, "bad code => bad request");

    // Mint a code (as the loopback host UI would) and pair the new device.
    let code = controller.pairing().mint().code;
    let resp = client
        .post(format!("{base}/api/remote/pair"))
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "valid code pairs");
    let body: Value = resp.json().await.unwrap();
    let device_token = body["device_token"].as_str().unwrap().to_string();

    // Provider descriptor mutations select a host executable and launch
    // environment, so they are loopback-only even for an authenticated paired
    // device. An intentionally invalid body proves the route is absent without
    // risking a durable write if this invariant ever regresses.
    let resp = client
        .post(format!("{base}/api/agents/installed-providers"))
        .header("x-cadencr-token", &device_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);

    // Authenticated remote devices still must not reach host-control endpoints.
    // Unknown/unmounted API paths should remain API-shaped 404s, not fall
    // through to the SPA fallback as index.html.
    let resp = client
        .get(format!("{base}/api/remote/status"))
        .header("x-cadencr-token", &device_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["code"], "NOT_FOUND", "API miss should stay JSON");

    // Remote WebSocket routes authenticate inside the upgrade handler: missing
    // token and loopback launch token are rejected, a foreign Origin is
    // rejected, and a paired device token from the served origin upgrades.
    let missing_token = ws_status(&client, &base, &base, None);
    let launch_token = ws_status(
        &client,
        &base,
        &base,
        Some("cadencr-token.test-token".to_string()),
    );
    let foreign_origin = ws_status(
        &client,
        &base,
        "https://evil.example",
        Some(format!("cadencr-token.{device_token}")),
    );
    let valid_device = ws_status(
        &client,
        &base,
        &base,
        Some(format!("cadencr-token.{device_token}")),
    );
    let (missing_token, launch_token, foreign_origin, valid_device) =
        tokio::join!(missing_token, launch_token, foreign_origin, valid_device);
    assert_eq!(missing_token, StatusCode::UNAUTHORIZED);
    assert_eq!(launch_token, StatusCode::UNAUTHORIZED);
    assert_eq!(foreign_origin, StatusCode::FORBIDDEN);
    assert_eq!(valid_device, StatusCode::SWITCHING_PROTOCOLS);

    // The device token authenticates a protected request.
    let resp = client
        .get(format!("{base}/api/health"))
        .header("x-cadencr-token", &device_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "device token authenticates");

    // Revoke the device, then the same token must stop working.
    let device_id = sqlx::query_scalar::<_, i64>("SELECT id FROM remote_devices LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(repo::revoke_device(&pool, device_id).await.unwrap());
    let resp = client
        .get(format!("{base}/api/health"))
        .header("x-cadencr-token", &device_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401, "revoked token rejected");

    controller.stop().await;
}

/// The pairing endpoint is pre-auth and brute-forceable, so it's rate-limited
/// per source IP. This also exercises the `ConnectInfo` wiring end-to-end.
#[tokio::test]
async fn remote_pair_is_rate_limited() {
    let pool = pool_with_remote_tables().await;
    let port = free_port();

    let renderer = tempfile::tempdir().unwrap();
    std::fs::write(renderer.path().join("index.html"), "<!doctype html>").unwrap();
    let data = tempfile::tempdir().unwrap();

    let controller = Arc::new(RemoteController::new(RemoteConfig {
        renderer_dir: Some(renderer.path().to_path_buf()),
        remote_port: port,
        data_dir: data.path().to_path_buf(),
    }));
    let mut state = AppState::with_pool(pool.clone());
    state.remote = controller.clone();

    controller.start(&state).await.expect("listener starts");
    let base = format!("https://127.0.0.1:{port}");
    let client = rustls_client();

    // The first 5 bad-code attempts are rejected on their merits (400); the 6th
    // trips the per-IP pair limiter (429) before the handler runs.
    let mut statuses = Vec::new();
    for _ in 0..6 {
        let resp = client
            .post(format!("{base}/api/remote/pair"))
            .json(&serde_json::json!({ "code": "bogus" }))
            .send()
            .await
            .unwrap();
        statuses.push(resp.status().as_u16());
    }
    assert!(
        statuses[..5].iter().all(|&s| s == 400),
        "first 5 attempts hit the handler: {statuses:?}"
    );
    assert_eq!(
        statuses[5], 429,
        "6th attempt is rate-limited: {statuses:?}"
    );

    controller.stop().await;
}
