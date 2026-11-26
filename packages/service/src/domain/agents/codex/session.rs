mod close;
pub(super) mod compaction;
mod input;
mod interrupt;
mod options;
mod question;
mod stream;

use crate::domain::agents::adapter::RuntimeEffectiveConfig;
use crate::shared::discard::IgnoreClosed;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use codex_app_server_sdk_rs::{AppServerEventReceiver, CodexAppServerClient};
use serde_json::Value;
use tempfile::TempPath;
use tokio::sync::{mpsc, Mutex, RwLock};
use tracing::warn;

use super::async_questions::PendingAsyncQuestions;
use super::event_loop::spawn_event_loop;
use super::event_system::init_event;
use super::event_turn_state::RootTurnTracker;
use super::mcp_status::parse_mcp_server_statuses;
use super::permissions::PendingCodexRequest;
use super::prompt_receipts::PendingPromptReceipts;
use super::responses::response_value;
use super::session_permissions::{
    is_plan_approval_request_id, permission_kind_for_request_id, take_pending, unanswered_close,
    UnansweredClose,
};
use super::timeouts::with_probe_timeout;
use super::turn_commands::SharedTurnCommands;
use crate::domain::agents::adapter::{
    AgentRuntimeSession, KnownSubagent, RuntimeAccessMode, RuntimeError, RuntimeEvent,
    RuntimeMcpServerStatus, RuntimeMessageRx, RuntimePermissionMode, RuntimePermissionResponse,
    RuntimePermissionResponseKind,
};
use crate::domain::mcp::trusted::CadencrMcpTrust;
pub(super) use options::CodexSessionOptions;
use stream::{error_receiver, spawn_local_forwarder, stream_channel};

pub(super) struct CodexSession {
    client: CodexAppServerClient,
    thread_id: String,
    active_turn_id: Arc<RwLock<Option<String>>>,
    /// Interrupt fallback when `active_turn_id` is None — see `event_turn_state`.
    last_root_turn_id: Arc<RwLock<Option<String>>>,
    child_turn_ids: Arc<RwLock<HashMap<String, Option<String>>>>,
    /// Commands each running turn started, for Stop to end.
    turn_commands: SharedTurnCommands,
    /// Held while `turn/start` has not given the new turn's id; Stop waits.
    turn_start: Mutex<()>,
    model: Arc<RwLock<Option<String>>>,
    effort: Arc<RwLock<Option<String>>>,
    effective_model: Arc<RwLock<Option<String>>>,
    /// The running turn's model: Codex applies `set_model` at the next turn,
    /// a `model/rerouted` within it.
    turn_model: Arc<RwLock<Option<String>>>,
    effective_effort: Arc<RwLock<Option<String>>>,
    summary: Option<String>,
    fast_mode: Arc<RwLock<Option<bool>>>,
    native_fast_mode: bool,
    delivered_controls: RwLock<RuntimeEffectiveConfig>,
    permission_mode: Arc<RwLock<Option<RuntimePermissionMode>>>,
    access_mode: Arc<RwLock<Option<RuntimeAccessMode>>>,
    cwd: PathBuf,
    event_rx: Option<AppServerEventReceiver>,
    local_rx: Option<mpsc::UnboundedReceiver<Result<RuntimeEvent, RuntimeError>>>,
    local_tx: mpsc::UnboundedSender<Result<RuntimeEvent, RuntimeError>>,
    pending_requests: Arc<Mutex<HashMap<String, PendingCodexRequest>>>,
    async_questions: Arc<Mutex<PendingAsyncQuestions>>,
    pending_prompt_receipts: Arc<PendingPromptReceipts>,
    temp_files: Arc<Mutex<Vec<TempPath>>>,
    closing: Arc<AtomicBool>,
    /// Interrupts so far: an input that raced one starts no turn (see `session/input.rs`).
    interrupts: AtomicU64,
    compaction: Arc<compaction::CompactionState>,
    mcp_servers: Arc<RwLock<Vec<RuntimeMcpServerStatus>>>,
    context_window: Option<u64>,
    known_subagents: Vec<KnownSubagent>,
    automatic_mcp: Arc<Mutex<super::trusted_mcp::McpApprovalTurn>>,
    mcp_trust: CadencrMcpTrust,
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
            turn_commands: SharedTurnCommands::default(),
            turn_start: Mutex::new(()),
            model: Arc::new(RwLock::new(options.model)),
            effort: Arc::new(RwLock::new(options.effort)),
            turn_model: Arc::new(RwLock::new(options.effective_model.clone())),
            effective_model: Arc::new(RwLock::new(options.effective_model)),
            effective_effort: Arc::new(RwLock::new(options.effective_effort)),
            summary: options.summary,
            fast_mode: Arc::new(RwLock::new(options.fast_mode)),
            native_fast_mode: options.native_fast_mode,
            delivered_controls: RwLock::default(),
            permission_mode: Arc::new(RwLock::new(options.permission_mode)),
            access_mode: Arc::new(RwLock::new(options.access_mode)),
            cwd: options.cwd,
            event_rx: Some(event_rx),
            local_rx: Some(local_rx),
            local_tx,
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            async_questions: Arc::new(Mutex::new(PendingAsyncQuestions::default())),
            pending_prompt_receipts: Arc::new(PendingPromptReceipts::default()),
            temp_files: Arc::new(Mutex::new(Vec::new())),
            closing: Arc::new(AtomicBool::new(false)),
            interrupts: AtomicU64::new(0),
            compaction: Arc::default(),
            mcp_servers: Arc::new(RwLock::new(Vec::new())),
            context_window: options.context_window,
            known_subagents: Vec::new(),
            automatic_mcp: Default::default(),
            mcp_trust: options.mcp_trust,
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
        self.local_tx.send(Ok(event)).ignore_closed();
    }

    pub(super) async fn start_initial_turn(&self, content: Value) -> Result<(), RuntimeError> {
        let input = self.convert_input(content).await?;
        self.start_turn(input, None).await
    }
}

