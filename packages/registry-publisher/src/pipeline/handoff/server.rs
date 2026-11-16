//! Native test-only HTTP fake. Only the frozen archive timestamp adapter uses Node.
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
    routing::any,
    Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

mod adapter;
mod routes;

pub(super) struct Server {
    pub(super) base: String,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(super) fn start() -> Self {
        let (send, receive) = std::sync::mpsc::channel();
        let (stop, stopped) = oneshot::channel();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                send.send(format!("http://{}", listener.local_addr().unwrap())).unwrap();
                let state = Arc::new(Mutex::new(json!({"releases":[],"assets":[],"requests":[],
                    "tags":[],"sourceArchives":[["/public/acme/provider/releases/download/v1/provider.tgz",{"data":[97,114,99,104,105,118,101]}]],
                    "nextId":1,"nextReleaseId":42,"discovery":null})));
                let app = Router::new().fallback(any(handle)).with_state(state);
                let (shutdown, shutting_down) = oneshot::channel();
                let mut serving = tokio::spawn(async move {
                    axum::serve(listener, app).with_graceful_shutdown(async { let _ = shutting_down.await; }).await.unwrap();
                });
                let _ = stopped.await;
                shutdown.send(()).expect("fixture serving");
                if tokio::time::timeout(std::time::Duration::from_secs(2), &mut serving).await.is_err() {
                    serving.abort();
                    let _ = serving.await;
                }
            });
            // Adapter workers kill and reap after five seconds, including aborted requests.
            runtime.shutdown_timeout(std::time::Duration::from_secs(6));
        });
        Self {
            base: receive
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap(),
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.take().unwrap().send(()).expect("server running");
        self.thread.take().unwrap().join().unwrap();
    }
}
fn bytes(value: &Value) -> Vec<u8> {
    value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect()
}
fn json_response(status: u16, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}
fn raw(data: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-length", data.len())
        .body(Body::from(data))
        .unwrap()
}
async fn handle(
    State(state): State<Arc<Mutex<Value>>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if uri.path() == "/control" {
        let input: Value = serde_json::from_slice(&body).unwrap();
        if input["action"] == "load" {
            // Never hold the state mutex or block the current-thread reactor during Node work.
            let loaded = tokio::task::spawn_blocking(move || adapter::load(input))
                .await
                .unwrap();
            return match loaded {
                Ok(loaded) => {
                    *state.lock().unwrap() = loaded["remote"].clone();
                    json_response(200, loaded["result"].clone())
                }
                Err(error) => json_response(500, json!({"error":error.to_string()})),
            };
        }
        let mut state = state.lock().unwrap();
        return json_response(200, control(&mut state, input));
    }
    let mut state = state.lock().unwrap();
    let path = uri.path().replace("cadencr/registry", "acme/registry");
    state["requests"]
        .as_array_mut()
        .unwrap()
        .push(json!({"method":method.as_str(),"path":path}));
    let public = path.starts_with("/public/") || path.starts_with("/raw/");
    let auth = headers.get("authorization").map(|v| v.to_str().unwrap());
    if auth
        != if public {
            None
        } else {
            Some("Bearer handoff-token")
        }
    {
        return json_response(403, json!({}));
    }
    routes::route(
        &mut state,
        method.as_str(),
        &path,
        uri.query().unwrap_or(""),
        &body,
    )
}
fn control(state: &mut Value, input: Value) -> Value {
    match input["action"].as_str().unwrap() {
        "configure" => {
            state["publicUnavailable"] =
                json!(input["publicUnavailable"].as_bool().unwrap_or(false));
            state["rawUnavailable"] = json!(input["rawUnavailable"].as_bool().unwrap_or(false));
            if input["retireSources"] == true {
                state["sourceArchives"] = json!([]);
            }
            json!({})
        }
        "stats" => {
            let requests = state["requests"].as_array().unwrap();
            let discovery = if state["discovery"].is_object() {
                json!({"sha":state["discovery"]["sha"],"sha256":crate::hex(&sha2::Sha256::digest(bytes(&state["discovery"]["bytes"])))})
            } else {
                Value::Null
            };
            json!({"writes":requests.iter().filter(|r| r["method"] != "GET").count(),
                "requests":requests,"releases":state["releases"].as_array().unwrap().len(),
                "releaseRecords":state["releases"],"discovery":discovery})
        }
        action => panic!("unexpected fixture action {action}"),
    }
}
use sha2::Digest as _;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn stalled_http_connection_cannot_block_server_shutdown() {
        let server = Server::start();
        let address = server.base.strip_prefix("http://").unwrap();
        let mut connection = std::net::TcpStream::connect(address).unwrap();
        connection
            .write_all(b"POST /control HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{")
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let start = std::time::Instant::now();
        drop(server);
        assert!(start.elapsed() < std::time::Duration::from_secs(4));
        drop(connection);
    }
}
