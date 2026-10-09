mod input;
mod interrupt;
mod stream;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use codex_app_server_sdk_rs::{AppServerEventReceiver, CodexAppServerClient};
use serde_json::Value;
use tempfile::TempPath;
use tokio::sync::{mpsc, Mutex, RwLock};
use tracing::warn;

use super::event_loop::spawn_event_loop;
use super::event_system::init_event;
use super::event_turn_state::RootTurnTracker;
use super::input::user_input_from_content;
use super::mcp_status::parse_mcp_server_statuses;
use super::permissions::PendingCodexRequest;
use super::prompt_receipts::PendingPromptReceipts;
use super::responses::response_value;
use super::session_permissions::{
    is_plan_approval_request_id, permission_kind_for_request_id, take_pending,
};
use super::timeouts::{with_control_timeout, with_probe_timeout};
use super::turn_start::{turn_start_params, TurnStartOptions};
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeAccessMode, RuntimeError, RuntimeEvent, RuntimeMcpServerStatus,
    RuntimeMessageRx, RuntimePermissionMode, RuntimePermissionResponse,
    RuntimePermissionResponseKind,
};
use stream::{error_receiver, spawn_local_forwarder, stream_channel};

pub(super) struct CodexSession {
    client: CodexAppServerClient,
    thread_id: String,
    active_turn_id: Arc<RwLock<Option<String>>>,
    /// Interrupt fallback when `active_turn_id` is None — see `event_turn_state`.
    last_root_turn_id: Arc<RwLock<Option<String>>>,
    child_turn_ids: Arc<RwLock<HashMap<String, Option<String>>>>,
    model: Arc<RwLock<Option<String>>>,
    effort: Arc<RwLock<Option<String>>>,
    effective_model: Arc<RwLock<Option<String>>>,
    effective_effort: Arc<RwLock<Option<String>>>,
    fast_mode: Arc<RwLock<Option<bool>>>,
    permission_mode: Arc<RwLock<Option<RuntimePermissionMode>>>,
    access_mode: Arc<RwLock<Option<RuntimeAccessMode>>>,
    cwd: PathBuf,
    event_rx: Option<AppServerEventReceiver>,
    local_rx: Option<mpsc::UnboundedReceiver<Result<RuntimeEvent, RuntimeError>>>,
    local_tx: mpsc::UnboundedSender<Result<RuntimeEvent, RuntimeError>>,
    pending_requests: Arc<Mutex<HashMap<String, PendingCodexRequest>>>,
    pending_prompt_receipts: Arc<PendingPromptReceipts>,
    temp_files: Arc<Mutex<Vec<TempPath>>>,
    closing: Arc<AtomicBool>,
    mcp_servers: Arc<RwLock<Vec<RuntimeMcpServerStatus>>>,
    context_window: Option<u64>,
}

pub(super) struct CodexSessionOptions {
    pub(super) model: Option<String>,
    pub(super) effort: Option<String>,
    pub(super) effective_model: Option<String>,
    pub(super) effective_effort: Option<String>,
    pub(super) fast_mode: Option<bool>,
    pub(super) permission_mode: Option<RuntimePermissionMode>,
    pub(super) access_mode: Option<RuntimeAccessMode>,
    pub(super) cwd: PathBuf,
    pub(super) context_window: Option<u64>,
}

impl CodexSession {
    pub(super) fn new(
        client: CodexAppServerClient,
        thread_id: String,
        event_rx: AppServerEventReceiver,
        options: CodexSessionOptions,
    ) -> Self {
        let (local_tx, local_rx) = mpsc::unbounded_channel();
        Self {
            client,
            thread_id,
            active_turn_id: Arc::new(RwLock::new(None)),
            last_root_turn_id: Arc::new(RwLock::new(None)),
            child_turn_ids: Arc::new(RwLock::new(HashMap::new())),
            model: Arc::new(RwLock::new(options.model)),
            effort: Arc::new(RwLock::new(options.effort)),
            effective_model: Arc::new(RwLock::new(options.effective_model)),
            effective_effort: Arc::new(RwLock::new(options.effective_effort)),
            fast_mode: Arc::new(RwLock::new(options.fast_mode)),
            permission_mode: Arc::new(RwLock::new(options.permission_mode)),
            access_mode: Arc::new(RwLock::new(options.access_mode)),
            cwd: options.cwd,
            event_rx: Some(event_rx),
            local_rx: Some(local_rx),
            local_tx,
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            pending_prompt_receipts: Arc::new(PendingPromptReceipts::default()),
            temp_files: Arc::new(Mutex::new(Vec::new())),
            closing: Arc::new(AtomicBool::new(false)),
            mcp_servers: Arc::new(RwLock::new(Vec::new())),
            context_window: options.context_window,
        }
    }

