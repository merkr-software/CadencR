//! Custom tab plugin API end to end (`docs/CUSTOM_TABS.md` §4.2–§4.5): grant
//! minting, plugin-token enforcement through the real router (so `MatchedPath`
//! is proven available to `auth_middleware`), every policy entry against the
//! routes actually registered, the self routes, the egress relay, the remote
//! listener refusing plugin tokens, and the plugin socket.
//!
//! Its own binary because `settings_store::init` sets process-global state
//! (the plugins dir derives from the settings dir).

mod common;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{header, Method, Request, StatusCode},
    response::{IntoResponse, Redirect},
    routing::get,
    Router,
};
use cadencr_service::{
    api,
    app_state::AppState,
    domain::{
        plugin_tabs::policy::{Binding, POLICY},
        settings_store,
    },
    remote::RemoteContext,
    shared::migrate::{run_migrations, MigrationContext},
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
use tower::ServiceExt;

const TOKEN: &str = "plugin-grants-fixture-token";
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

enum Auth<'a> {
    Main,
    Plugin(&'a str),
    Both(&'a str),
}

async fn send(
    app: &Router,
    method: Method,
    path: &str,
    auth: Auth<'_>,
    body: Option<Value>,
) -> Reply {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:5005");
    request = match auth {
        Auth::Main => request.header("x-cadencr-token", TOKEN),
        Auth::Plugin(token) => request.header("x-cadencr-plugin-token", token),
        Auth::Both(token) => request
            .header("x-cadencr-token", TOKEN)
            .header("x-cadencr-plugin-token", token),
    };
    if body.is_some() {
        request = request.header(header::CONTENT_TYPE, "application/json");
    }
    let body = body.map_or_else(Body::empty, |value| Body::from(value.to_string()));
    let mut request = request.body(body).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 23458))));
    let response = app.clone().oneshot(request).await.unwrap();
    Reply {
        status: response.status(),
        body: to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    }
}

