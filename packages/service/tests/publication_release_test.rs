//! Release mutation routes remain authenticated, local-only, and fail before network I/O.
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use cadencr_service::{api, app_state::AppState, domain::settings_store};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::net::SocketAddr;
use tower::ServiceExt;

async fn post(app: Router, route: &str, body: Value, authorized: bool) -> (StatusCode, Vec<u8>) {
    let mut request = Request::post(route)
        .header("host", "127.0.0.1:5005")
        .header("content-type", "application/json");
    if authorized {
        request = request.header("x-cadencr-token", "release-fixture-token");
    }
    let mut request = request.body(Body::from(body.to_string())).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 23456))));
    let response = app.oneshot(request).await.unwrap();
    (
        response.status(),
        to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
}

#[tokio::test]
async fn release_routes_are_local_authenticated_and_reject_unreviewed_inputs() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings");
    std::fs::create_dir(&settings).unwrap();
    settings_store::init(settings);
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT, authoring_target TEXT, plugin_id TEXT)")
        .execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO projects VALUES (1, ?, 'provider', 'release-fixture'), (2, ?, NULL, NULL)",
    )
    .bind(project.to_str().unwrap())
    .bind(project.to_str().unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let mut state = AppState::with_pool(pool.clone());
    state.auth_token = "release-fixture-token".into();
    state.port = 5005;
    let app = api::build_router(state.clone());
    let shared = api::build_api_routes().with_state(state);
    for suffix in ["publication-release/preview", "publication-release"] {
        let path = format!("/api/projects/1/{suffix}");
        let body = if suffix.ends_with("preview") {
            json!({"bundle_id":"../../outside", "release_notes":"fixture"})
        } else {
            json!({"bundle_id":"../../outside", "release_notes":"fixture", "confirmed":true, "expected_plan_sha256":"0".repeat(64)})
        };
        assert_eq!(
            post(app.clone(), &path, body.clone(), false).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            post(shared.clone(), &path, body.clone(), true).await.0,
            StatusCode::NOT_FOUND
        );
        let (status, bytes) = post(app.clone(), &path, body.clone(), true).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        let error: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(error["error"].is_string());
        assert!(error["code"].is_string());
        assert_eq!(
            post(
                app.clone(),
                &format!("/api/projects/2/{suffix}"),
                body.clone(),
                true
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(
                app.clone(),
                &format!("/api/projects/999/{suffix}"),
                body,
                true
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        for invalid in [
            json!({}),
            json!({"bundle_id":"x", "release_notes":"x".repeat(256 * 1024)}),
        ] {
            let (status, bytes) = post(app.clone(), &path, invalid, true).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            let error: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(error["code"].is_string());
        }
    }
    let unconfirmed = json!({"bundle_id":uuid::Uuid::new_v4().to_string(),"release_notes":"fixture","expected_plan_sha256":"0".repeat(64),"confirmed":false});
    let (status, _) = post(
        app,
        "/api/projects/1/publication-release",
        unconfirmed,
        true,
    )
    .await;
    assert!(status.is_client_error());
    assert!(!root.path().join("provider-publication-bundles").exists());
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 2);
}
