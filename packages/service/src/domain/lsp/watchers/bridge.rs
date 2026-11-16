//! One stdin owner serializes renderer traffic, registration replies and actual FS events.
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::Message;
use futures::StreamExt;
use notify_debouncer_mini::notify;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, watch};

use super::{events::PendingFileEvents, SessionWatchers};
use crate::domain::lsp::framing::encode_frame;

#[derive(bon::Builder)]
pub(in crate::domain::lsp) struct StdinBridge {
    stdin: ChildStdin,
    activity: Arc<watch::Sender<Instant>>,
    watchers: SessionWatchers,
    events: mpsc::Receiver<notify::Result<notify::Event>>,
    replies: mpsc::Receiver<Value>,
    out: mpsc::UnboundedSender<Message>,
}
impl StdinBridge {
    pub async fn run<S>(mut self, mut stream: S) -> bool
    where
        S: StreamExt<Item = Result<Message, axum::Error>> + Unpin,
    {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        let mut flush_at = None;
        let mut pending = PendingFileEvents::default();
        loop {
            let payload = tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(text))) => Some(initialize(self.watchers.client_frame(&text))),
                    Some(Ok(Message::Close(frame))) => return frame.is_some_and(|frame| frame.code == 1000),
                    Some(Ok(_)) => None,
                    _ => return false,
                },
                reply = self.replies.recv() => reply.map(|reply| reply.to_string()),
                event = self.events.recv() => match event {
                    Some(Ok(event)) => match self.watchers.event(event) {
                        Ok(Some(message)) => {
                            if let Err(error) = pending.push(message) { self.report(&error); return false; }
                            flush_at.get_or_insert_with(|| tokio::time::Instant::now() + Duration::from_millis(75));
                            None
                        },
                        Ok(None) => None,
                        Err(error) => { self.report(&error); return false; }
                    },
                    Some(Err(error)) => {
                        self.report(&format!("Language-server file watcher failed: {error}"));
                        return false;
                    }
                    None => return false,
                },
                _ = wait_for_batch(flush_at) => {
                    flush_at = None;
                    pending.drain().map(|value| value.to_string())
                },
                _ = tick.tick() => {
                    if self.watchers.overflowed() {
                        self.report("Language-server file watcher overflowed; reconnect the language server");
                        return false;
                    }
                    None
                }
            };
            if let Some(payload) = payload {
                let _ = self.activity.send(Instant::now());
                if self
                    .stdin
                    .write_all(&encode_frame(payload.as_bytes()))
                    .await
                    .is_err()
                    || self.stdin.flush().await.is_err()
                {
                    return false;
                }
            }
        }
    }
    fn report(&self, message: &str) {
        tracing::warn!("{message}");
        let value = json!({"jsonrpc":"2.0","method":"window/showMessage","params":{"type":1,"message":message}});
        let _ = self.out.send(Message::Text(value.to_string().into()));
    }
}

async fn wait_for_batch(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// The backend implements this capability completely, even for remote/browser clients.
fn initialize(text: String) -> String {
    if !text.contains("\"initialize\"") {
        return text;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
        return text;
    };
    if value["method"] != "initialize" {
        return text;
    }
    let Some(params) = value.get_mut("params").and_then(Value::as_object_mut) else {
        return text;
    };
    let capabilities = params.entry("capabilities").or_insert_with(|| json!({}));
    let Some(capabilities) = capabilities.as_object_mut() else {
        return text;
    };
    let workspace = capabilities.entry("workspace").or_insert_with(|| json!({}));
    let Some(workspace) = workspace.as_object_mut() else {
        return text;
    };
    workspace.insert(
        "didChangeWatchedFiles".into(),
        json!({"dynamicRegistration":true,"relativePatternSupport":true}),
    );
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initialize_adds_backend_watch_capability_without_changing_other_fields() {
        let value: Value = serde_json::from_str(&initialize(json!({"id":1,"method":"initialize",
            "params":{"capabilities":{"textDocument":{"hover":{}},"workspace":{"configuration":true}}}}).to_string())).unwrap();
        assert_eq!(
            value["params"]["capabilities"]["workspace"]["didChangeWatchedFiles"]
                ["dynamicRegistration"],
            true
        );
        assert_eq!(
            value["params"]["capabilities"]["workspace"]["configuration"],
            true
        );
        assert_eq!(
            initialize("{\"method\":\"exit\"}".into()),
            "{\"method\":\"exit\"}"
        );
    }
}