fn write_tab(tabs: &Path, id: &str, permissions: &[&str], origins: &[&str]) {
    let dir = tabs.join(id);
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    std::fs::write(
        dir.join("tab.json"),
        json!({
            "schema_version": 1, "kind": "tab", "id": id, "name": id,
            "version": "0.1.0", "api_version": 1, "entry": "dist/index.html",
            "permissions": permissions,
            "network": { "allowed_origins": origins, "reasoning": "Test upstream." },
            "configuration": [
                { "key": "token", "type": "secret", "label": "Token", "scope": "global" },
                { "key": "unset", "type": "secret", "label": "Unset", "scope": "global" },
                { "key": "group", "type": "string", "label": "Group", "scope": "project", "default": "dir" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(dir.join("dist/index.html"), "<!doctype html>").unwrap();
}

/// A plain-HTTP upstream on loopback for the relay: echoes what it received.
async fn start_upstream() -> String {
    async fn echo(headers: axum::http::HeaderMap) -> impl IntoResponse {
        let seen = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        (
            [("set-cookie", "session=1"), ("x-upstream", "yes")],
            axum::Json(json!({
                "authorization": seen("authorization"),
                "cookie": seen("cookie"),
            })),
        )
    }
    let app = Router::new()
        .route(
            "/echo",
            get(echo).post(|body: axum::body::Bytes| async move {
                (StatusCode::CREATED, [("x-upstream", "posted")], body)
            }),
        )
        .route("/hop", get(|| async { Redirect::temporary("/echo") }))
        .route(
            "/out",
            get(|| async { Redirect::temporary("https://denied.example/") }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    origin
}

struct Fixture {
    state: AppState,
    app: Router,
    origin: String,
    root: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings");
    std::fs::create_dir(&settings).unwrap();
    settings_store::init(settings);
    let origin = start_upstream().await;
    let tabs = root.path().join("plugins/tabs");
    write_tab(&tabs, "graph", &["features:read", "git:read"], &[&origin]);
    let all = [
        "features:read",
        "git:read",
        "forge:read",
        "files:read",
        "agent:observe",
        "workspace:read",
    ];
    write_tab(&tabs, "everything", &all, &[&origin]);
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
    let mut state = AppState::with_pool(pool);
    state.auth_token = TOKEN.into();
    state.port = 5005;
    let app = api::build_router(state.clone());
    Fixture {
        state,
        app,
        origin,
        root,
    }
}

async fn enable(app: &Router, id: &str, project_id: Option<i64>) {
    let tab = send(
        app,
        Method::GET,
        &format!("/api/plugin-tabs/{id}"),
        Auth::Main,
        None,
    )
    .await;
    let hash = tab.json()["permissions_hash"].as_str().unwrap().to_string();
    let path = format!("/api/plugin-tabs/{id}/consent");
    let consent = send(
        app,
        Method::PUT,
        &path,
        Auth::Main,
        Some(json!({ "permissions_hash": hash })),
    )
    .await;
    assert_eq!(consent.status, StatusCode::OK);
    let path = format!("/api/plugin-tabs/{id}/enablement");
    let body = json!({ "project_id": project_id, "enabled": true });
    assert_eq!(
        send(app, Method::PUT, &path, Auth::Main, Some(body))
            .await
            .status,
        StatusCode::OK
    );
}

async fn grant(app: &Router, id: &str, feature_id: i64) -> Reply {
    let path = format!("/api/plugin-tabs/{id}/grants");
    send(
        app,
        Method::POST,
        &path,
        Auth::Main,
        Some(json!({ "feature_id": feature_id })),
    )
    .await
}

async fn token(app: &Router, id: &str) -> String {
    let reply = grant(app, id, FEATURE).await;
    assert_eq!(
        reply.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&reply.body)
    );
    reply.json()["token"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_tab_api_end_to_end() {
    let fixture = fixture().await;
    let app = &fixture.app;
    minting(app).await;
    enable(app, "everything", None).await;
    let graph = token(app, "graph").await;
    enforcement(app, &graph).await;
    every_policy_entry_reaches_its_route(app).await;
    self_routes(app, &graph).await;
    egress(app, &graph, &fixture.origin).await;
    stale_manifest(
        app,
        &fixture.root.path().join("plugins/tabs"),
        &fixture.origin,
    )
    .await;
    remote_listener_refuses_plugin_tokens(&fixture.state, &graph).await;
    socket(&fixture).await;
    revocation(app).await;
}

async fn minting(app: &Router) {
    let disabled = grant(app, "graph", FEATURE).await;
    assert_eq!(
        (disabled.status, disabled.code().as_str()),
        (StatusCode::FORBIDDEN, "PLUGIN_TAB_DISABLED")
    );
    assert_eq!(grant(app, "graph", 999).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        grant(app, "absent", FEATURE).await.code(),
        "PLUGIN_TAB_NOT_FOUND"
    );
    enable(app, "graph", Some(PROJECT)).await;
    let minted = grant(app, "graph", FEATURE).await.json();
    assert_eq!(minted["scopes"], json!(["features:read", "git:read"]));
    assert_eq!(minted["api_version"], 1);
    assert!(minted["expires_at"].as_str().unwrap().ends_with('Z'));
    // Enabled for project 1 only.
    assert_eq!(
        grant(app, "graph", OTHER_FEATURE).await.code(),
        "PLUGIN_TAB_DISABLED"
    );
}

async fn enforcement(app: &Router, graph: &str) {
    let ok = send(
        app,
        Method::GET,
        &format!("/api/features/{FEATURE}"),
        Auth::Plugin(graph),
        None,
    )
    .await;
    assert_eq!(
        ok.status,
        StatusCode::OK,
        "MatchedPath must reach auth_middleware"
    );
    assert_eq!(ok.json()["id"], FEATURE);
    for (path, code) in [
        (
            format!("/api/features/{OTHER_FEATURE}"),
            "PLUGIN_BINDING_DENIED",
        ),
        (
            format!("/api/git/status?feature_id={OTHER_FEATURE}"),
            "PLUGIN_BINDING_DENIED",
        ),
        (
            format!("/api/editor/tree?project_id={PROJECT}&feature_id={FEATURE}"),
            "PLUGIN_SCOPE_DENIED",
        ),
        ("/api/projects".into(), "PLUGIN_SCOPE_DENIED"),
        ("/api/remote/status".into(), "PLUGIN_SCOPE_DENIED"),
        ("/api/plugin-tabs/graph".into(), "PLUGIN_SCOPE_DENIED"),
        ("/api/no-such-route".into(), "PLUGIN_SCOPE_DENIED"),
    ] {
        let reply = send(app, Method::GET, &path, Auth::Plugin(graph), None).await;
        assert_eq!(
            (reply.status, reply.code().as_str()),
            (StatusCode::FORBIDDEN, code),
            "{path}"
        );
    }
    let minting = send(
        app,
        Method::POST,
        "/api/plugin-tabs/graph/grants",
        Auth::Plugin(graph),
        Some(json!({"feature_id": FEATURE})),
    )
    .await;
    assert_eq!(minting.code(), "PLUGIN_SCOPE_DENIED");
    let status = send(
        app,
        Method::GET,
        &format!("/api/git/status?feature_id={FEATURE}"),
        Auth::Plugin(graph),
        None,
    )
    .await;
    assert_eq!(status.status, StatusCode::OK);
    let both = send(app, Method::GET, "/api/projects", Auth::Both(graph), None).await;
    assert_eq!(
        (both.status, both.code().as_str()),
        (StatusCode::BAD_REQUEST, "PLUGIN_TOKEN_CONFLICT")
    );
    let bogus = send(
        app,
        Method::GET,
        "/api/projects",
        Auth::Plugin("bogus"),
        None,
    )
    .await;
    assert_eq!(
        (bogus.status, bogus.code().as_str()),
        (StatusCode::UNAUTHORIZED, "PLUGIN_TOKEN_INVALID")
    );
}

/// The policy table names routes exactly as registered: a template typo would
/// surface here as `PLUGIN_SCOPE_DENIED` for a fully scoped, bound grant.
async fn every_policy_entry_reaches_its_route(app: &Router) {
    let all = token(app, "everything").await;
    for entry in POLICY.iter().filter(|entry| entry.scope.is_some()) {
        let (path, query) = match entry.binding {
            Binding::FeaturePath(param) => (
                entry
                    .path
                    .replace(&format!("{{{param}}}"), &FEATURE.to_string()),
                String::new(),
            ),
            Binding::FeatureQuery(param) => (
                entry.path.to_string(),
                format!("?{param}={FEATURE}&project_id={PROJECT}"),
            ),
            Binding::ProjectQuery(param) => (entry.path.to_string(), format!("?{param}={PROJECT}")),
            Binding::ProjectPath(param) => (
                entry
                    .path
                    .replace(&format!("{{{param}}}"), &PROJECT.to_string()),
                String::new(),
            ),
            Binding::Unbound | Binding::SelfPlugin => (entry.path.to_string(), String::new()),
        };
        let reply = send(
            app,
            Method::GET,
            &format!("{path}{query}"),
            Auth::Plugin(&all),
            None,
        )
        .await;
        assert!(
            reply.status != StatusCode::UNAUTHORIZED && !reply.code().starts_with("PLUGIN_"),
            "{} {path}{query} → {} {}",
            entry.method,
            reply.status,
            String::from_utf8_lossy(&reply.body)
        );
    }
}

async fn self_routes(app: &Router, graph: &str) {
    let plugin = || Auth::Plugin(graph);
    let config = send(
        app,
        Method::GET,
        "/api/plugin-tabs/self/configuration",
        plugin(),
        None,
    )
    .await;
    assert_eq!(config.json(), json!({ "group": "dir" }));
    let main = send(
        app,
        Method::GET,
        "/api/plugin-tabs/self/storage",
        Auth::Main,
        None,
    )
    .await;
    assert_eq!(
        (main.status, main.code().as_str()),
        (StatusCode::UNAUTHORIZED, "PLUGIN_TOKEN_REQUIRED")
    );
    let path = "/api/plugin-tabs/self/storage/layout.v1";
    assert_eq!(
        send(app, Method::GET, path, plugin(), None).await.code(),
        "PLUGIN_TAB_STORAGE_NOT_FOUND"
    );
    let put = send(app, Method::PUT, path, plugin(), Some(json!({ "zoom": 2 }))).await;
    assert_eq!(put.status, StatusCode::NO_CONTENT);
    assert_eq!(
        send(app, Method::GET, path, plugin(), None).await.json(),
        json!({ "zoom": 2 })
    );
    let keys = send(
        app,
        Method::GET,
        "/api/plugin-tabs/self/storage",
        plugin(),
        None,
    )
    .await;
    assert_eq!(keys.json(), json!(["layout.v1"]));
    let bad_key = send(
        app,
        Method::PUT,
        "/api/plugin-tabs/self/storage/a%20b",
        plugin(),
        Some(json!(1)),
    )
    .await;
    assert_eq!(bad_key.code(), "PLUGIN_TAB_STORAGE_KEY_INVALID");
    assert_eq!(
        send(app, Method::DELETE, path, plugin(), None).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        send(
            app,
            Method::GET,
            "/api/plugin-tabs/self/storage",
            plugin(),
            None
        )
        .await
        .json(),
        json!([])
    );
}

struct Relayed {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Relayed {
    fn code(&self) -> String {
        serde_json::from_slice::<Value>(&self.body).unwrap_or(Value::Null)["code"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn upstream_headers(&self) -> Value {
        serde_json::from_str(self.headers["x-cadencr-net-headers"].to_str().unwrap()).unwrap()
    }
}

/// `net.fetch` on the wire (§4.5): URL and method in the query, outbound
/// headers as one JSON header, the body raw both ways.
async fn net_fetch(
    app: &Router,
    token: &str,
    url: &str,
    method: &str,
    headers: Option<Value>,
    body: &[u8],
) -> Relayed {
    let encoded = percent_encoding::utf8_percent_encode(url, percent_encoding::NON_ALPHANUMERIC);
    let query = format!("url={encoded}&method={method}");
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/plugin-tabs/self/net/fetch?{query}"))
        .header("host", "127.0.0.1:5005")
        .header("x-cadencr-plugin-token", token)
        .header(header::CONTENT_TYPE, "application/octet-stream");
    if let Some(headers) = headers {
        request = request.header("x-cadencr-net-headers", headers.to_string());
    }
    let mut request = request.body(Body::from(body.to_vec())).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 23458))));
    let response = app.clone().oneshot(request).await.unwrap();
    Relayed {
        status: response.status(),
        headers: response.headers().clone(),
        body: to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    }
}

async fn egress(app: &Router, graph: &str, origin: &str) {
    let saved = send(
        app,
        Method::PUT,
        "/api/plugin-tabs/graph/configuration",
        Auth::Main,
        Some(json!({ "values": { "token": "s3cret" } })),
    )
    .await;
    assert_eq!(saved.status, StatusCode::OK);
    let denied = net_fetch(app, graph, "https://example.com/", "GET", None, b"").await;
    assert_eq!(
        (denied.status, denied.code().as_str()),
        (StatusCode::FORBIDDEN, "PLUGIN_NETWORK_DENIED")
    );
    assert!(!denied.headers.contains_key("x-cadencr-net-status"));
    let secret = json!({ "Authorization": "Bearer {{secret:token}}", "Cookie": "leak=1" });
    let ok = net_fetch(
        app,
        graph,
        &format!("{origin}/hop"),
        "GET",
        Some(secret),
        b"",
    )
    .await;
    assert_eq!(
        ok.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&ok.body)
    );
    assert_eq!(ok.headers["x-cadencr-net-status"], "200");
    let upstream = ok.upstream_headers();
    assert_eq!(upstream["x-upstream"], "yes");
    assert!(upstream.get("set-cookie").is_none());
    let echoed: Value = serde_json::from_slice(&ok.body).unwrap();
    assert_eq!(
        echoed,
        json!({ "authorization": "Bearer s3cret", "cookie": null })
    );
    // Bytes in, bytes out, the upstream status passed through.
    let payload = [0u8, 159, 146, 150, 255];
    let posted = net_fetch(
        app,
        graph,
        &format!("{origin}/echo"),
        "post",
        None,
        &payload,
    )
    .await;
    assert_eq!(posted.status, StatusCode::OK);
    assert_eq!(posted.headers["x-cadencr-net-status"], "201");
    assert_eq!(posted.upstream_headers()["x-upstream"], "posted");
    assert_eq!(posted.body, payload);
    let unknown = json!({ "x": "{{secret:unset}}" });
    let unknown = net_fetch(
        app,
        graph,
        &format!("{origin}/echo"),
        "GET",
        Some(unknown),
        b"",
    )
    .await;
    assert_eq!(
        (unknown.status, unknown.code().as_str()),
        (StatusCode::BAD_REQUEST, "PLUGIN_TAB_SECRET_UNKNOWN")
    );
    let escape = net_fetch(app, graph, &format!("{origin}/out"), "GET", None, b"").await;
    assert_eq!(escape.code(), "PLUGIN_NETWORK_DENIED");
    let bad = net_fetch(
        app,
        graph,
        &format!("{origin}/echo"),
        "GET",
        Some(json!(["x"])),
        b"",
    )
    .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
}

/// A manifest edited after consent (here: a widened `allowed_origins`) is
/// never acted on, even before — or without — the watcher revoking grants.
async fn stale_manifest(app: &Router, tabs: &Path, origin: &str) {
    let graph = token(app, "graph").await;
    write_tab(
        tabs,
        "graph",
        &["features:read", "git:read"],
        &[origin, "https://evil.example"],
    );
    let widened = net_fetch(app, &graph, &format!("{origin}/echo"), "GET", None, b"").await;
    assert_eq!(
        (widened.status, widened.code().as_str()),
        (StatusCode::UNAUTHORIZED, "PLUGIN_TOKEN_INVALID")
    );
    let after = send(
        app,
        Method::GET,
        &format!("/api/features/{FEATURE}"),
        Auth::Plugin(&graph),
        None,
    )
    .await;
    assert_eq!(
        after.code(),
        "PLUGIN_TOKEN_INVALID",
        "the grant was revoked"
    );
    write_tab(tabs, "graph", &["features:read", "git:read"], &[origin]);
}

async fn remote_listener_refuses_plugin_tokens(state: &AppState, graph: &str) {
    let renderer = tempfile::tempdir().unwrap();
    std::fs::write(renderer.path().join("index.html"), "<!doctype html>").unwrap();
    let context = RemoteContext {
        allowed_hosts: Arc::new(vec!["192.168.1.2:7443".into()]),
        allowed_origins: Arc::new(vec!["https://192.168.1.2:7443".into()]),
        pepper: Arc::new(b"pepper".to_vec()),
    };
    let remote = api::build_remote_router(state.clone(), renderer.path(), context);
    for path in [
        format!("/api/features/{FEATURE}"),
        "/api/plugin-tabs/self/storage".into(),
    ] {
        let mut request = Request::builder()
            .uri(&path)
            .header("host", "192.168.1.2:7443")
            .header("x-cadencr-plugin-token", graph)
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([192, 168, 1, 3], 50000))));
        let response = remote.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
    }
}

async fn next_json(
    socket: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Option<Value> {
    match tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await
        .ok()??
    {
        Ok(Message::Text(text)) => serde_json::from_str(&text).ok(),
        Ok(Message::Close(frame)) => Some(json!({ "close": frame.map(|f| u16::from(f.code)) })),
        _ => None,
    }
}

async fn socket(fixture: &Fixture) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut state = fixture.state.clone();
    state.port = port;
    let app = api::build_router(state.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let graph = token(&fixture.app, "graph").await;
    let mut request = format!("ws://127.0.0.1:{port}/api/plugin-tabs/ws")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(&format!("cadencr-plugin.{graph}")).unwrap(),
    );
    let (mut ws, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(
        response.headers()["sec-websocket-protocol"],
        format!("cadencr-plugin.{graph}")
    );
    let send_env = |action: &str, payload: Value| {
        Message::Text(
            json!({ "id": action, "domain": "plugin", "action": action, "payload": payload })
                .to_string()
                .into(),
        )
    };
    ws.send(send_env("subscribe", json!({ "topic": "git.status" })))
        .await
        .unwrap();
    // The reply always precedes the subscription's first event.
    let subscribed = next_json(&mut ws).await.expect("subscribe reply");
    assert_eq!(subscribed["action"], "subscribed", "{subscribed}");
    let first = next_json(&mut ws).await.expect("the snapshot");
    assert_eq!(first["action"], "event", "{first}");
    assert_eq!(first["payload"]["seq"], 1);
    assert_eq!(first["payload"]["envelope"]["action"], "status");
    std::fs::write(Path::new(&repo_path(&state).await).join("new.txt"), "x").unwrap();
    let changed = next_json(&mut ws)
        .await
        .expect("a git.status event after a write");
    assert_eq!(
        (
            changed["action"].as_str(),
            changed["payload"]["seq"].as_i64()
        ),
        (Some("event"), Some(2))
    );
    ws.send(send_env("subscribe", json!({ "topic": "session.stream" })))
        .await
        .unwrap();
    assert_eq!(
        next_json(&mut ws).await.unwrap()["payload"]["code"],
        "PLUGIN_SCOPE_DENIED"
    );
    ws.send(Message::Text(
        json!({ "id": "x", "domain": "session", "action": "prompt.send", "payload": {} })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    assert_eq!(
        next_json(&mut ws).await.unwrap()["payload"]["code"],
        "PLUGIN_DOMAIN_DENIED"
    );
    assert_eq!(
        state.git_watcher.snapshot_subscribers(FEATURE).await.len(),
        1
    );
    // Revoking the grant closes the socket with 1008 and drops its watchers.
    let revoke = send(
        &fixture.app,
        Method::DELETE,
        "/api/plugin-tabs/grants/current",
        Auth::Plugin(&graph),
        None,
    )
    .await;
    assert_eq!(revoke.status, StatusCode::NO_CONTENT);
    let mut closed = None;
    while let Some(message) = next_json(&mut ws).await {
        if let Some(code) = message.get("close") {
            closed = code.as_u64();
            break;
        }
    }
    assert_eq!(closed, Some(1008));
    for _ in 0..50 {
        if state
            .git_watcher
            .snapshot_subscribers(FEATURE)
            .await
            .is_empty()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(state
        .git_watcher
        .snapshot_subscribers(FEATURE)
        .await
        .is_empty());
    let after = send(
        &fixture.app,
        Method::GET,
        "/api/projects",
        Auth::Plugin(&graph),
        None,
    )
    .await;
    assert_eq!(after.code(), "PLUGIN_TOKEN_INVALID");
}

async fn repo_path(state: &AppState) -> String {
    sqlx::query_scalar("SELECT path FROM projects WHERE id = ?")
        .bind(PROJECT)
        .fetch_one(&state.read_pool)
        .await
        .unwrap()
}

async fn revocation(app: &Router) {
    let graph = token(app, "graph").await;
    let path = "/api/plugin-tabs/graph/enablement";
    let off = send(
        app,
        Method::PUT,
        path,
        Auth::Main,
        Some(json!({ "project_id": PROJECT, "enabled": false })),
    )
    .await;
    assert_eq!(off.status, StatusCode::OK);
    let after = send(
        app,
        Method::GET,
        &format!("/api/features/{FEATURE}"),
        Auth::Plugin(&graph),
        None,
    )
    .await;
    assert_eq!(after.code(), "PLUGIN_TOKEN_INVALID");
}
