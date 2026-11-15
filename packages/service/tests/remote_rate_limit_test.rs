//! Remote listener rate limiting when every device arrives from the same peer
//! address, as behind a tunnel that connects from `127.0.0.1`. Authenticated
//! devices get their own budgets; anonymous traffic stays keyed by the TCP peer
//! address and never by a client-supplied `X-Forwarded-For`.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use cadencr_service::{
    api,
    app_state::AppState,
    domain::remote::{repo, tokens},
    remote::RemoteContext,
    shared::migrate::{run_migrations, MigrationContext},
};
use sqlx::sqlite::SqlitePoolOptions;
use tower::ServiceExt;

const HOST: &str = "127.0.0.1:7443";
const PEPPER: &[u8] = b"rate-limit-pepper";
/// An authenticated API miss: cheap, and only reachable past device auth.
const PROBE: &str = "/api/rate-limit-probe";
/// Well above every per-window limit, so a loop that never trips fails.
const RUNAWAY_CAP: usize = 20_000;

struct Fixture {
    router: Router,
    _root: tempfile::TempDir,
}

async fn fixture(devices: &[&str]) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&format!(
            "sqlite:{}?mode=rwc",
            root.path().join("t.db").display()
        ))
        .await
        .unwrap();
    run_migrations(&MigrationContext {
        pool: &pool,
        db_path: None,
        app_version: None,
    })
    .await
    .unwrap();
    for (index, token) in devices.iter().enumerate() {
        repo::insert_device(
            &pool,
            &tokens::hash_token(PEPPER, token),
            &format!("d{index}"),
        )
        .await
        .unwrap();
    }
    let renderer = root.path().join("renderer");
    std::fs::create_dir(&renderer).unwrap();
    std::fs::write(renderer.join("index.html"), "<!doctype html>").unwrap();
    let context = RemoteContext {
        allowed_hosts: Arc::new(vec![HOST.into()]),
        allowed_origins: Arc::new(vec![format!("https://{HOST}")]),
        pepper: Arc::new(PEPPER.to_vec()),
    };
    let router = api::build_remote_router(AppState::with_pool(pool), &renderer, context);
    Fixture {
        router,
        _root: root,
    }
}

/// One request from the tunnel's loopback peer.
async fn send(router: &Router, token: Option<&str>, forwarded_for: Option<&str>) -> StatusCode {
    let mut builder = Request::builder().uri(PROBE).header("host", HOST);
    if let Some(token) = token {
        builder = builder.header("x-cadencr-token", token);
    }
    if let Some(ip) = forwarded_for {
        builder = builder.header("x-forwarded-for", ip);
    }
    let mut request = builder.body(Body::empty()).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50000))));
    router.clone().oneshot(request).await.unwrap().status()
}

async fn send_until_limited(router: &Router, token: Option<&str>) -> usize {
    for attempt in 1..=RUNAWAY_CAP {
        if send(router, token, None).await == StatusCode::TOO_MANY_REQUESTS {
            return attempt;
        }
    }
    panic!("never rate limited after {RUNAWAY_CAP} requests");
}

#[tokio::test]
async fn a_runaway_device_does_not_spend_another_devices_budget() {
    let fixture = fixture(&["device-a-token", "device-b-token"]).await;
    send_until_limited(&fixture.router, Some("device-a-token")).await;

    assert_eq!(
        send(&fixture.router, Some("device-a-token"), None).await,
        StatusCode::TOO_MANY_REQUESTS,
        "the runaway device stays limited"
    );
    assert_eq!(
        send(&fixture.router, Some("device-b-token"), None).await,
        StatusCode::NOT_FOUND,
        "the other device behind the same address keeps its own budget"
    );
}

#[tokio::test]
async fn a_device_with_a_stale_token_does_not_lock_out_paired_devices() {
    let fixture = fixture(&["device-b-token"]).await;
    // Device B is connected: it has already been verified once.
    assert_eq!(
        send(&fixture.router, Some("device-b-token"), None).await,
        StatusCode::NOT_FOUND
    );
    let failures = send_until_limited(&fixture.router, Some("revoked-device-token")).await;
    assert!(failures > 1, "failures are first answered with 401");

    assert_eq!(
        send(&fixture.router, Some("device-b-token"), None).await,
        StatusCode::NOT_FOUND,
        "a paired device is not locked out by another device's failures"
    );
}

#[tokio::test]
async fn failed_credentials_stay_bounded_per_peer_whatever_the_forwarded_header() {
    let fixture = fixture(&["device-b-token"]).await;
    send_until_limited(&fixture.router, Some("guess-0")).await;

    for (n, spoofed) in ["203.0.113.7", "198.51.100.1", "10.9.9.9"]
        .iter()
        .enumerate()
    {
        assert_eq!(
            send(
                &fixture.router,
                Some(&format!("guess-{}", n + 1)),
                Some(spoofed)
            )
            .await,
            StatusCode::TOO_MANY_REQUESTS,
            "a forged X-Forwarded-For must not open a fresh budget"
        );
    }
    assert_eq!(
        send(&fixture.router, None, Some("203.0.113.8")).await,
        StatusCode::TOO_MANY_REQUESTS,
        "anonymous requests from the locked peer are shed before auth"
    );
}

/// After a restart no device is known yet. A device retrying a revoked token
/// locks its peer out, but it keeps presenting the same token, which is shed
/// as already rejected: a reconnecting device still gets verified.
#[tokio::test]
async fn a_stale_token_retried_in_a_loop_does_not_block_a_reconnecting_device() {
    let fixture = fixture(&["device-b-token"]).await;
    send_until_limited(&fixture.router, Some("revoked-device-token")).await;
    for _ in 0..50 {
        assert_eq!(
            send(&fixture.router, Some("revoked-device-token"), None).await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    assert_eq!(
        send(&fixture.router, Some("device-b-token"), None).await,
        StatusCode::NOT_FOUND,
        "a device never seen since the restart is still verified"
    );
}

/// Fresh guesses during a lockout are each verified, but only within a small
/// per-peer budget; past it they are shed before any DB work, and so is a
/// legitimate first contact from the same peer until the window ends.
#[tokio::test]
async fn never_seen_tokens_during_a_lockout_share_a_small_budget() {
    let fixture = fixture(&["device-b-token"]).await;
    send_until_limited(&fixture.router, Some("guess-0")).await;
    for n in 1..=50 {
        send(&fixture.router, Some(&format!("guess-{n}")), None).await;
    }

    assert_eq!(
        send(&fixture.router, Some("device-b-token"), None).await,
        StatusCode::TOO_MANY_REQUESTS,
        "first contact waits for the window once guesses spent the budget"
    );
}
