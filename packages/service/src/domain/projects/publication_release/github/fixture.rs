use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};

use super::binding_body;
use super::transport::Transport;
use crate::domain::projects::publication_release::local::digest;

const COMMIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BINDING: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Default)]
pub(super) struct FixtureOptions {
    pub lose_create: bool,
    pub lose_first_upload: bool,
    pub lose_publish: bool,
    pub foreign_body: bool,
    pub published: bool,
    pub complete_assets: bool,
    pub omit_digest: bool,
    pub promote_on_second_release_list: bool,
    pub extra_asset: bool,
    pub tag_drift: bool,
}

struct Data {
    options: FixtureOptions,
    release: Option<Release>,
    assets: BTreeMap<String, Vec<u8>>,
    writes: usize,
    release_lists: usize,
    lost_upload: bool,
    saw_auth: bool,
}

#[derive(Clone)]
struct Release {
    draft: bool,
    body: String,
}

pub(super) struct Fixture {
    pub transport: Transport,
    data: Arc<Mutex<Data>>,
}

impl Fixture {
    pub async fn start(options: FixtureOptions) -> Self {
        let body = if options.foreign_body {
            "foreign".into()
        } else {
            binding_body("Release notes", BINDING)
        };
        let release = (options.foreign_body || options.published || options.complete_assets)
            .then_some(Release {
                draft: !options.published,
                body,
            });
        let mut assets = BTreeMap::new();
        if options.complete_assets {
            assets.insert("provider.tar.gz".into(), b"archive".to_vec());
            assets.insert("package.json".into(), b"metadata".to_vec());
        }
        if options.extra_asset {
            assets.insert("unexpected.txt".into(), b"unexpected".to_vec());
        }
        let data = Arc::new(Mutex::new(Data {
            options,
            release,
            assets,
            writes: 0,
            release_lists: 0,
            lost_upload: false,
            saw_auth: false,
        }));
        let app = Router::new()
            .route("/{*path}", any(handle))
            .with_state(data.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        Self {
            transport: Transport::fixture(client, format!("http://{address}")),
            data,
        }
    }

    pub fn writes(&self) -> usize {
        self.data.lock().unwrap().writes
    }
    pub fn asset_count(&self) -> usize {
        self.data.lock().unwrap().assets.len()
    }
    pub fn saw_auth_header(&self) -> bool {
        self.data.lock().unwrap().saw_auth
    }
}

async fn handle(State(data): State<Arc<Mutex<Data>>>, request: Request<Body>) -> Response<Body> {
    let method = request.method().clone();
    let uri = request.uri().clone();
    data.lock().unwrap().saw_auth |= request
        .headers()
        .get("authorization")
        .is_some_and(|value| value == "Bearer secret");
    let path = uri.path();
    if method == "GET" && path == "/user" {
        return response(json!({"login":"author"}));
    }
    if method == "GET" && path == "/repos/acme/provider" {
        return response(json!({"id":42,"private":false,"permissions":{"push":true}}));
    }
    if method == "GET"
        && matches!(
            path,
            "/repos/acme/provider/git/ref/tags/v1%2E0%2E0"
                | "/repos/acme/provider/git/ref/tags/v1.0.0"
        )
    {
        let commit = if data.lock().unwrap().options.tag_drift {
            "cccccccccccccccccccccccccccccccccccccccc"
        } else {
            COMMIT
        };
        return response(json!({"object":{"type":"commit","sha":commit}}));
    }
    if method == "GET" && path == "/repos/acme/provider/releases" {
        let mut guard = data.lock().unwrap();
        guard.release_lists += 1;
        if guard.options.promote_on_second_release_list && guard.release_lists == 2 {
            if let Some(release) = &mut guard.release {
                release.draft = false;
            }
        }
        return response(Value::Array(
            guard
                .release
                .clone()
                .into_iter()
                .map(release_json)
                .collect(),
        ));
    }
    if method == "POST" && path == "/repos/acme/provider/releases" {
        let bytes = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
        let payload: Value = serde_json::from_slice(&bytes).unwrap();
        let mut guard = data.lock().unwrap();
        guard.writes += 1;
        let release = Release {
            draft: true,
            body: payload["body"].as_str().unwrap().into(),
        };
        guard.release = Some(release.clone());
        if guard.options.lose_create {
            return failed();
        }
        return response(release_json(release));
    }
    if method == "GET" && path == "/repos/acme/provider/releases/7/assets" {
        return assets_response(&data);
    }
    if method == "GET" && path == "/repos/acme/provider/releases/7" {
        let mut guard = data.lock().unwrap();
        if guard.options.promote_on_second_release_list && guard.assets.is_empty() {
            if let Some(release) = &mut guard.release {
                release.draft = false;
            }
        }
        return guard
            .release
            .clone()
            .map(release_json)
            .map(response)
            .unwrap_or_else(|| failed_status(StatusCode::NOT_FOUND));
    }
    if method == "POST" && path == "/repos/acme/provider/releases/7/assets" {
        return upload(data, uri, request).await;
    }
    if method == "PATCH" && path == "/repos/acme/provider/releases/7" {
        let mut guard = data.lock().unwrap();
        guard.writes += 1;
        guard.release.as_mut().unwrap().draft = false;
        if guard.options.lose_publish {
            return failed();
        }
        return response(release_json(guard.release.clone().unwrap()));
    }
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::empty())
        .unwrap()
}

async fn upload(
    data: Arc<Mutex<Data>>,
    uri: axum::http::Uri,
    request: Request<Body>,
) -> Response<Body> {
    let name = uri
        .query()
        .and_then(|query| query.strip_prefix("name="))
        .unwrap()
        .replace("%2E", ".");
    let bytes = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
    let mut guard = data.lock().unwrap();
    guard.writes += 1;
    guard.assets.insert(name.clone(), bytes.to_vec());
    if guard.options.lose_first_upload && !guard.lost_upload {
        guard.lost_upload = true;
        return failed();
    }
    response(json!({
        "id":9,"name":name,"size":bytes.len(),"state":"uploaded",
        "digest":format!("sha256:{}", digest(&bytes))
    }))
}

fn assets_response(data: &Arc<Mutex<Data>>) -> Response<Body> {
    let guard = data.lock().unwrap();
    response(Value::Array(
        guard
            .assets
            .iter()
            .enumerate()
            .map(|(index, (name, bytes))| {
                json!({
                    "id":index + 1,"name":name,"size":bytes.len(),"state":"uploaded",
                    "digest":if guard.options.omit_digest { Value::Null } else { Value::String(format!("sha256:{}",digest(bytes))) }
                })
            })
            .collect(),
    ))
}

fn release_json(release: Release) -> Value {
    json!({
        "id":7,"tag_name":"v1.0.0","target_commitish":COMMIT,"name":"v1.0.0",
        "body":release.body,"draft":release.draft,"prerelease":false,
        "html_url":"https://github.com/acme/provider/releases/tag/v1.0.0"
    })
}

fn response(value: Value) -> Response<Body> {
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

fn failed() -> Response<Body> {
    failed_status(StatusCode::BAD_GATEWAY)
}

fn failed_status(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(Body::empty())
        .unwrap()
}