#[async_trait]
impl AgentRuntimeSession for CodexSession {
    async fn delivered_turn_config(&self) -> Option<RuntimeEffectiveConfig> {
        Some(self.delivered_controls.read().await.clone())
    }

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
        spawn_event_loop()
            .client(self.client.clone())
            .source_rx(source_rx)
            .tx(tx.clone())
            .pending_requests(Arc::clone(&self.pending_requests))
            .async_questions(Arc::clone(&self.async_questions))
            .pending_prompt_receipts(Arc::clone(&self.pending_prompt_receipts))
            .turns(RootTurnTracker {
                active_turn_id: Arc::clone(&self.active_turn_id),
                last_root_turn_id: Arc::clone(&self.last_root_turn_id),
                root_thread_id: self.thread_id.clone(),
                child_turn_ids: Arc::clone(&self.child_turn_ids),
                commands: Arc::clone(&self.turn_commands),
            })
            .model(Arc::clone(&self.turn_model))
            .closing(Arc::clone(&self.closing))
            .compaction(Arc::clone(&self.compaction))
            .known_subagents(std::mem::take(&mut self.known_subagents))
            .automatic_mcp(self.automatic_mcp.clone())
            .mcp_trust(self.mcp_trust)
            .call();
        spawn_local_forwarder(local_rx, tx);
        rx
    }

    fn seed_known_subagents(&mut self, known: Vec<KnownSubagent>) {
        self.known_subagents = known;
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

    fn requires_prompt_queue(&self) -> bool {
        self.compaction.is_active()
    }

    async fn stream_input_with_client_message_id(
        &self,
        content: Value,
        client_message_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        let interrupts_at_entry = self.interrupts.load(Ordering::SeqCst);
        if let Some(client_message_id) = client_message_id.as_ref() {
            self.pending_prompt_receipts
                .enqueue(client_message_id.clone());
        }

        let result = match self.convert_input(content).await {
            Ok(input) => {
                self.stream_converted_input(
                    input,
                    client_message_id.as_deref(),
                    interrupts_at_entry,
                )
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
        self.interrupt_session().await
    }

    async fn terminate_unresponsive_stop(&self, reason: String) -> bool {
        self.terminate_unresponsive_stop_session(reason).await
    }

    async fn compact(&self) -> Result<(), RuntimeError> {
        self.start_compaction().await
    }

    async fn close(&mut self) -> Result<(), RuntimeError> {
        self.close_session().await
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
        if super::async_questions::is_async_question(&response.request_id) {
            return self.respond_async_question(response).await;
        }
        let pending = take_pending(&self.pending_requests, &response.request_id).await?;
        let result = response_value(pending.method, &pending.params, &response);
        self.client
            .respond_server_request(pending.id.clone(), result)
            .await?;
        Ok(())
    }

    fn permission_response_kind(&self, request_id: &str) -> RuntimePermissionResponseKind {
        permission_kind_for_request_id(request_id)
    }

    async fn dismiss_nonblocking_request(&self, request_id: &str) -> Result<bool, RuntimeError> {
        match unanswered_close(request_id) {
            UnansweredClose::DropPlan => Ok(true),
            UnansweredClose::WithdrawQuestion => {
                self.dismiss_async_question(request_id).await?;
                Ok(true)
            }
            UnansweredClose::Blocking => Ok(false),
        }
    }

    fn pid(&self) -> Option<u32> {
        self.client.pid()
    }
}
