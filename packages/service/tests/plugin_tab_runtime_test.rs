//! The custom tab levels past the page, end to end through the real router
//! (`docs/CUSTOM_TABS.md` §4.6, §4.7): a tab running a declared command, and a
//! tab whose native backend (the shared native fixture,
//! `tests/fixtures/native_tab_backend`) answers requests, calls the
//! Cadencr API with its own scoped token, crashes and is stopped — plus the
//! Activity the user sees for both.
//!
//! Its own binary because `settings_store::init` sets process-global state
//! (the plugins dir derives from the settings dir).

mod common;
#[path = "fixtures/native_tab_backend/install.rs"]
mod native_tab_backend;
#[path = "plugin_tab_runtime_test/realtime.rs"]
mod realtime;

use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

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
use sqlx::sqlite::SqlitePoolOptions;
use tokio::net::TcpListener;
use tower::ServiceExt;

const TOKEN: &str = "plugin-runtime-fixture-token";
const PROJECT: i64 = 1;
const FEATURE: i64 = 10;
const OTHER_FEATURE: i64 = 20;

struct Reply {
    status: StatusCode,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    fn code(&self) -> String {
        self.json()["code"].as_str().unwrap_or_default().to_string()
    }
}

struct Fixture {
    app: Router,
    port: u16,
    repo: std::path::PathBuf,
    tabs: std::path::PathBuf,
    _root: tempfile::TempDir,
}

impl Fixture {
    async fn send(
        &self,
        method: Method,
        path: &str,
        plugin_token: Option<&str>,
        body: Option<Value>,
    ) -> Reply {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", format!("127.0.0.1:{}", self.port));
        request = match plugin_token {
            Some(token) => request.header("x-cadencr-plugin-token", token),
            None => request.header("x-cadencr-token", TOKEN),
        };
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        let body = body.map_or_else(Body::empty, |value| Body::from(value.to_string()));
        let mut request = request.body(body).unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 23459))));
        let response = self.app.clone().oneshot(request).await.unwrap();
        Reply {
            status: response.status(),
            body: to_bytes(response.into_body(), 16 * 1024 * 1024)
                .await
                .unwrap()
                .to_vec(),
        }
    }

    async fn enable(&self, id: &str) {
        let tab = self
            .send(Method::GET, &format!("/api/plugin-tabs/{id}"), None, None)
            .await;
        assert_eq!(tab.json()["errors"], json!([]), "{id}");
        let hash = tab.json()["permissions_hash"].as_str().unwrap().to_string();
        let consent = self
            .send(
                Method::PUT,
                &format!("/api/plugin-tabs/{id}/consent"),
                None,
                Some(json!({ "permissions_hash": hash })),
            )
            .await;
        assert_eq!(consent.status, StatusCode::OK);
        self.set_enabled(id, true).await;
    }

    async fn set_enabled(&self, id: &str, enabled: bool) {
        let reply = self
            .send(
                Method::PUT,
                &format!("/api/plugin-tabs/{id}/enablement"),
                None,
                Some(json!({ "project_id": PROJECT, "enabled": enabled })),
            )
            .await;
        assert_eq!(
            reply.status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&reply.body)
        );
    }

    async fn token(&self, id: &str) -> String {
        let reply = self
            .send(
                Method::POST,
                &format!("/api/plugin-tabs/{id}/grants"),
                None,
                Some(json!({ "feature_id": FEATURE })),
            )
            .await;
        assert_eq!(
            reply.status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&reply.body)
        );
        reply.json()["token"].as_str().unwrap().to_string()
    }

    async fn activity(&self, id: &str) -> Value {
        self.send(
            Method::GET,
            &format!("/api/plugin-tabs/{id}/activity?feature_id={FEATURE}"),
            None,
            None,
        )
        .await
        .json()
    }

    /// The backend state once it settles on `expected` (exit is asynchronous).
    async fn backend_state(&self, id: &str, expected: &str) -> Value {
        for _ in 0..50 {
            let backend = self.activity(id).await["backend"].clone();
            if backend["state"] == expected {
                return backend;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!(
            "backend of {id} never became {expected}: {}",
            self.activity(id).await
        );
    }
}

/// The `backend.binary` key of the platform the tests run on.
fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        other => panic!("custom tab backends do not run on {other:?}"),
    }
}