    pub(super) async fn set_mcp_servers(&self, servers: Vec<RuntimeMcpServerStatus>) {
        *self.mcp_servers.write().await = servers;
    }

    pub(super) async fn send_init_event(&self) {
        let event = init_event(
            &self.thread_id,
            self.effective_model.read().await.clone(),
            self.context_window,
            self.mcp_servers.read().await.clone(),
        );
        let _ = self.local_tx.send(Ok(event));
    }

    pub(super) async fn start_initial_turn(&self, content: Value) -> Result<(), RuntimeError> {
        let input = self.convert_input(content).await?;
        self.start_turn(input, None).await
    }

    async fn start_turn(
        &self,
        input: Vec<Value>,
        client_message_id: Option<&str>,
    ) -> Result<(), RuntimeError> {
        let model = self.model.read().await.clone();
        let effort = self.effort.read().await.clone();
        let collaboration_model = self.effective_model.read().await.clone();
        let collaboration_effort = self.effective_effort.read().await.clone();
        let fast_mode = *self.fast_mode.read().await;
        let permission_mode = self.permission_mode.read().await.clone();
        let access_mode = self.access_mode.read().await.clone();
        let mut params = turn_start_params(
            &self.thread_id,
            input,
            TurnStartOptions {
                cwd: &self.cwd,
                permission_mode: permission_mode.as_ref(),
                access_mode: access_mode.as_ref(),
                model,
                effort,
                collaboration_model,
                collaboration_effort,
                fast_mode,
            },
        );
        if let Some(client_message_id) = client_message_id {
            params["clientUserMessageId"] = Value::String(client_message_id.to_string());
        }
        let turn = self.client.turn_start(params).await?;
        *self.active_turn_id.write().await = Some(turn.id.clone());
        *self.last_root_turn_id.write().await = Some(turn.id);
        Ok(())
    }

    async fn convert_input(&self, content: Value) -> Result<Vec<Value>, RuntimeError> {
        let mut new_files = Vec::new();
        let input = user_input_from_content(content, &mut new_files)?;
        if !new_files.is_empty() {
            self.temp_files.lock().await.extend(new_files);
        }
        Ok(input)
    }
}

#[async_trait]
impl AgentRuntimeSession for CodexSession {
    fn context_window(&self) -> Option<u64> {
        self.context_window
    }

    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        let Some(source_rx) = self.event_rx.take() else {
            warn!("Codex take_message_rx called twice");
            return error_receiver("Codex message stream was already taken");
        };
        let Some(mut local_rx) = self.local_rx.take() else {
            warn!("Codex local receiver missing");
            return error_receiver("Codex local message stream is unavailable");
        };

