use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, oneshot, Mutex};

use crate::client_io::{spawn_reader, spawn_reaper, spawn_stderr_reader, ReaderState};
use crate::client_state::{Inner, PendingRequestGuard};
use crate::discovery::resolved_codex_command;
use crate::error::SdkError;
use crate::parse::{parse_model, parse_turn_handle};
use crate::protocol::{app_server_args, mcp_server_status_list_params};
use crate::types::{
    parse_mcp_server_status_list, AppServerClientInfo, AppServerEvent, CodexMcpServerStatus,
    CodexModel, TurnHandle,
};

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct CodexAppServerClient {
    inner: Arc<Inner>,
}

#[derive(Debug, Clone, Default)]
pub struct AppServerSpawnOptions {
    pub env: Option<HashMap<String, String>>,
    pub enable_features: Vec<String>,
    pub client_info: AppServerClientInfo,
    pub request_timeout: Option<Duration>,
    pub max_line_bytes: Option<usize>,
}

impl CodexAppServerClient {
    pub async fn spawn_with_options(options: AppServerSpawnOptions) -> Result<Self, SdkError> {
        let binary = resolved_codex_command().await?;
        let mut command = cli_discovery::login_shell_exec_command(
            binary.as_os_str(),
            app_server_args(&options.enable_features)
                .into_iter()
                .map(std::ffi::OsString::from),
        );
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(env) = options.env {
            command.envs(env);
        }
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
        let (events, _) = broadcast::channel(512);
        let pending = Arc::new(StdMutex::new(HashMap::new()));
        let exit_sent = Arc::new(AtomicBool::new(false));
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
            exit_sent: Arc::clone(&exit_sent),
            client_info: options.client_info,
            request_timeout: options.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT),
        });
        let reader_task = spawn_reader(
            ReaderState {
                pending: Arc::clone(&inner.pending),
                events: inner.events.clone(),
                exit_sent: Arc::clone(&inner.exit_sent),
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
            .replace(spawn_stderr_reader(stderr, max_line_bytes));
        inner
            .reaper_task
            .lock()
            .map_err(|_| SdkError::Protocol("reaper task lock poisoned".to_string()))?
            .replace(spawn_reaper(
                child,
                kill_rx,
                pending,
                inner.events.clone(),
                exit_sent,
            ));
        Ok(Self { inner })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppServerEvent> {
        self.inner.events.subscribe()
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

    pub async fn turn_start(&self, params: Value) -> Result<TurnHandle, SdkError> {
        let result = self.request("turn/start", params).await?;
        parse_turn_handle(&result)
    }

    pub async fn turn_steer(
        &self,
        thread_id: &str,
        turn_id: &str,
        input: &[Value],
    ) -> Result<(), SdkError> {
        self.request(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": input,
            }),
        )
        .await
        .map(|_| ())
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

    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
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
