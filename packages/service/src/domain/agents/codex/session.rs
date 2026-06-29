use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use codex_app_server_sdk_rs::{AppServerEvent, CodexAppServerClient, SdkError};
use serde_json::Value;
use tempfile::TempPath;
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};
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
    is_plan_approval_request_id, permission_kind_for_request_id, plan_approval_prompt, take_pending,
};
use super::turn_start::turn_start_params;
use super::turn_steer_recovery::{steer_failure_recovery, SteerFailureRecovery};
use super::{with_timeout, with_timeout_sdk};
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeAccessMode, RuntimeError, RuntimeEvent, RuntimeMcpServerStatus,
    RuntimeMessageRx, RuntimePermissionMode, RuntimePermissionResponse,
    RuntimePermissionResponseKind,
};

pub(super) struct CodexSession {
    client: CodexAppServerClient,
    thread_id: String,
    active_turn_id: Arc<RwLock<Option<String>>>,
    /// Interrupt fallback when `active_turn_id` is None — see `event_turn_state`.
    last_root_turn_id: Arc<RwLock<Option<String>>>,
    model: Arc<RwLock<Option<String>>>,
    effort: Arc<RwLock<Option<String>>>,
    permission_mode: Arc<RwLock<Option<RuntimePermissionMode>>>,
    access_mode: Arc<RwLock<Option<RuntimeAccessMode>>>,
    cwd: PathBuf,
    event_rx: Option<broadcast::Receiver<AppServerEvent>>,
    local_rx: Option<mpsc::UnboundedReceiver<Result<RuntimeEvent, RuntimeError>>>,
    local_tx: mpsc::UnboundedSender<Result<RuntimeEvent, RuntimeError>>,
    pending_requests: Arc<Mutex<HashMap<String, PendingCodexRequest>>>,
    pending_prompt_receipts: Arc<PendingPromptReceipts>,
    temp_files: Arc<Mutex<Vec<TempPath>>>,
    closing: Arc<AtomicBool>,
    mcp_servers: Arc<RwLock<Vec<RuntimeMcpServerStatus>>>,
    context_window: Option<u64>,
}

impl CodexSession {
    pub(super) fn new(
        client: CodexAppServerClient,
        thread_id: String,
        model: Option<String>,
        effort: Option<String>,
        permission_mode: Option<RuntimePermissionMode>,
        access_mode: Option<RuntimeAccessMode>,
        cwd: PathBuf,
        event_rx: broadcast::Receiver<AppServerEvent>,
        mcp_servers: Vec<RuntimeMcpServerStatus>,
        context_window: Option<u64>,
    ) -> Self {
        let (local_tx, local_rx) = mpsc::unbounded_channel();
        Self {
            client,
            thread_id,
            active_turn_id: Arc::new(RwLock::new(None)),
            last_root_turn_id: Arc::new(RwLock::new(None)),
            model: Arc::new(RwLock::new(model)),
            effort: Arc::new(RwLock::new(effort)),
            permission_mode: Arc::new(RwLock::new(permission_mode)),
            access_mode: Arc::new(RwLock::new(access_mode)),
            cwd,
            event_rx: Some(event_rx),
            local_rx: Some(local_rx),
            local_tx,
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            pending_prompt_receipts: Arc::new(PendingPromptReceipts::default()),
            temp_files: Arc::new(Mutex::new(Vec::new())),
            closing: Arc::new(AtomicBool::new(false)),
            mcp_servers: Arc::new(RwLock::new(mcp_servers)),
            context_window,
        }
    }

    pub(super) async fn send_init_event(&self) {
        let event = init_event(
            &self.thread_id,
            self.model.read().await.clone(),
            self.context_window,
            self.mcp_servers.read().await.clone(),
        );
        let _ = self.local_tx.send(Ok(event));
    }

    pub(super) async fn start_initial_turn(&self, content: Value) -> Result<(), RuntimeError> {
        let input = self.convert_input(content).await?;
        self.start_turn(input).await
    }

