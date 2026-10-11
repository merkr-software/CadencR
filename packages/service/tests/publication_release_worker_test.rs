//! Exercise the real durable release future, not merely a tiny synthetic job.
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use cadencr_service::{api, app_state::AppState, domain::settings_store};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use std::{net::SocketAddr, path::Path, process::Command};
use tower::ServiceExt;

fn git(root: &Path, args: &[&str]) {
    assert!(Command::new("git")
        .args(args)
        .current_dir(root)
        .status()
        .unwrap()
        .success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn confirmed_release_auth_rejection_survives_as_durable_unknown() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings");
    std::fs::create_dir(&settings).unwrap();
    settings_store::init(settings);
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let project = project.canonicalize().unwrap();
    git(&project, &["init", "-q"]);
    git(
        &project,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--allow-empty",
            "-qm",
            "fixture",
        ],
    );
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/managed_provider_index/v1/valid.json"
    ))
    .unwrap();
    let mut package = fixture["signed"]["packages"][0].clone();
    package["agent"]["repository"] = json!("https://github.com/acme/provider");
    let target = "linux-x86_64";
    let mut artifact = package["agent"]["distribution"]["binary"][target].clone();
    let bytes = b"inert local archive";
    artifact["sha256"] = json!(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>());
    artifact["archive"] =
        json!("https://github.com/acme/provider/releases/download/v1.2.3/linux-x86_64.tar.gz");
    let mut macos = artifact.clone();
    macos["archive"] =
        json!("https://github.com/acme/provider/releases/download/v1.2.3/darwin-aarch64.tar.gz");
    package["agent"]["distribution"]["binary"] = json!({target:artifact,"darwin-aarch64":macos});
    let repository = package["agent"]["repository"].as_str().unwrap();
    git(&project, &["remote", "add", "origin", repository]);
    let bundle_id = "123e4567-e89b-42d3-a456-426614174000";
    let second_id = "123e4567-e89b-42d3-a456-426614174001";
    for (id, target) in [(bundle_id, target), (second_id, "darwin-aarch64")] {
        let bundle = root.path().join("provider-publication-bundles/1").join(id);
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("provider.tar.gz"), bytes).unwrap();
        std::fs::write(
            bundle.join("package.json"),
            serde_json::to_vec(&package).unwrap(),
        )
        .unwrap();
        std::fs::write(
            bundle.join("target.json"),
            serde_json::to_vec(target).unwrap(),
        )
        .unwrap();
    }
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT, authoring_target TEXT, plugin_id TEXT)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO projects VALUES (1, ?, 'provider', ?)")
        .bind(project.to_str().unwrap())
        .bind(package["agent"]["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let mut state = AppState::with_pool(pool);
    state.auth_token = "worker-test-token".into();
    state.port = 5005;
    let app = api::build_router(state);
    let body = json!({"bundle_id":bundle_id,"bundle_ids":[second_id],"release_notes":"worker regression","confirmed":true,"expected_plan_sha256":"a".repeat(64)});
    let mut request = Request::post("/api/projects/1/publication-release")
        .header("host", "127.0.0.1:5005")
        .header("content-type", "application/json")
        .header("x-cadencr-token", "worker-test-token")
        .body(Body::from(body.to_string()))
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 12345))));
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let error: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(
        error["code"], "PUBLICATION_RELEASE_AUTH_REQUIRED",
        "{error}"
    );
    let mut request = Request::get("/api/projects/1/publication-operations")
        .header("host", "127.0.0.1:5005")
        .header("x-cadencr-token", "worker-test-token")
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 12345))));
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let page: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(page["operations"][0]["status"], "unknown");
    assert_eq!(
        page["operations"][0]["error_code"],
        "PUBLICATION_RELEASE_AUTH_REQUIRED"
    );
}