        let (tx, rx) = stream_channel(&mut local_rx);
        spawn_event_loop(
            self.client.clone(),
            source_rx,
            tx.clone(),
            Arc::clone(&self.pending_requests),
            Arc::clone(&self.pending_prompt_receipts),
            RootTurnTracker {
                active_turn_id: Arc::clone(&self.active_turn_id),
                last_root_turn_id: Arc::clone(&self.last_root_turn_id),
                root_thread_id: self.thread_id.clone(),
                child_turn_ids: Arc::clone(&self.child_turn_ids),
            },
            self.effective_model.clone(),
            Arc::clone(&self.closing),
        );
        spawn_local_forwarder(local_rx, tx);
        rx
    }

    async fn session_id(&self) -> Option<String> {
        Some(self.thread_id.clone())
    }

    async fn available_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
        Ok(self.mcp_servers.read().await.clone())
    }

    async fn refresh_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
        let expected_names = self
            .mcp_servers
            .read()
            .await
            .iter()
            .map(|server| server.name.clone())
            .collect::<Vec<_>>();
        let response = with_probe_timeout(
            "Codex mcpServerStatus/list refresh",
            self.client.available_mcp_servers(),
        )
        .await?;
        let servers = parse_mcp_server_statuses(&response, &expected_names);
        *self.mcp_servers.write().await = servers.clone();
        Ok(servers)
    }

    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError> {
        self.stream_input_with_client_message_id(content, None)
            .await
    }

    async fn stream_input_with_client_message_id(
        &self,
        content: Value,
        client_message_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        if let Some(client_message_id) = client_message_id.as_ref() {
            self.pending_prompt_receipts
                .enqueue(client_message_id.clone());
        }

        let result = match self.convert_input(content).await {
            Ok(input) => {
                self.stream_converted_input(input, client_message_id.as_deref())
                    .await
            }
            Err(error) => Err(error),
        };
        if result.is_err() {
            if let Some(client_message_id) = client_message_id.as_deref() {
                self.pending_prompt_receipts.discard(client_message_id);
            }
        }
        result
    }

    async fn run_user_shell_command(&self, command: &str) -> Result<(), RuntimeError> {
        self.client
            .thread_shell_command(&self.thread_id, command)
            .await
            .map_err(RuntimeError::from)
    }

    async fn interrupt(&self) -> Result<(), RuntimeError> {
        // Snapshot before awaiting RPCs; completion events keep updating the tracker.
        let children = self.child_turn_ids.read().await.clone();
        let root_turn = self.active_turn_id.read().await.clone();
        let root_fallback = self.last_root_turn_id.read().await.clone();
        let mut targets = Vec::with_capacity(children.len() + 1);
        let fallback = root_turn.is_none();
        if let Some(turn) = root_turn.or(root_fallback) {
            targets.push(interrupt::InterruptTarget {
                thread: self.thread_id.clone(),
                turn: Some(turn),
                fallback,
            });
        }
        targets.extend(
            children
                .into_iter()
                .map(|(thread, turn)| interrupt::InterruptTarget {
                    thread,
                    turn,
                    fallback: false,
                }),
        );
        interrupt::interrupt_turns(&self.client, targets).await
    }

    async fn compact(&self) -> Result<(), RuntimeError> {
        self.client
            .thread_compact_start(&self.thread_id)
            .await
            .map_err(RuntimeError::from)
    }

    async fn close(&mut self) -> Result<(), RuntimeError> {
        self.closing.store(true, Ordering::SeqCst);
        let unsubscribe = with_control_timeout(
            "Codex thread/unsubscribe",
            self.client.thread_unsubscribe(&self.thread_id),
        )
        .await;
        self.temp_files.lock().await.clear();
        self.pending_prompt_receipts.clear();
        self.client.shutdown().await;
        unsubscribe.map(|_| ()).map_err(|error| {
            RuntimeError::new(format!(
                "Codex session closed, but thread/unsubscribe failed: {error}"
            ))
        })
    }

    async fn set_model(&self, model: &str) -> Result<(), RuntimeError> {
        *self.model.write().await = Some(model.to_string());
        *self.effective_model.write().await = Some(model.to_string());
        Ok(())
    }

    async fn set_permission_mode(&self, mode: RuntimePermissionMode) -> Result<(), RuntimeError> {
        *self.permission_mode.write().await = Some(mode);
        Ok(())
    }

    async fn set_access_mode(
        &self,
        mode: crate::domain::agents::adapter::RuntimeAccessMode,
    ) -> Result<(), RuntimeError> {
        *self.access_mode.write().await = Some(mode);
        Ok(())
    }

    async fn set_thinking_effort(&self, effort: Option<String>) -> Result<(), RuntimeError> {
        *self.effort.write().await = effort;
        *self.effective_effort.write().await = self.effort.read().await.clone();
        Ok(())
    }

    async fn set_fast_mode(&self, enabled: bool) -> Result<(), RuntimeError> {
        *self.fast_mode.write().await = Some(enabled);
        Ok(())
    }

    async fn respond_permission(
        &self,
        response: RuntimePermissionResponse,
    ) -> Result<(), RuntimeError> {
        if is_plan_approval_request_id(&response.request_id) {
            return self.respond_plan_approval(response).await;
        }
        let pending = take_pending(&self.pending_requests, &response.request_id).await?;
        let result = response_value(&pending.method, &pending.params, &response);
        self.client
            .respond_server_request(pending.id.clone(), result)
            .await?;
        Ok(())
    }

    fn permission_response_kind(&self, request_id: &str) -> RuntimePermissionResponseKind {
        permission_kind_for_request_id(request_id)
    }

    fn pid(&self) -> Option<u32> {
        self.client.pid()
    }
}
