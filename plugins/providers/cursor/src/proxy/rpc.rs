//! Minimal newline-delimited JSON-RPC 2.0 peer over `serde_json::Value`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
pub const PARSE_ERROR: i64 = -32700;

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(INTERNAL_ERROR, message)
    }

    fn from_value(value: &Value) -> Self {
        Self {
            code: value
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or(INTERNAL_ERROR),
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown JSON-RPC error")
                .to_string(),
            data: value.get("data").cloned(),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(data) = &self.data {
            error["data"] = data.clone();
        }
        error
    }
}

pub type RpcResult = Result<Value, RpcError>;

/// One decoded JSON-RPC frame.
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response(Value),
    Invalid,
}

pub fn classify(mut message: Value) -> Incoming {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    // Taken, not cloned: streamed tool updates can carry whole files.
    let params = message
        .as_object_mut()
        .and_then(|object| object.remove("params"))
        .unwrap_or(Value::Null);
    match (method, message.get("id").cloned()) {
        (Some(method), Some(id)) if !id.is_null() => Incoming::Request { id, method, params },
        (Some(method), _) => Incoming::Notification { method, params },
        (None, Some(_)) => Incoming::Response(message),
        (None, None) => Incoming::Invalid,
    }
}

type Pending = HashMap<String, oneshot::Sender<RpcResult>>;

/// The connector's side of one connection (host or Cursor child): frames go
/// to a writer task; responses resolve requests this side originated.
pub struct Peer {
    label: &'static str,
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn id_key(id: &Value) -> String {
    id.to_string()
}

impl Peer {
    pub fn new(label: &'static str, out: mpsc::UnboundedSender<String>) -> Self {
        Self {
            label,
            out: Mutex::new(Some(out)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    fn send(&self, message: Value) {
        let sent = lock(&self.out)
            .as_ref()
            .is_some_and(|out| out.send(message.to_string()).is_ok());
        if !sent {
            eprintln!(
                "cursor connector: dropped a message to the closed {} connection",
                self.label
            );
        }
    }

    /// Stop writing; the writer task drains what was queued and exits.
    pub fn close(&self) {
        lock(&self.out).take();
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub fn respond(&self, id: Value, result: RpcResult) {
        let message = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error.to_value() }),
        };
        self.send(message);
    }

    /// Write the request now (preserving frame order) and return its receiver.
    pub fn start_request(&self, method: &str, params: Value) -> oneshot::Receiver<RpcResult> {
        let id = json!(self.next_id.fetch_add(1, Ordering::Relaxed));
        self.start_request_with_id(id, method, params)
    }

    pub fn start_request_with_id(
        &self,
        id: Value,
        method: &str,
        params: Value,
    ) -> oneshot::Receiver<RpcResult> {
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id_key(&id), tx);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        rx
    }

    pub async fn request(&self, method: &str, params: Value) -> RpcResult {
        await_response(self.start_request(method, params), self.label).await
    }

    pub async fn request_with_id(&self, id: Value, method: &str, params: Value) -> RpcResult {
        await_response(self.start_request_with_id(id, method, params), self.label).await
    }

    pub async fn request_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> RpcResult {
        let id = json!(self.next_id.fetch_add(1, Ordering::Relaxed));
        let rx = self.start_request_with_id(id.clone(), method, params);
        match tokio::time::timeout(timeout, await_response(rx, self.label)).await {
            Ok(result) => result,
            Err(_) => {
                lock(&self.pending).remove(&id_key(&id));
                Err(RpcError::internal(format!(
                    "`{method}` timed out after {} seconds",
                    timeout.as_secs()
                )))
            }
        }
    }

    /// Route a response frame to its pending request.
    pub fn resolve(&self, message: &Value) {
        let Some(id) = message.get("id") else { return };
        let Some(tx) = lock(&self.pending).remove(&id_key(id)) else {
            eprintln!(
                "cursor connector: {} answered unknown request id {id}",
                self.label
            );
            return;
        };
        let result = match message.get("error") {
            Some(error) => Err(RpcError::from_value(error)),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        // The requester may have timed out and gone away; nothing to deliver.
        let _ = tx.send(result);
    }

    /// Fail every outstanding request (the connection ended).
    pub fn fail_all(&self, message: &str) {
        for (_, tx) in lock(&self.pending).drain() {
            let _ = tx.send(Err(RpcError::internal(message.to_string())));
        }
    }
}

pub async fn await_response(rx: oneshot::Receiver<RpcResult>, label: &str) -> RpcResult {
    rx.await
        .unwrap_or_else(|_| Err(RpcError::internal(format!("the {label} connection closed"))))
}

#[cfg(test)]
mod tests {
    use super::{classify, Incoming, Peer, RpcError};
    use serde_json::{json, Value};
    use std::time::Duration;
    use tokio::sync::mpsc;

    fn frame(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        serde_json::from_str(&rx.try_recv().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn requests_resolve_by_id_and_errors_round_trip() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let peer = Peer::new("test", tx);
        let pending = peer.start_request("ping", json!({}));
        let sent = frame(&mut rx);
        assert_eq!(sent["method"], "ping");
        peer.resolve(&json!({ "jsonrpc": "2.0", "id": sent["id"], "result": { "ok": true } }));
        assert_eq!(pending.await.unwrap(), Ok(json!({ "ok": true })));

        let pending = peer.start_request_with_id(json!("plan-1"), "x", json!({}));
        assert_eq!(frame(&mut rx)["id"], "plan-1");
        peer.resolve(&json!({ "id": "plan-1", "error": { "code": -1, "message": "no" } }));
        assert_eq!(pending.await.unwrap(), Err(RpcError::new(-1, "no")));

        let timed_out = peer
            .request_timeout("slow", json!({}), Duration::from_millis(10))
            .await;
        assert!(timed_out.unwrap_err().message.contains("timed out"));

        let orphan = peer.start_request("y", json!({}));
        peer.fail_all("gone");
        assert_eq!(orphan.await.unwrap().unwrap_err().message, "gone");

        peer.respond(json!(7), Err(RpcError::new(-32601, "nope")));
        assert_eq!(frame(&mut rx)["method"], "slow");
        assert_eq!(frame(&mut rx)["method"], "y");
        assert_eq!(frame(&mut rx)["error"]["code"], -32601);
    }

    #[test]
    fn classifies_frames() {
        assert!(matches!(
            classify(json!({ "id": 1, "method": "a" })),
            Incoming::Request { .. }
        ));
        assert!(matches!(
            classify(json!({ "method": "a" })),
            Incoming::Notification { .. }
        ));
        assert!(matches!(
            classify(json!({ "id": 1, "result": {} })),
            Incoming::Response(_)
        ));
        assert!(matches!(classify(json!({})), Incoming::Invalid));
    }
}
