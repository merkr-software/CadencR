//! Provider-neutral ACP session. Implements `AgentRuntimeSession`, dispatches
//! `session/prompt` and `session/cancel`, owns the per-session terminal
//! registry and pending-permissions map, and delegates provider-specific
//! choices (model id mapping, permission decisions, tool name aliases) to
//! `AcpProviderHooks`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{CancelNotification, CloseSessionRequest};
use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeAccessMode, RuntimeError, RuntimeEvent, RuntimeMcpServerStatus,
    RuntimeMessageRx, RuntimePermissionMode, RuntimePermissionResponse,
    RuntimePermissionResponseKind, RuntimeSessionConfigSnapshot, RuntimeSessionConfigValue,
};

use super::super::apply_model_config::apply_model_config;
use super::super::config_options::set_config_option_thinking_effort;
use super::super::events_config_option::mirror_config_snapshot;
use super::super::events_stream_blocks::EventIndexer;
use super::super::mode_switch::set_session_mode;
use super::super::permissions::{reject_all_pending, take_pending, PendingPermissions};
use super::super::prompt_receipts::PendingPromptReceipts;
use super::super::provider_hooks::{AcpProviderHooks, PermissionFallbackOutcome};
use super::super::session_config::AcpSessionConfigState;
use super::super::session_permissions::{PermissionKey, SessionPermissions};
use super::super::turn_lifecycle::{PromptCancel, PromptTurnLock};

/// Channel buffer for the per-session runtime stream. Matches the size used
/// by other adapters; deltas are coalesced upstream so even noisy turns fit.
pub const MESSAGE_CHANNEL_CAPACITY: usize = 1024;
const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Provider-neutral ACP session.
pub struct AcpRuntimeSession {
    pub(in crate::domain::agents::acp::runtime) client: AcpClient,
    pub(in crate::domain::agents::acp::runtime) session_id: Arc<RwLock<Option<String>>>,
    pub(in crate::domain::agents::acp::runtime) current_model: Arc<RwLock<Option<String>>>,
    pub(in crate::domain::agents::acp::runtime) current_effort: Arc<RwLock<Option<String>>>,
    pub(in crate::domain::agents::acp::runtime) current_mode: Arc<RwLock<String>>,
    pub(in crate::domain::agents::acp::runtime) session_config: AcpSessionConfigState,
    pub(in crate::domain::agents::acp::runtime) supports_session_close: bool,
    /// Tracks whether the agent supports `session/set_config_option`.
    /// Defaults to `true`; flipped to `false` on the first `MethodNotFound`
    /// response so we stop wasting round trips and let the legacy
    /// "ride-along on the next prompt" fallback handle model/effort changes.
    pub(in crate::domain::agents::acp::runtime) supports_set_config_option: Arc<AtomicBool>,
    /// Tracks whether the agent supports `session/set_mode`.
    pub(in crate::domain::agents::acp::runtime) supports_set_mode: Arc<AtomicBool>,
    pub(in crate::domain::agents::acp::runtime) pending_permissions: PendingPermissions,
    /// In-memory map of `allow_for_session` / `allow_always` decisions.
    /// Cleared on session close.
    pub(in crate::domain::agents::acp::runtime) session_permissions: SessionPermissions,
    pub(in crate::domain::agents::acp::runtime) closing: Arc<AtomicBool>,
    pub(in crate::domain::agents::acp::runtime) manual_compact_running: Arc<AtomicBool>,
    #[allow(dead_code)]
    pub(in crate::domain::agents::acp::runtime) pid: Option<u32>,
    pub(in crate::domain::agents::acp::runtime) cwd: PathBuf,
    pub(in crate::domain::agents::acp::runtime) context_window: Option<u64>,
    pub(in crate::domain::agents::acp::runtime) configured_mcp_servers: Vec<RuntimeMcpServerStatus>,
    pub(in crate::domain::agents::acp::runtime) mcp_servers:
        Arc<RwLock<Vec<RuntimeMcpServerStatus>>>,
    pub(in crate::domain::agents::acp::runtime) message_rx: Option<RuntimeMessageRx>,
    pub(in crate::domain::agents::acp::runtime) loop_task: Option<JoinHandle<()>>,
    /// Optional provider-spawned listener (e.g. OpenCode subscribes to its
    /// HTTP polling channel so live sub-agent child-session events that the
    /// ACP transport silently drops can be injected into the runtime
    /// channel). Aborted on `close()`.
    pub(in crate::domain::agents::acp::runtime) side_channel_task: Option<JoinHandle<()>>,
    pub(in crate::domain::agents::acp::runtime) local_tx:
        mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    pub(in crate::domain::agents::acp::runtime) hooks: Arc<dyn AcpProviderHooks>,
    /// Shared streaming-block indexer (also held by the event loop) used to
    /// drain still-open text/thinking blocks at turn end (W4).
    pub(in crate::domain::agents::acp::runtime) indexer: Arc<StdMutex<EventIndexer>>,
    /// True while a resumed ACP session may still be replaying durable
    /// transcript updates from `session/load`. Cleared by the first new
    /// prompt dispatch so only pre-prompt replay is suppressed.
    pub(in crate::domain::agents::acp::runtime) replay_suppression: Arc<AtomicBool>,
    /// Client prompt ids waiting for provider-side receipt confirmation.
    pub(in crate::domain::agents::acp::runtime) pending_prompt_receipts: Arc<PendingPromptReceipts>,
    /// Provider-requested prompts that must start only after the current ACP
    /// turn has returned. Stored in the runtime rather than the frontend so a
    /// browser reconnect cannot lose an approved continuation.
    pub(in crate::domain::agents::acp::runtime) pending_followups:
        Arc<RwLock<VecDeque<(String, Value)>>>,
    /// Serialises prompt turns so a second `stream_input` waits for the
    /// in-flight turn (request + post-response drain) to finish before
    /// sending its own `session/prompt` (W4).
    pub(in crate::domain::agents::acp::runtime) prompt_turn_lock: PromptTurnLock,
    pub(in crate::domain::agents::acp::runtime) prompt_cancel: PromptCancel,
}

