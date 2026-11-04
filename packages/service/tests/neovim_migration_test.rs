//! Progressive migration from the built-in full Neovim editor to the
//! standalone `neovim` plugin: GET reports the gate state, POST refuses while
//! a built-in session runs and otherwise writes `editor_backend` once.
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
    domain::settings_store,
    shared::migrate::{run_migrations, MigrationContext},
};
use serde_json::{json, Value};
use std::net::SocketAddr;
use tower::ServiceExt;

const TOKEN: &str = "neovim-migration-fixture-token";

struct Reply {
    status: StatusCode,
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
        body: to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    }
}

fn write_neovim_tab(tabs: &std::path::Path) {
    let dir = tabs.join("neovim");
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    std::fs::write(
        dir.join("tab.json"),
        json!({
            "schema_version": 2,
            "kind": "tab",
            "id": "neovim",
            "name": "Neovim",
            "version": "0.1.0",
            "description": "Edit with your installed Neovim.",
            "api_version": 1,
            "entry": "dist/index.html",
            "tab": { "label": "Neovim" },
            "permissions": [],
            "contributes": {
                "editor": { "label": "Neovim", "open_method": "editor.open" }
            },
            "backend": {
                "protocol": 2,
                "reasoning": "Runs your installed Neovim in a PTY.",
                "binary": {
                    "darwin-aarch64": "bin/darwin-aarch64/cadencr-neovim-backend",
                    "darwin-x86_64": "bin/darwin-x86_64/cadencr-neovim-backend",
                    "linux-x86_64": "bin/linux-x86_64/cadencr-neovim-backend"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(dir.join("dist/index.html"), "<!doctype html><p>neovim</p>").unwrap();
}

async fn app(root: &std::path::Path) -> Router {
    let settings = root.join("settings");
    std::fs::create_dir(&settings).unwrap();
    settings_store::init(settings);
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    run_migrations(&MigrationContext {
        pool: &pool,
        db_path: None,
        app_version: None,
    })
    .await
    .unwrap();
    let mut state = AppState::with_pool(pool);
    state.auth_token = TOKEN.into();
    state.port = 5005;
    api::build_router(state)
}

/// One test: `settings_store::init` is set-once per process.
#[tokio::test]
async fn neovim_plugin_migration_end_to_end() {
    let root = tempfile::tempdir().unwrap();
    let app = app(root.path()).await;

    // 1. Plugin absent: the status says so and the migration refuses with 404.
    let status = send(&app, Method::GET, "/api/neovim/migration", None).await;
    assert_eq!(status.status, StatusCode::OK);
    let body = status.json();
    assert_eq!(body["plugin"], "not_installed");
    assert_eq!(body["target"], "plugin:neovim");
    assert_eq!(body["sessions_running"], json!([]));
    let refused = send(&app, Method::POST, "/api/neovim/migration", None).await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND);
    assert_eq!(refused.json()["code"], "NEOVIM_PLUGIN_NOT_INSTALLED");

    // 2. Installed but not consented: 409 consent_required.
    write_neovim_tab(&root.path().join("plugins/tabs"));
    let status = send(&app, Method::GET, "/api/neovim/migration", None).await;
    assert_eq!(status.json()["plugin"], "consent_required");
    let refused = send(&app, Method::POST, "/api/neovim/migration", None).await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.json()["code"], "NEOVIM_PLUGIN_CONSENT_REQUIRED");

    // 3. Consented but not enabled: 409 not_enabled.
    let detail = send(&app, Method::GET, "/api/plugin-tabs/neovim", None).await;
    assert_eq!(detail.status, StatusCode::OK);
    let hash = detail.json()["permissions_hash"]
        .as_str()
        .unwrap()
        .to_string();
    let consent = send(
        &app,
        Method::PUT,
        "/api/plugin-tabs/neovim/consent",
        Some(json!({ "permissions_hash": hash })),
    )
    .await;
    assert_eq!(consent.status, StatusCode::OK);
    let status = send(&app, Method::GET, "/api/neovim/migration", None).await;
    assert_eq!(status.json()["plugin"], "disabled");
    let refused = send(&app, Method::POST, "/api/neovim/migration", None).await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.json()["code"], "NEOVIM_PLUGIN_NOT_ENABLED");

    // 4. Enabled globally: ready, and the migration writes editor_backend.
    let enabled = send(
        &app,
        Method::PUT,
        "/api/plugin-tabs/neovim/enablement",
        Some(json!({ "enabled": true })),
    )
    .await;
    assert_eq!(enabled.status, StatusCode::OK);
    assert_eq!(enabled.json()["enablement"]["effective"], true);
    let status = send(&app, Method::GET, "/api/neovim/migration", None).await;
    assert_eq!(status.json()["plugin"], "ready");

    let migrated = send(&app, Method::POST, "/api/neovim/migration", None).await;
    assert_eq!(migrated.status, StatusCode::OK);
    assert_eq!(migrated.json()["migrated"], true);
    assert_eq!(migrated.json()["editor_backend"], "plugin:neovim");

    let setting = send(
        &app,
        Method::GET,
        "/api/workspace/settings/editor_backend",
        None,
    )
    .await;
    assert_eq!(setting.status, StatusCode::OK);
    assert_eq!(setting.json()["value"], "plugin:neovim");

    // 5. Idempotent: a second migration reports migrated=false and keeps the value.
    let again = send(&app, Method::POST, "/api/neovim/migration", None).await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(again.json()["migrated"], false);
    assert_eq!(again.json()["editor_backend"], "plugin:neovim");

    let status = send(&app, Method::GET, "/api/neovim/migration", None).await;
    assert_eq!(status.json()["current_backend"], "plugin:neovim");
    assert_eq!(status.json()["plugin"], "ready");
}