fn write_tab(tabs: &Path, id: &str, extra: Value) {
    let dir = tabs.join(id);
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    let mut manifest = json!({
        "schema_version": 1, "kind": "tab", "id": id, "name": id,
        "version": "0.1.0", "api_version": 1, "entry": "dist/index.html",
        "permissions": ["features:read"],
    });
    for (key, value) in extra.as_object().unwrap() {
        manifest[key] = value.clone();
    }
    std::fs::write(dir.join("tab.json"), manifest.to_string()).unwrap();
    std::fs::write(dir.join("dist/index.html"), "<!doctype html>").unwrap();
}

async fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings");
    std::fs::create_dir(&settings).unwrap();
    settings_store::init(settings);
    let tabs = root.path().join("plugins/tabs");
    write_tab(
        &tabs,
        "runner",
        json!({"commands": [{"program": "git", "reasoning": "Reads the repository root."}]}),
    );
    write_tab(
        &tabs,
        "native",
        json!({"backend": {
            "protocol": 1,
            "binary": {current_platform(): "bin/backend"},
            "reasoning": "Answers test requests."
        }}),
    );
    native_tab_backend::install(&tabs.join("native"), "bin/backend");
    write_tab(
        &tabs,
        "events",
        json!({"backend": {
            "protocol": 2, "binary": {current_platform(): "bin/events"},
            "reasoning": "Publishes generic clock events."
        }}),
    );
    native_tab_backend::install(&tabs.join("events"), "bin/events");
    let repo = root.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    common::create_test_repo(&repo);
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
    for (id, path) in [
        (PROJECT, repo.to_string_lossy().into_owned()),
        (2, "/tmp/other".into()),
    ] {
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (?, 'P', ?)")
            .bind(id)
            .bind(path)
            .execute(&pool)
            .await
            .unwrap();
    }
    for (id, project) in [(FEATURE, PROJECT), (OTHER_FEATURE, 2)] {
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type) VALUES (?, ?, 'F', 'active', 'ws-session')",
        )
        .bind(id)
        .bind(project)
        .execute(&pool)
        .await
        .unwrap();
    }
    // The backend calls the API over real loopback HTTP.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut state = AppState::with_pool(pool);
    state.auth_token = TOKEN.into();
    state.port = port;
    let app = api::build_router(state);
    let served = app
        .clone()
        .into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, served).await.unwrap() });
    Fixture {
        app,
        port,
        repo: repo.canonicalize().unwrap(),
        tabs: tabs.canonicalize().unwrap(),
        _root: root,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn custom_tab_levels_end_to_end() {
    // A host credential in the service's environment must never reach a tab.
    std::env::set_var("CADENCR_AUTH_TOKEN", "must-not-leak");
    let fixture = fixture().await;
    summaries(&fixture).await;
    fixture.enable("runner").await;
    fixture.enable("native").await;
    commands(&fixture).await;
    backend(&fixture).await;
    presence(&fixture).await;
    fixture.enable("events").await;
    realtime::verify(&fixture).await;
}

async fn summaries(fixture: &Fixture) {
    let runner = fixture
        .send(Method::GET, "/api/plugin-tabs/runner", None, None)
        .await
        .json();
    assert_eq!(runner["access_level"], "commands");
    assert_eq!(runner["commands"][0]["program"], "git");
    let native = fixture
        .send(Method::GET, "/api/plugin-tabs/native", None, None)
        .await
        .json();
    assert_eq!(native["access_level"], "backend");
    assert_eq!(
        native["backend"]["binary"],
        json!({ current_platform(): "bin/backend" })
    );
    assert_eq!(native["backend_availability"], "available");
    assert_eq!(native["warnings"], json!([]));
}

async fn commands(fixture: &Fixture) {
    let token = fixture.token("runner").await;
    let exec = |program: &str, args: Value| json!({ "program": program, "args": args });
    let ran = fixture
        .send(
            Method::POST,
            "/api/plugin-tabs/self/exec",
            Some(&token),
            Some(exec("git", json!(["rev-parse", "--show-toplevel"]))),
        )
        .await;
    assert_eq!(
        ran.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&ran.body)
    );
    let result = ran.json();
    assert_eq!(result["success"], true);
    let toplevel = std::path::PathBuf::from(result["stdout"].as_str().unwrap().trim());
    assert_eq!(toplevel.canonicalize().unwrap(), fixture.repo);
    let failing = fixture
        .send(
            Method::POST,
            "/api/plugin-tabs/self/exec",
            Some(&token),
            Some(exec("git", json!(["not-a-git-command"]))),
        )
        .await
        .json();
    assert_eq!(
        (failing["success"].clone(), failing["exit_code"].clone()),
        (json!(false), json!(1))
    );
    let undeclared = fixture
        .send(
            Method::POST,
            "/api/plugin-tabs/self/exec",
            Some(&token),
            Some(exec("ls", json!([]))),
        )
        .await;
    assert_eq!(
        (undeclared.status, undeclared.code().as_str()),
        (StatusCode::FORBIDDEN, "PLUGIN_EXEC_DENIED")
    );
    // The main token is not a tab; a tab cannot read its own activity.
    let main = fixture
        .send(
            Method::POST,
            "/api/plugin-tabs/self/exec",
            None,
            Some(exec("git", json!([]))),
        )
        .await;
    assert_eq!(main.code(), "PLUGIN_TOKEN_REQUIRED");
    let peek = fixture
        .send(
            Method::GET,
            &format!("/api/plugin-tabs/runner/activity?feature_id={FEATURE}"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(peek.code(), "PLUGIN_SCOPE_DENIED");
    let activity = fixture.activity("runner").await;
    let outcomes: Vec<&str> = activity["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|record| record["outcome"].as_str().unwrap())
        .collect();
    assert_eq!(outcomes, ["refused", "exited", "exited"]);
    assert_eq!(
        activity["commands"][2]["args"],
        json!(["rev-parse", "--show-toplevel"])
    );
    assert_eq!(activity["backend"], Value::Null);
    // A commands-only tab has no backend.
    let none = fixture
        .send(
            Method::POST,
            "/api/plugin-tabs/self/backend",
            Some(&token),
            Some(json!({"method": "echo"})),
        )
        .await;
    assert_eq!(none.code(), "PLUGIN_BACKEND_UNDECLARED");
}

async fn call(fixture: &Fixture, token: &str, method: &str, params: Value) -> Reply {
    fixture
        .send(
            Method::POST,
            "/api/plugin-tabs/self/backend",
            Some(token),
            Some(json!({ "method": method, "params": params })),
        )
        .await
}

async fn backend(fixture: &Fixture) {
    let token = fixture.token("native").await;
    let echoed = call(fixture, &token, "echo", json!({"n": 1})).await;
    assert_eq!(
        echoed.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&echoed.body)
    );
    assert_eq!(echoed.json(), json!({"result": {"n": 1}}));
    let context = call(fixture, &token, "context", Value::Null).await.json()["result"].clone();
    assert_eq!(context["feature_id"], FEATURE);
    assert_eq!(
        std::path::PathBuf::from(context["worktree"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        fixture.repo
    );
    assert_eq!(
        std::path::PathBuf::from(context["cwd"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        fixture.tabs.join("native")
    );
    assert_eq!(context["scopes"], json!(["features:read"]));
    let state_dir = std::path::PathBuf::from(context["state_dir"].as_str().unwrap());
    assert!(state_dir.is_dir() && state_dir.ends_with("tab-state/native"));
    assert!(!state_dir.starts_with(&fixture.tabs));
    assert_eq!(context["leaked"], Value::Null);
    // Its own token reaches its conversation, and only that.
    let api = call(fixture, &token, "api", json!({"other": OTHER_FEATURE}))
        .await
        .json()["result"]
        .clone();
    assert_eq!(api, json!({"own": 200, "other": 403}));
    let failed = call(fixture, &token, "fail", Value::Null).await.json();
    assert_eq!(
        failed,
        json!({"error": {"code": "NOPE", "message": "refused"}})
    );
    let running = fixture.backend_state("native", "running").await;
    assert!(running["pid"].as_u64().is_some());
    assert_eq!(running["starts"], 1);
    assert!(running["stderr_tail"]
        .as_array()
        .unwrap()
        .contains(&json!("backend ready")));
    // A crash fails the request in flight and is shown with its log.
    let crashed = call(fixture, &token, "crash", Value::Null).await;
    assert_eq!(crashed.code(), "PLUGIN_BACKEND_EXITED");
    let status = fixture.backend_state("native", "crashed").await;
    assert_eq!(status["exit_code"], 3);
    assert!(status["stderr_tail"]
        .as_array()
        .unwrap()
        .contains(&json!("about to crash")));
    // The next request starts it again.
    assert_eq!(
        call(fixture, &token, "echo", json!(2)).await.json(),
        json!({"result": 2})
    );
    assert_eq!(
        fixture.backend_state("native", "running").await["starts"],
        2
    );
    // Stopped from the Activity dialog.
    let stop = fixture
        .send(
            Method::DELETE,
            &format!("/api/plugin-tabs/native/backends/{FEATURE}"),
            None,
            None,
        )
        .await;
    assert_eq!(stop.status, StatusCode::NO_CONTENT);
    let stopped = fixture.backend_state("native", "stopped").await;
    assert_eq!(stopped["exit_reason"], "stopped from the tab's Activity");
    // Turning the tab off revokes the backend's grant, which stops it.
    assert_eq!(
        call(fixture, &token, "echo", json!(3)).await.json(),
        json!({"result": 3})
    );
    fixture.backend_state("native", "running").await;
    fixture.set_enabled("native", false).await;
    let off = fixture.backend_state("native", "stopped").await;
    assert_eq!(
        off["exit_reason"],
        "its permissions changed or it was turned off"
    );
}

/// Presence leases are the desktop's (main token): a tab cannot keep a
/// backend alive by itself.
async fn presence(fixture: &Fixture) {
    let lease = "/api/plugin-tabs/native/presence/0b6f3a52-6c1e-4f1e";
    let body = || Some(json!({ "feature_id": FEATURE }));
    let renewed = fixture.send(Method::PUT, lease, None, body()).await;
    assert_eq!(renewed.status, StatusCode::NO_CONTENT);
    let malformed = fixture
        .send(
            Method::PUT,
            "/api/plugin-tabs/native/presence/not%20an%20id",
            None,
            body(),
        )
        .await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    // A conversation deleted from another client: its tabs there still renew.
    let deleted = fixture
        .send(Method::PUT, lease, None, Some(json!({ "feature_id": 999 })))
        .await;
    assert_eq!(deleted.status, StatusCode::NOT_FOUND);
    assert_eq!(deleted.code(), "PLUGIN_TAB_CONVERSATION_NOT_FOUND");
    // Archived, renewals are refused; unarchived, they take the lease again.
    let other = "/api/plugin-tabs/native/presence/5c1d0e7a-0b9e-4d2c";
    let other_body = || Some(json!({ "feature_id": OTHER_FEATURE }));
    let status = format!("/api/features/{OTHER_FEATURE}/status");
    for (status_body, expected, code) in [
        (
            "archived",
            StatusCode::CONFLICT,
            Some("PLUGIN_TAB_CONVERSATION_ARCHIVED"),
        ),
        ("active", StatusCode::NO_CONTENT, None),
    ] {
        let updated = fixture
            .send(
                Method::PUT,
                &status,
                None,
                Some(json!({ "status": status_body })),
            )
            .await;
        assert_eq!(updated.status, StatusCode::OK);
        let renewed = fixture.send(Method::PUT, other, None, other_body()).await;
        assert_eq!(renewed.status, expected);
        if let Some(code) = code {
            assert_eq!(renewed.code(), code);
        }
    }
    fixture.enable("runner").await;
    let token = fixture.token("runner").await;
    let by_a_tab = fixture.send(Method::PUT, lease, Some(&token), body()).await;
    assert!(
        by_a_tab.status.is_client_error() && by_a_tab.status != StatusCode::BAD_REQUEST,
        "{}",
        by_a_tab.status
    );
    let released = fixture.send(Method::DELETE, lease, None, None).await;
    assert_eq!(released.status, StatusCode::NO_CONTENT);
}
