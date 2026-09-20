use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode};
use axum::response::Response;
use axum::Router;
use serde_json::Value;

use super::transport::Transport;

pub(super) struct Expected {
    method: Method,
    path: String,
    body: Option<Value>,
    status: StatusCode,
    response: Value,
}

impl Expected {
    pub(super) fn get(path: impl Into<String>, response: Value) -> Self {
        Self::new(Method::GET, path, None, StatusCode::OK, response)
    }

    pub(super) fn missing(path: impl Into<String>) -> Self {
        Self::new(Method::GET, path, None, StatusCode::NOT_FOUND, Value::Null)
    }

    pub(super) fn post(path: impl Into<String>, body: Value, response: Value) -> Self {
        Self::new(
            Method::POST,
            path,
            Some(body),
            StatusCode::CREATED,
            response,
        )
    }

    pub(super) fn failed_post(path: impl Into<String>, body: Value) -> Self {
        Self::new(
            Method::POST,
            path,
            Some(body),
            StatusCode::BAD_GATEWAY,
            Value::Null,
        )
    }

    pub(super) fn conflicting_post(path: impl Into<String>, body: Value) -> Self {
        Self::new(
            Method::POST,
            path,
            Some(body),
            StatusCode::UNPROCESSABLE_ENTITY,
            Value::Null,
        )
    }

    fn new(
        method: Method,
        path: impl Into<String>,
        body: Option<Value>,
        status: StatusCode,
        response: Value,
    ) -> Self {
        Self {
            method,
            path: path.into(),
            body,
            status,
            response,
        }
    }
}

#[derive(Clone)]
pub(super) struct Script {
    expected: Arc<Mutex<VecDeque<Expected>>>,
    failure: Arc<Mutex<Option<String>>>,
}

impl Script {
    pub(super) async fn serve(expected: Vec<Expected>) -> (Self, Transport) {
        let script = Self {
            expected: Arc::new(Mutex::new(expected.into())),
            failure: Arc::new(Mutex::new(None)),
        };
        let app = Router::new().fallback(handle).with_state(script.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let transport = Transport::fixture(client, format!("http://{address}"));
        (script, transport)
    }

    pub(super) fn assert_done(&self) {
        if let Some(failure) = self.failure.lock().unwrap().take() {
            panic!("fixture mismatch: {failure}");
        }
        let remaining = self.expected.lock().unwrap();
        assert!(
            remaining.is_empty(),
            "{} requests were not made",
            remaining.len()
        );
    }
}

async fn handle(State(script): State<Script>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request
        .uri()
        .path_and_query()
        .map_or_else(|| request.uri().path().to_string(), ToString::to_string);
    let bytes = to_bytes(request.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    let actual_body = if bytes.is_empty() {
        None
    } else {
        serde_json::from_slice::<Value>(&bytes).ok()
    };
    let expected = script.expected.lock().unwrap().pop_front();
    let Some(expected) = expected else {
        *script.failure.lock().unwrap() = Some(format!("unexpected {method} {path}"));
        return response(StatusCode::INTERNAL_SERVER_ERROR, Value::Null);
    };
    if method != expected.method || path != expected.path || actual_body != expected.body {
        *script.failure.lock().unwrap() = Some(format!(
            "expected {} {} {:?}, got {method} {path} {actual_body:?}",
            expected.method, expected.path, expected.body
        ));
        return response(StatusCode::INTERNAL_SERVER_ERROR, Value::Null);
    }
    response(expected.status, expected.response)
}

fn response(status: StatusCode, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}