    async fn start_turn(&self, input: Vec<Value>) -> Result<(), RuntimeError> {
        let model = self.model.read().await.clone();
        let effort = self.effort.read().await.clone();
        let permission_mode = self.permission_mode.read().await.clone();
        let access_mode = self.access_mode.read().await.clone();
        let params = turn_start_params(
            &self.thread_id,
            input,
            &self.cwd,
            permission_mode.as_ref(),
            access_mode.as_ref(),
            model,
            effort,
        );
        let turn = with_timeout("Codex turn/start", self.client.turn_start(params)).await?;
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
        let Some(local_rx) = self.local_rx.take() else {
            warn!("Codex local receiver missing");
            return error_receiver("Codex local message stream is unavailable");
        };

        let (tx, rx) = mpsc::channel(256);
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
            },
            self.model.clone(),
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
        let response = with_timeout(
            "Codex mcpServerStatus/list refresh",
            self.client.available_mcp_servers(),
        )
        .await?;
        let servers = parse_mcp_server_statuses(&response, &expected_names);
        *self.mcp_servers.write().await = servers.clone();
        Ok(servers)
    }

    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError> {
        let input = self.convert_input(content).await?;
        self.stream_converted_input(input).await
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

        let result = self.stream_input(content).await;
        if result.is_err() {
            if let Some(client_message_id) = client_message_id.as_deref() {
                self.pending_prompt_receipts.discard(client_message_id);
            }
        }
        result
    }

    async fn interrupt(&self) -> Result<(), RuntimeError> {
        // Live turn: surface RPC failures so the UI shows Stop failed.
        if let Some(turn_id) = self.active_turn_id.read().await.clone() {
            return with_timeout(
                "Codex turn/interrupt",
                self.client.turn_interrupt(&self.thread_id, &turn_id),
            )
            .await;
        }
        // Fallback (race between Stop and the next turn/started). Errors
        // are treated as success — nothing to interrupt is the user's goal.
        let Some(turn_id) = self.last_root_turn_id.read().await.clone() else {
            return Ok(());
        };
        let _ = with_timeout(
            "Codex turn/interrupt (fallback)",
            self.client.turn_interrupt(&self.thread_id, &turn_id),
        )
        .await;
        Ok(())
    }

    async fn compact(&self) -> Result<(), RuntimeError> {
        with_timeout(
            "Codex thread/compact/start",
            self.client.thread_compact_start(&self.thread_id),
        )
        .await
    }

    async fn close(&mut self) {
        self.closing.store(true, Ordering::SeqCst);
        let _ = with_timeout(
            "Codex thread/unsubscribe",
            self.client.thread_unsubscribe(&self.thread_id),
        )
        .await;
        self.temp_files.lock().await.clear();
        self.pending_prompt_receipts.clear();
        self.client.shutdown().await;
    }

    async fn set_model(&self, model: &str) -> Result<(), RuntimeError> {
        *self.model.write().await = Some(model.to_string());
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

fn error_receiver(message: &'static str) -> RuntimeMessageRx {
    let (tx, rx) = mpsc::channel(1);
    let _ = tx.try_send(Err(RuntimeError::new(message)));
    rx
}

impl CodexSession {
    async fn stream_converted_input(&self, input: Vec<Value>) -> Result<(), RuntimeError> {
        let mut recovered_steer_failure = false;
        loop {
            let Some(turn_id) = self.active_turn_id.read().await.clone() else {
                return self.start_turn(input).await;
            };

            let result = with_timeout_sdk(
                "Codex turn/steer",
                self.client.turn_steer(&self.thread_id, &turn_id, &input),
            )
            .await;
            let Err(error) = result else {
                return Ok(());
            };
            if recovered_steer_failure {
                return Err(RuntimeError::from(error));
            }
            if self.recover_steer_failure(&turn_id, &error).await {
                recovered_steer_failure = true;
                continue;
            }
            return Err(RuntimeError::from(error));
        }
    }

    async fn recover_steer_failure(&self, attempted_turn_id: &str, error: &SdkError) -> bool {
        let Some(recovery) = steer_failure_recovery(error) else {
            return false;
        };
        let mut active_turn_id = self.active_turn_id.write().await;
        if active_turn_id.as_deref() != Some(attempted_turn_id) {
            warn!(
                thread_id = %self.thread_id,
                attempted_turn_id = %attempted_turn_id,
                "Codex turn/steer stale failure ignored because active turn changed"
            );
            return true;
        }
        match recovery {
            SteerFailureRecovery::StartNewTurn => {
                warn!(
                    thread_id = %self.thread_id,
                    turn_id = %attempted_turn_id,
                    "Codex turn/steer found no active turn; starting a new turn"
                );
                *active_turn_id = None;
                true
            }
            SteerFailureRecovery::RetryWithTurn(found_turn_id) => {
                warn!(
                    thread_id = %self.thread_id,
                    attempted_turn_id = %attempted_turn_id,
                    found_turn_id = %found_turn_id,
                    "Codex turn/steer active turn mismatch; retrying with server turn"
                );
                *active_turn_id = Some(found_turn_id);
                true
            }
        }
    }

    async fn respond_plan_approval(
        &self,
        response: RuntimePermissionResponse,
    ) -> Result<(), RuntimeError> {
        let prompt = plan_approval_prompt(response.decision, response.feedback);
        self.stream_input(serde_json::Value::String(prompt)).await
    }
}

fn spawn_local_forwarder(
    mut local_rx: mpsc::UnboundedReceiver<Result<RuntimeEvent, RuntimeError>>,
    tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) {
    tokio::spawn(async move {
        while let Some(event) = local_rx.recv().await {
            if tx.send(event).await.is_err() {
                break;
            }
        }
    });
}
