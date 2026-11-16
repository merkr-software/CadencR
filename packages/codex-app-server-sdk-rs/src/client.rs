use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, oneshot, Mutex};

use crate::client_io::{spawn_reader, spawn_reaper, spawn_stderr_reader, ReaderState, StderrTail};
use crate::client_launch::profile_aware_command;
use crate::client_state::{Inner, PendingRequestGuard};
use crate::discovery::resolved_codex_command;
use crate::error::SdkError;
use crate::event_queue::EventHub;
use crate::parse::{parse_model, parse_turn_handle};
use crate::protocol::{app_server_args, mcp_server_status_list_params};
use crate::types::{
    parse_mcp_server_status_list, AppServerClientInfo, AppServerEvent, CodexMcpServerStatus,
    CodexModel, TurnHandle,
};

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// `view_image` results contain base64-encoded image data in one JSONL frame.
// Keep the transport bounded while leaving room for normal high-resolution
// screenshots, whose encoded payloads can exceed 8 MiB.
pub(crate) const DEFAULT_MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct CodexAppServerClient {
    pub(crate) inner: Arc<Inner>,
}

#[derive(Debug, Clone, Default, bon::Builder)]
pub struct AppServerSpawnOptions {
    pub env: Option<HashMap<String, String>>,
    /// Environment keys removed from the already login-hydrated service env.
    #[builder(default)]
    pub env_unset: Vec<String>,
    pub cwd: Option<PathBuf>,
    #[builder(default)]
    pub enable_features: Vec<String>,
    #[builder(default)]
    pub client_info: AppServerClientInfo,
    pub request_timeout: Option<Duration>,
    pub max_line_bytes: Option<usize>,
}