impl AcpRuntimeSession {
    pub async fn current_session_id(&self) -> Option<String> {
        self.session_id.read().await.clone()
    }

    pub(super) async fn require_session_id(&self) -> Result<String, RuntimeError> {
        self.current_session_id()
            .await
            .ok_or_else(|| RuntimeError::new("ACP session id not yet known"))
    }
}

#[async_trait]
impl AgentRuntimeSession for AcpRuntimeSession {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        self.message_rx
            .take()
            .expect("AcpRuntimeSession message_rx already taken")
    }

    fn context_window(&self) -> Option<u64> {
        self.context_window
    }

    async fn session_id(&self) -> Option<String> {
        self.current_session_id().await
    }

    async fn available_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
        Ok(self.mcp_servers.read().await.clone())
    }

    async fn refresh_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
        let servers = self
            .hooks
            .available_mcp_servers(&self.cwd, self.configured_mcp_servers.clone())
            .await;
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
        // ACP v1 has no portable steering request. A second `session/prompt`
        // while the first is active is agent-defined: Pi queues it, while other
        // agents may reject or merge it. Serialise turns at the host boundary so
        // every accepted user message gets one authoritative turn result and the
        // frontend cannot remain stuck in `agent` after a queued follow-up.
        let _guard = self.prompt_turn_lock.lock().await;
        self.prompt_input(content, client_message_id, true).await
    }

    async fn run_user_shell_command(&self, command: &str) -> Result<(), RuntimeError> {
        let session_id = self.require_session_id().await?;
        let agent = self.current_mode.read().await.clone();
        self.hooks
            .run_user_shell_command(&session_id, &agent, command)
            .await
    }

    async fn interrupt(&self) -> Result<(), RuntimeError> {
        let session_id = self.require_session_id().await?;
        reject_all_pending(&self.client, &self.pending_permissions).await;
        let result = self
            .client
            .send_notification_typed(CancelNotification::new(session_id))
            .await;
        self.prompt_cancel.cancel_current_turn();
        result.map_err(|e| RuntimeError::new(format!("session/cancel failed: {e}")))
    }

    async fn compact(&self) -> Result<(), RuntimeError> {
        super::compact::spawn_compact_turn(self).await?;
        Ok(())
    }

    async fn close(&mut self) {
        self.closing.store(true, Ordering::SeqCst);
        // Prefer the stable lifecycle request when advertised. A connector
        // that accepts it must cancel ongoing work and release the session's
        // resources. Fall back to the baseline cancel notification if the
        // optional request fails so teardown remains bounded and best-effort.
        if let Some(session_id) = self.current_session_id().await {
            let should_cancel = if self.supports_session_close {
                match self
                    .client
                    .send_request_typed(
                        CloseSessionRequest::new(session_id.clone()),
                        SESSION_CLOSE_TIMEOUT,
                    )
                    .await
                {
                    Ok(_) => false,
                    Err(error) => {
                        tracing::warn!(%error, "ACP session/close failed; falling back to session/cancel");
                        true
                    }
                }
            } else {
                true
            };
            if should_cancel {
                let _ = self
                    .client
                    .send_notification_typed(CancelNotification::new(session_id))
                    .await;
            }
        }
        reject_all_pending(&self.client, &self.pending_permissions).await;
        // Drop session-scoped permission grants on close.
        self.session_permissions.clear().await;
        if let Some(task) = self.loop_task.take() {
            task.abort();
        }
        if let Some(task) = self.side_channel_task.take() {
            task.abort();
        }
        self.client.shutdown().await;
    }

    async fn set_model(&self, model: &str) -> Result<(), RuntimeError> {
        // Schema-correct path: `session/set_config_option`. Falls back to
        // ride-along on the next `session/prompt` if the agent rejects the
        // method (older `opencode acp` builds).
        let session_id = self.require_session_id().await?;
        apply_model_config(
            &self.client,
            &session_id,
            &self.current_model,
            &self.current_effort,
            &self.supports_set_config_option,
            &self.session_config,
            self.hooks.as_ref(),
            model,
        )
        .await
    }

    fn applies_thinking_effort_in_place(&self) -> bool {
        true
    }

    async fn set_thinking_effort(&self, effort: Option<String>) -> Result<(), RuntimeError> {
        let session_id = self.require_session_id().await?;
        let update_guard = self.session_config.lock_updates().await;
        let response = set_config_option_thinking_effort(
            &self.client,
            &session_id,
            &self.current_effort,
            &self.supports_set_config_option,
            self.hooks.thinking_effort_config_id(),
            effort.as_deref(),
        )
        .await?;
        self.session_config
            .observe_raw_response(&update_guard, response.as_ref())
            .await
    }

    async fn session_config_snapshot(&self) -> Option<RuntimeSessionConfigSnapshot> {
        Some(self.session_config.snapshot().await)
    }

    async fn set_session_config_option(
        &self,
        config_id: &str,
        value: RuntimeSessionConfigValue,
    ) -> Result<RuntimeSessionConfigSnapshot, RuntimeError> {
        let session_id = self.require_session_id().await?;
        let update_guard = self.session_config.lock_updates().await;
        let snapshot = self
            .session_config
            .set_option(
                &update_guard,
                &self.client,
                &session_id,
                &self.supports_set_config_option,
                config_id,
                value,
            )
            .await?;
        mirror_config_snapshot(
            &snapshot,
            self.hooks.as_ref(),
            &self.current_model,
            &self.current_effort,
        )
        .await;
        Ok(snapshot)
    }

    async fn set_permission_mode(&self, mode: RuntimePermissionMode) -> Result<(), RuntimeError> {
        let mode_id = self
            .hooks
            .mode_for_permission_mode(mode)
            .or_else(|| self.hooks.default_mode_id().map(ToOwned::to_owned))
            .ok_or_else(|| RuntimeError::new("ACP provider does not support permission modes"))?;
        let session_id = self.require_session_id().await?;
        set_session_mode(
            &self.client,
            &session_id,
            &self.current_mode,
            &self.supports_set_mode,
            &mode_id,
        )
        .await
    }

    async fn set_access_mode(&self, mode: RuntimeAccessMode) -> Result<(), RuntimeError> {
        // Apply the change to the provider's in-memory access state so any
        // host-side permission decision (Cursor's Auto Review preflight) takes
        // effect on the current turn. Launch-flag-encoded parts of the access
        // mode still ride the runtime respawn path.
        self.hooks.update_access_mode(mode);
        Ok(())
    }

    async fn respond_permission(
        &self,
        response: RuntimePermissionResponse,
    ) -> Result<(), RuntimeError> {
        // Try the default ACP path first: only if the request_id matches a
        // pending server-request do we answer it directly. Otherwise we fall
        // through to the provider-specific hook (e.g. OpenCode's question
        // sidecar) before surfacing a "no pending" error.
        if let Some(pending) = take_pending(&self.pending_permissions, &response.request_id).await {
            // Cache session/always grants; one-shot variants are no-ops.
            let key = PermissionKey::new(&pending.request.tool_name, &pending.request.tool_input);
            self.session_permissions
                .record(key, response.decision)
                .await;
            let resolution =
                self.hooks
                    .resolve_server_request(&pending.method, &pending.params, &response);
            if let Some(followup) = resolution.followup {
                self.pending_followups
                    .write()
                    .await
                    .push_back((response.request_id.clone(), followup));
            }
            let result = self
                .client
                .respond_server_request(pending.server_id, resolution.response)
                .await
                .map_err(|e| RuntimeError::new(format!("respond_permission write failed: {e}")));
            if result.is_err() {
                self.pending_followups
                    .write()
                    .await
                    .retain(|(request_id, _)| request_id != &response.request_id);
            }
            return result;
        }
        let request_id = response.request_id.clone();
        let decision = response.decision;
        match self.hooks.respond_permission_fallback(response).await? {
            PermissionFallbackOutcome::NotHandled => Err(RuntimeError::new(format!(
                "no pending ACP permission for request_id {}",
                request_id
            ))),
            PermissionFallbackOutcome::Handled => Ok(()),
            PermissionFallbackOutcome::HandledWithCacheKey {
                tool_name,
                tool_input,
            } => {
                let key = PermissionKey::new(&tool_name, &tool_input);
                self.session_permissions.record(key, decision).await;
                Ok(())
            }
        }
    }

    fn permission_response_kind(&self, request_id: &str) -> RuntimePermissionResponseKind {
        self.hooks.permission_response_kind(request_id)
    }

    fn pid(&self) -> Option<u32> {
        self.pid
    }
}
