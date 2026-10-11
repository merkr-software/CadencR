//! Authenticated local preparation interoperates with the registry and installer.
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use cadencr_service::{api, app_state::AppState, domain::settings_store};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use sqlx::SqlitePool;
use std::{net::SocketAddr, path::Path, process::Command};
use tower::ServiceExt;

const TARGET: &str = "linux-x86_64";
const TOKEN: &str = "publication-test-token";

async fn post(app: Router, id: i64, body: &Value, authorized: bool) -> (StatusCode, Vec<u8>) {
    let mut request = Request::post(format!("/api/projects/{id}/publication-package"))
        .header("host", "127.0.0.1:5005")
        .header("content-type", "application/json");
    if authorized {
        request = request.header("x-cadencr-token", TOKEN);
    }
    let mut request = request.body(Body::from(body.to_string())).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 12345))));
    let response = app.oneshot(request).await.unwrap();
    (
        response.status(),
        to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
}

fn package() -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/managed_provider_index/v1/valid.json"
    ))
    .unwrap();
    let mut package = fixture["signed"]["packages"][0].clone();
    let target = package["agent"]["distribution"]["binary"][TARGET].clone();
    package["agent"]["id"] = json!("e2-fixture");
    package["agent"]["distribution"]["binary"] = json!({TARGET:target});
    package["agent"]["x-author-note"] = json!({"text":"preserve this portable extension"});
    package
}

fn stage(root: &Path) -> std::path::PathBuf {
    let staging = root.join("staging");
    std::fs::create_dir_all(staging.join("bin")).unwrap();
    std::fs::create_dir(staging.join("assets")).unwrap();
    let executable = staging.join("bin/acme-agent");
    std::fs::write(&executable, b"this artifact must never be executed\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(staging.join("assets/icon.svg"), b"<svg/>\n").unwrap();
    std::fs::write(staging.join("README.md"), b"readme\n").unwrap();
    std::fs::write(staging.join("LICENSE"), b"license\n").unwrap();
    staging
}

#[tokio::test]
async fn local_route_exports_repeatable_inert_bundles_accepted_by_registry() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings");
    std::fs::create_dir(&settings).unwrap();
    settings_store::init(settings);
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let staging = stage(root.path());
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT, authoring_target TEXT, plugin_id TEXT)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO projects VALUES (1, ?, 'provider', 'e2-fixture'), (2, ?, NULL, NULL)")
        .bind(project.to_str().unwrap())
        .bind(project.to_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let mut state = AppState::with_pool(pool.clone());
    state.auth_token = TOKEN.into();
    state.port = 5005;
    let app = api::build_router(state.clone());
    let metadata = package();
    let body = json!({"metadata_json": metadata.to_string(), "target":TARGET, "staging_directory":staging});
    assert_eq!(
        post(app.clone(), 1, &body, false).await.0,
        StatusCode::UNAUTHORIZED
    );
    let common = api::build_api_routes().with_state(state);
    assert_eq!(post(common, 1, &body, true).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        post(app.clone(), 2, &body, true).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(app.clone(), 999, &body, true).await.0,
        StatusCode::NOT_FOUND
    );
    for invalid in [
        json!({"metadata_json": metadata.to_string(), "target": TARGET}),
        json!({"metadata_json": "x".repeat(65 * 1024), "target": TARGET, "staging_directory": staging}),
        json!({"metadata_json": "x".repeat(129 * 1024), "target": TARGET, "staging_directory": staging}),
    ] {
        let (status, bytes) = post(app.clone(), 1, &invalid, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let error: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(error["error"].is_string());
        assert!(error["code"].is_string());
    }
    assert!(!root.path().join("provider-publication-bundles").exists());
    let before = std::fs::read(staging.join("bin/acme-agent")).unwrap();
    let (status, bytes) = post(app.clone(), 1, &body, true).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert_export(&result, &metadata, root.path());
    let (status, bytes) = post(app, 1, &body, true).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let second: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["sha256"], second["sha256"]);
    assert_ne!(result["archive_path"], second["archive_path"]);
    assert_eq!(
        std::fs::read(staging.join("bin/acme-agent")).unwrap(),
        before
    );
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 2);
    assert_eq!(
        serde_json::from_str::<Value>(body["metadata_json"].as_str().unwrap()).unwrap(),
        metadata
    );
}

fn assert_export(result: &Value, input: &Value, root: &Path) {
    let archive = Path::new(result["archive_path"].as_str().unwrap());
    let metadata_path = result["metadata_path"].as_str().unwrap();
    let exported: Value = serde_json::from_slice(&std::fs::read(metadata_path).unwrap()).unwrap();
    let mut expected = input.clone();
    expected["agent"]["distribution"]["binary"][TARGET]["sha256"] = result["sha256"].clone();
    assert_eq!(exported, expected);
    let bytes = std::fs::read(archive).unwrap();
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(digest, result["sha256"].as_str().unwrap());
    assert_eq!(bytes.len() as u64, result["size"].as_u64().unwrap());
    let gzip = flate2::read::GzDecoder::new(bytes.as_slice());
    let mut archive = tar::Archive::new(gzip);
    let extracted = root.join("extracted");
    archive.unpack(&extracted).unwrap();
    assert_eq!(
        std::fs::read(extracted.join("bin/acme-agent")).unwrap(),
        b"this artifact must never be executed\n"
    );
    let library = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tooling/marketplace-registry/scripts/lib.mjs");
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            r#"
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { validatePackage } = await import(pathToFileURL(process.argv[1]).href);
const errors = validatePackage(JSON.parse(readFileSync(process.argv[2], 'utf8')));
if (errors.length) { console.error(errors); process.exitCode = 1; }
"#,
        ])
        .arg(library)
        .arg(metadata_path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
