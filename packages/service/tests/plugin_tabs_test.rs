//! Custom tabs host API end to end: list → consent → enable → effective, the
//! asset CSP and path-traversal refusal.
//!
//! Its own binary because `settings_store::init` sets process-global state
//! (the plugins dir derives from the settings dir).
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{header, Method, Request, StatusCode},
    Router,
};
use cadencr_service::{
    api,
    app_state::AppState,
    domain::{plugin_tabs::assets::CONTENT_SECURITY_POLICY, settings_store},
    shared::migrate::{run_migrations, MigrationContext},
};
use serde_json::{json, Value};
use std::net::SocketAddr;
use tower::ServiceExt;

const TOKEN: &str = "plugin-tabs-fixture-token";

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

async fn send(app: &Router, method: Method, path: &str, body: Option<Value>) -> Reply {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:5005")
        .header("x-cadencr-token", TOKEN);
    if body.is_some() {
        request = request.header(header::CONTENT_TYPE, "application/json");
    }
    let body = body.map_or_else(Body::empty, |value| Body::from(value.to_string()));
    let mut request = request.body(body).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 23457))));
    let response = app.clone().oneshot(request).await.unwrap();
    Reply {
        status: response.status(),
        headers: response.headers().clone(),
        body: to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    }
}

fn write_tab(tabs: &std::path::Path) {
    let dir = tabs.join("graph");
    std::fs::create_dir_all(dir.join("dist/assets")).unwrap();
    std::fs::write(
        dir.join("tab.json"),
        json!({
            "schema_version": 1, "kind": "tab", "id": "graph", "name": "Graph",
            "version": "0.1.0", "api_version": 1, "entry": "dist/index.html",
            "permissions": ["features:read", "git:read"],
            "configuration": [
                { "key": "token", "type": "secret", "label": "Token", "scope": "global" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(dir.join("dist/index.html"), "<!doctype html><p>graph</p>").unwrap();
    std::fs::write(dir.join("dist/assets/app.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
    std::fs::create_dir_all(dir.join("node_modules/x")).unwrap();
    std::fs::write(dir.join("node_modules/x/index.js"), "x").unwrap();
    std::fs::write(tabs.join("outside.txt"), "outside").unwrap();
}

async fn app(root: &std::path::Path) -> Router {
    let settings = root.join("settings");
    std::fs::create_dir(&settings).unwrap();
    settings_store::init(settings);
    write_tab(&root.join("plugins/tabs"));
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    run_migrations(&MigrationContext {
        pool: &pool,
        db_path: None,
        app_version: None,
    })
    .await
    .unwrap();
    sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'P', '/tmp/p')")
        .execute(&pool)
        .await
        .unwrap();
    let mut state = AppState::with_pool(pool);
    state.auth_token = TOKEN.into();
    state.port = 5005;
    api::build_router(state)
}

/// One test: `settings_store::init` is set-once per process, so a second
/// test in this binary could not point the plugins dir at its own folder.
#[tokio::test]
async fn plugin_tabs_host_api_end_to_end() {
    let root = tempfile::tempdir().unwrap();
    let app = app(root.path()).await;
    lifecycle(&app).await;
    assets(&app).await;
}

async fn lifecycle(app: &Router) {
    let app = app.clone();

    let list = send(&app, Method::GET, "/api/plugin-tabs?project_id=1", None).await;
    assert_eq!(list.status, StatusCode::OK);
    let tabs = list.json();
    assert_eq!(tabs.as_array().unwrap().len(), 1);
    let graph = &tabs[0];
    assert_eq!(graph["status"], "valid");
    assert_eq!(graph["entry_present"], true);
    assert_eq!(graph["enablement"]["consent_required"], true);
    let hash = graph["permissions_hash"].as_str().unwrap().to_string();

    let enable = json!({ "project_id": 1, "enabled": true });
    let refused = send(
        &app,
        Method::PUT,
        "/api/plugin-tabs/graph/enablement",
        Some(enable.clone()),
    )
    .await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.json()["code"], "PLUGIN_TAB_CONSENT_REQUIRED");

    let stale = send(
        &app,
        Method::PUT,
        "/api/plugin-tabs/graph/consent",
        Some(json!({ "permissions_hash": "0".repeat(64) })),
    )
    .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    assert_eq!(stale.json()["code"], "PLUGIN_TAB_CONSENT_STALE");
    let consent = send(
        &app,
        Method::PUT,
        "/api/plugin-tabs/graph/consent?project_id=1",
        Some(json!({ "permissions_hash": hash })),
    )
    .await;
    assert_eq!(consent.status, StatusCode::OK);
    assert_eq!(consent.json()["enablement"]["consent_required"], false);

    let enabled = send(
        &app,
        Method::PUT,
        "/api/plugin-tabs/graph/enablement",
        Some(enable),
    )
    .await;
    assert_eq!(enabled.status, StatusCode::OK);
    assert_eq!(enabled.json()["enablement"]["effective"], true);
    let detail = send(
        &app,
        Method::GET,
        "/api/plugin-tabs/graph?project_id=1",
        None,
    )
    .await;
    assert_eq!(detail.json()["enablement"]["project"], true);
    let global = send(&app, Method::GET, "/api/plugin-tabs/graph", None).await;
    assert_eq!(global.json()["enablement"]["effective"], false);
    let with_overrides = send(
        &app,
        Method::GET,
        "/api/plugin-tabs?project_overrides=true",
        None,
    )
    .await;
    assert_eq!(
        with_overrides.json()[0]["project_overrides"],
        json!([{ "project_id": 1, "enabled": true }])
    );
    let plain = send(&app, Method::GET, "/api/plugin-tabs", None).await;
    assert!(plain.json()[0].get("project_overrides").is_none());
    let missing_project = send(
        &app,
        Method::PUT,
        "/api/plugin-tabs/graph/enablement",
        Some(json!({ "project_id": 99, "enabled": false })),
    )
    .await;
    assert_eq!(missing_project.status, StatusCode::NOT_FOUND);
    assert_eq!(
        send(&app, Method::GET, "/api/plugin-tabs/absent", None)
            .await
            .json()["code"],
        "PLUGIN_TAB_NOT_FOUND"
    );

    let saved = send(
        &app,
        Method::PUT,
        "/api/plugin-tabs/graph/configuration",
        Some(json!({ "values": { "token": "s3cret" } })),
    )
    .await;
    assert_eq!(saved.status, StatusCode::OK);
    assert_eq!(saved.json()["global"]["token"], json!({ "is_set": true }));
    assert!(!String::from_utf8_lossy(&saved.body).contains("s3cret"));
}

async fn assets(app: &Router) {
    let app = app.clone();

    for entry in [
        "/api/plugin-tabs/graph/assets/",
        "/api/plugin-tabs/graph/assets",
    ] {
        let page = send(&app, Method::GET, entry, None).await;
        assert_eq!(page.status, StatusCode::OK, "{entry}");
        assert_eq!(page.body, b"<!doctype html><p>graph</p>");
        assert_eq!(
            page.headers[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(
            page.headers[header::CONTENT_SECURITY_POLICY],
            CONTENT_SECURITY_POLICY
        );
        assert_eq!(page.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(page.headers[header::CACHE_CONTROL], "no-store");
    }
    let script = send(
        &app,
        Method::GET,
        "/api/plugin-tabs/graph/assets/assets/app.js",
        None,
    )
    .await;
    assert_eq!(script.status, StatusCode::OK);
    assert_eq!(
        script.headers[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );

    for (path, status) in [
        (
            "/api/plugin-tabs/graph/assets/%2e%2e/outside.txt",
            StatusCode::FORBIDDEN,
        ),
        (
            "/api/plugin-tabs/graph/assets/..%2Foutside.txt",
            StatusCode::FORBIDDEN,
        ),
        (
            "/api/plugin-tabs/graph/assets/%2e%2e%2f%2e%2e%2foutside.txt",
            StatusCode::FORBIDDEN,
        ),
        (
            "/api/plugin-tabs/graph/assets/%2Fetc%2Fpasswd",
            StatusCode::FORBIDDEN,
        ),
        ("/api/plugin-tabs/graph/assets/.env", StatusCode::FORBIDDEN),
        (
            "/api/plugin-tabs/graph/assets/node_modules/x/index.js",
            StatusCode::FORBIDDEN,
        ),
        (
            "/api/plugin-tabs/graph/assets/missing.js",
            StatusCode::NOT_FOUND,
        ),
        (
            "/api/plugin-tabs/..%2Fgraph/assets/tab.json",
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let reply = send(&app, Method::GET, path, None).await;
        assert_eq!(reply.status, status, "{path}");
        assert_ne!(reply.body, b"outside", "{path}");
    }
}