impl CodexAppServerClient {
    pub async fn spawn_with_options(options: AppServerSpawnOptions) -> Result<Self, SdkError> {
        let binary = resolved_codex_command().await?;
        let args = app_server_args(&options.enable_features);
        let mut command = profile_aware_command(
            binary.as_os_str(),
            &args,
            options.env.as_ref(),
            &options.env_unset,
        );
        if let Some(cwd) = options.cwd {
            command.current_dir(cwd);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SdkError::Protocol("missing app-server stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SdkError::Protocol("missing app-server stdout".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SdkError::Protocol("missing app-server stderr".to_string()))?;
        let events = EventHub::new();
        let pending = Arc::new(StdMutex::new(HashMap::new()));
        let max_line_bytes = options.max_line_bytes.unwrap_or(DEFAULT_MAX_LINE_BYTES);
        let (kill_tx, kill_rx) = oneshot::channel();
        let inner = Arc::new(Inner {
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pid,
            pending: Arc::clone(&pending),
            events,
            reader_task: StdMutex::new(None),
            stderr_task: StdMutex::new(None),
            reaper_task: StdMutex::new(None),
            kill_tx: StdMutex::new(Some(kill_tx)),
            stderr_tail: Arc::new(StdMutex::new(StderrTail::default())),
            exit: Arc::new(StdMutex::new(None)),
            client_info: options.client_info,
            request_timeout: options.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT),
        });
        let reader_task = spawn_reader(
            ReaderState {
                pending: Arc::clone(&inner.pending),
                events: inner.events.clone(),
                max_line_bytes,
            },
            stdout,
        );
        inner
            .reader_task
            .lock()
            .map_err(|_| SdkError::Protocol("reader task lock poisoned".to_string()))?
            .replace(reader_task);
        inner
            .stderr_task
            .lock()
            .map_err(|_| SdkError::Protocol("stderr task lock poisoned".to_string()))?
            .replace(spawn_stderr_reader(
                stderr,
                max_line_bytes,
                Arc::clone(&inner.stderr_tail),
            ));
        inner
            .reaper_task
            .lock()
            .map_err(|_| SdkError::Protocol("reaper task lock poisoned".to_string()))?
            .replace(spawn_reaper(
                child,
                kill_rx,
                pending,
                inner.events.clone(),
                Arc::clone(&inner.exit),
            ));
        Ok(Self { inner })
    }

    /// Best-effort observer stream; slow receivers may lag. Use
    /// `subscribe_reliable` for runtime event processing.
    pub fn subscribe(&self) -> broadcast::Receiver<AppServerEvent> {
        self.inner.events.subscribe()
    }

    /// Subscribe without losing events when runtime processing falls behind.
    pub fn subscribe_reliable(&self) -> crate::AppServerEventReceiver {
        self.inner.events.subscribe_reliable()
    }

    pub async fn initialize(&self) -> Result<Value, SdkError> {
        let response = self
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": self.inner.client_info.name.clone(),
                        "title": self.inner.client_info.title.clone(),
                        "version": self.inner.client_info.version.clone(),
                    },
                    "capabilities": {
                        "experimentalApi": true,
                    },
                }),
            )
            .await?;
        self.notify("initialized", json!({})).await?;
        Ok(response)
    }

    pub async fn initialize_with_timeout(&self, timeout: Duration) -> Result<Value, SdkError> {
        tokio::time::timeout(timeout, self.initialize())
            .await
            .map_err(|_| SdkError::Timeout("initialize"))?
    }

    pub async fn model_list(&self) -> Result<Vec<CodexModel>, SdkError> {
        let mut cursor = Value::Null;
        let mut models = Vec::new();
        loop {
            let result = self
                .request(
                    "model/list",
                    json!({
                        "cursor": cursor,
                        "limit": 100,
                        "includeHidden": false,
                    }),
                )
                .await?;
            models.extend(
                result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(parse_model),
            );
            cursor = result.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() {
                break;
            }
        }
        Ok(models)
    }

    /// Read Codex's effective configuration, including user and project layers.
    pub async fn config_read(&self, cwd: &std::path::Path) -> Result<Value, SdkError> {
        self.request(
            "config/read",
            json!({
                "cwd": cwd.to_string_lossy(),
                "includeLayers": true,
            }),
        )
        .await
    }

    pub async fn turn_start(&self, params: Value) -> Result<TurnHandle, SdkError> {
        let result = self.request("turn/start", params).await?;
        parse_turn_handle(&result)
    }

    pub async fn turn_steer(
        &self,
        thread_id: &str,
        turn_id: &str,
        input: &[Value],
        client_user_message_id: Option<&str>,
    ) -> Result<(), SdkError> {
        let mut params = json!({
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "input": input,
        });
        if let Some(client_user_message_id) = client_user_message_id {
            params["clientUserMessageId"] = Value::String(client_user_message_id.to_string());
        }
        self.request("turn/steer", params).await.map(|_| ())
    }

    pub async fn turn_interrupt(&self, thread_id: &str, turn_id: &str) -> Result<(), SdkError> {
        self.request(
            "turn/interrupt",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        )
        .await
        .map(|_| ())
    }

    pub async fn mcp_server_status_list(&self) -> Result<Value, SdkError> {
        let mut cursor = Value::Null;
        let mut data = Vec::new();
        loop {
            let result = self
                .request(
                    "mcpServerStatus/list",
                    mcp_server_status_list_params(cursor),
                )
                .await?;
            data.extend(
                result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            cursor = result.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() {
                break;
            }
        }
        Ok(json!({ "data": data }))
    }

    pub async fn available_mcp_servers(&self) -> Result<Vec<CodexMcpServerStatus>, SdkError> {
        let response = self.mcp_server_status_list().await?;
        Ok(parse_mcp_server_status_list(&response))
    }

    pub async fn respond_server_request(&self, id: Value, result: Value) -> Result<(), SdkError> {
        self.write_json(json!({ "id": id, "result": result })).await
    }

    pub async fn reject_server_request(
        &self,
        id: Value,
        code: i64,
        message: &str,
    ) -> Result<(), SdkError> {
        self.write_json(json!({
            "id": id,
            "error": {
                "code": code,
                "message": message,
            },
        }))
        .await
    }

    pub(crate) async fn request(&self, method: &str, params: Value) -> Result<Value, SdkError> {
        self.request_with_timeout(method, params, self.inner.request_timeout)
            .await
    }

    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, SdkError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .map_err(|_| SdkError::Protocol("pending request lock poisoned".to_string()))?
            .insert(id, tx);
        let pending_guard = PendingRequestGuard {
            pending: Arc::clone(&self.inner.pending),
            id,
        };
        let write_result = self
            .write_json(json!({
                "id": id,
                "method": method,
                "params": params,
            }))
            .await;
        write_result?;
        let result = tokio::time::timeout(timeout, rx)
            .await
            .map_err(|_| SdkError::Timeout("request"))?
            .map_err(|_| SdkError::ResponseClosed)?;
        drop(pending_guard);
        result
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), SdkError> {
        self.write_json(json!({
            "method": method,
            "params": params,
        }))
        .await
    }

    pub async fn shutdown(&self) {
        if let Ok(mut kill_tx) = self.inner.kill_tx.lock() {
            if let Some(tx) = kill_tx.take() {
                let _ = tx.send(());
            }
        }
        let reaper_task = self
            .inner
            .reaper_task
            .lock()
            .ok()
            .and_then(|mut task| task.take());
        if let Some(reaper_task) = reaper_task {
            if tokio::time::timeout(Duration::from_secs(2), reaper_task)
                .await
                .is_err()
            {
                tracing::warn!("timed out waiting for codex app-server process to exit");
            }
        }
        let reader_task = self
            .inner
            .reader_task
            .lock()
            .ok()
            .and_then(|mut task| task.take());
        if let Some(reader_task) = reader_task {
            let _ = tokio::time::timeout(Duration::from_secs(2), reader_task).await;
        }
        let stderr_task = self
            .inner
            .stderr_task
            .lock()
            .ok()
            .and_then(|mut task| task.take());
        if let Some(stderr_task) = stderr_task {
            let _ = tokio::time::timeout(Duration::from_secs(2), stderr_task).await;
        }
    }

    async fn write_json(&self, message: Value) -> Result<(), SdkError> {
        let raw = serde_json::to_vec(&message)?;
        let mut stdin = self.inner.stdin.lock().await;
        stdin.write_all(&raw).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }
}
