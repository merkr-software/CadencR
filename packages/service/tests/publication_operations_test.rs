//! Durable lookup stays on the authenticated loopback API, with bounded pages.
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use cadencr_service::{
    api,
    app_state::AppState,
    domain::{
        projects::{
            publication_operations as operations, publication_release::PublishedProviderRelease,
        },
        settings_store,
    },
};
use serde_json::Value;
use std::net::SocketAddr;
use tower::ServiceExt;

async fn get(app: Router, path: &str, authorized: bool) -> (StatusCode, Vec<u8>) {
    let mut request = Request::get(path).header("host", "127.0.0.1:5005");
    if authorized {
        request = request.header("x-cadencr-token", "operation-fixture-token");
    }
    let mut request = request.body(Body::empty()).unwrap();
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
async fn operations_routes_authenticate_and_page_project_bound_results() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings");
    std::fs::create_dir(&settings).unwrap();
    settings_store::init(settings);
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    let mut state = AppState::with_pool(pool);
    state.auth_token = "operation-fixture-token".into();
    state.port = 5005;
    let app = api::build_router(state.clone());
    let shared = api::build_api_routes().with_state(state);
    for (project, number) in [(1, 1), (1, 2), (1, 3), (2, 4)] {
        operations::execute()
            .project_id(project)
            .kind(operations::PublicationOperationKind::Release)
            .operation_id(format!("{number:064x}"))
            .plan_sha256("a".repeat(64))
            .job(async {
                Ok(operations::PublicationOperationResult::Release(
                    PublishedProviderRelease {
                        release_url: "https://github.com/acme/repo/releases/tag/v1".into(),
                        repository: "acme/repo".into(),
                        tag: "v1".into(),
                        source_commit: "a".repeat(40),
                        archive_sha256: "b".repeat(64),
                        already_published: false,
                    },
                ))
            })
            .call()
            .await
            .unwrap();
    }
    let path = "/api/projects/1/publication-operations";
    assert_eq!(
        get(app.clone(), path, false).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        get(shared.clone(), path, true).await.0,
        StatusCode::NOT_FOUND
    );
    let (status, bytes) = get(app.clone(), &format!("{path}?limit=2"), true).await;
    assert_eq!(status, StatusCode::OK);
    let first: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(first["operations"].as_array().unwrap().len(), 2);
    assert_eq!(first["next_cursor"], format!("{:064x}", 2));
    let second: Value = serde_json::from_slice(
        &get(
            app.clone(),
            &format!("{path}?limit=2&cursor={:064x}", 2),
            true,
        )
        .await
        .1,
    )
    .unwrap();
    assert_eq!(second["operations"].as_array().unwrap().len(), 1);
    assert!(second["next_cursor"].is_null());
    assert_eq!(
        second["operations"][0]["operation_id"],
        format!("{:064x}", 3)
    );
    let lookup = format!("{path}/{:064x}", 1);
    assert_eq!(
        get(app.clone(), &lookup, false).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, bytes) = get(app.clone(), &lookup, true).await;
    assert_eq!(status, StatusCode::OK);
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["status"], "succeeded");
    assert_eq!(value["result"]["kind"], "release");
    assert_eq!(
        get(
            app.clone(),
            &format!("/api/projects/2/publication-operations/{:064x}", 1),
            true
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for suffix in [
        "?limit=0",
        "?limit=101",
        "?cursor=invalid",
        "?unknown=true",
        "/invalid",
    ] {
        assert_eq!(
            get(app.clone(), &format!("{path}{suffix}"), true).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let journal = root
        .path()
        .join("publication-operations/1")
        .join(format!("{:064x}.json", 1));
    std::fs::write(journal, b"{}").unwrap();
    let (status, bytes) = get(app, &lookup, true).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["code"], "PUBLICATION_OPERATION_STORAGE_FAILED");
}
