//! Provider-neutral ACP session. Implements `AgentRuntimeSession`, dispatches
//! `session/prompt` and `session/cancel`, owns the per-session terminal
//! registry and pending-permissions map, and delegates provider-specific
//! choices (model id mapping, permission decisions, tool name aliases) to
//! `AcpProviderHooks`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use agent_client_protocol::schema::CancelNotification;
use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeError, RuntimeEvent, RuntimeMessageRx, RuntimePermissionMode,
    RuntimePermissionResponse,
};

use super::super::config_options::{set_config_option_model, set_config_option_thinking_effort};
use super::super::events_stream_blocks::EventIndexer;
use super::super::mode_switch::set_session_mode;
use super::super::permissions::{
    acp_permission_response_payload, reject_all_pending, take_pending, PendingPermissions,
};
use super::super::prompt_receipts::PendingPromptReceipts;
use super::super::prompt_turn::{acp_prompt_blocks_from_content, build_prompt_params};
use super::super::provider_hooks::{AcpProviderHooks, PermissionFallbackOutcome};
use super::super::session_permissions::{PermissionKey, SessionPermissions};
use super::super::turn_lifecycle::{
    finalize_turn, request_prompt_with_cancel, PromptCancel, PromptTurnLock,
};

/// Channel buffer for the per-session runtime stream. Matches the size used
/// by other adapters; deltas are coalesced upstream so even noisy turns fit.
pub const MESSAGE_CHANNEL_CAPACITY: usize = 1024;

/// Provider-neutral ACP session.
pub struct AcpRuntimeSession {
    pub(in crate::domain::agents::acp::runtime) client: AcpClient,
    pub(in crate::domain::agents::acp::runtime) session_id: Arc<RwLock<Option<String>>>,
    pub(in crate::domain::agents::acp::runtime) current_model: Arc<RwLock<Option<String>>>,
    pub(in crate::domain::agents::acp::runtime) current_effort: Arc<RwLock<Option<String>>>,
    pub(in crate::domain::agents::acp::runtime) current_mode: Arc<RwLock<String>>,
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
    pub(in crate::domain::agents::acp::runtime) context_window: Option<u64>,
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

    async fn prompt_input(
        &self,
        content: Value,
        client_message_id: Option<String>,
        finalize_response: bool,
    ) -> Result<(), RuntimeError> {
        let session_id = self.require_session_id().await?;
        let prompt = acp_prompt_blocks_from_content(content);
        let supports = self.supports_set_config_option.load(Ordering::SeqCst);
        let model = self.current_model.read().await.clone();
        let effort = self.current_effort.read().await.clone();
        let receipt_client_message_id = client_message_id.clone();
        if let Some(client_message_id) = client_message_id {
            self.pending_prompt_receipts
                .enqueue(client_message_id, &prompt);
        }
        let mut params = build_prompt_params(
            &session_id,
            prompt,
            model.as_deref(),
            effort.as_deref(),
            supports,
        );
        if let Some(client_message_id) = receipt_client_message_id.as_deref() {
            params["messageId"] = Value::String(client_message_id.to_string());
        }
        self.replay_suppression.store(false, Ordering::SeqCst);

        // `session/prompt` represents a whole agent turn — sit-idle ceilings
        // need to be huge (minutes of permission drawers + long tools).
        let response =
            match request_prompt_with_cancel(&self.client, params, &self.prompt_cancel).await {
                Ok(response) => response,
                Err(error) => {
                    if let Some(client_message_id) = receipt_client_message_id.as_deref() {
                        self.pending_prompt_receipts
                            .discard_client_message_id(client_message_id);
                    }
                    return Err(error);
                }
            };
        if let Some(client_message_id) = receipt_client_message_id.as_deref() {
            if let Some(event) = self
                .pending_prompt_receipts
                .acknowledge_client_message_id(client_message_id)
            {
                let _ = self.local_tx.send(Ok(event)).await;
            }
        }
        if finalize_response {
            if let Some(reason) = response.get("stopReason").and_then(Value::as_str) {
                tracing::debug!(stop_reason = reason, "session/prompt completed");
                finalize_turn(
                    &self.local_tx,
                    &self.indexer,
                    self.current_session_id().await,
                    self.context_window,
                    self.hooks.prompt_response_usage(&response),
                    reason,
                    &response,
                )
                .await;
            }
        }
        Ok(())
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

    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError> {
        self.stream_input_with_client_message_id(content, None)
            .await
    }

    async fn stream_input_with_client_message_id(
        &self,
        content: Value,
        client_message_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        if let Ok(_guard) = self.prompt_turn_lock.try_lock() {
            return self.prompt_input(content, client_message_id, true).await;
        }

        tracing::debug!("ACP prompt turn already active; sending follow-up as steering prompt");
        self.prompt_input(content, client_message_id, false).await
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
        // Best-effort cancel before tearing down. Ignore failures.
        if let Some(session_id) = self.current_session_id().await {
            let _ = self
                .client
                .send_notification_typed(CancelNotification::new(session_id))
                .await;
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
        set_config_option_model(
            &self.client,
            &session_id,
            &self.current_model,
            &self.supports_set_config_option,
            self.hooks.model_config_id(),
            model,
        )
        .await
    }

    fn applies_thinking_effort_in_place(&self) -> bool {
        true
    }

    async fn set_thinking_effort(&self, effort: Option<String>) -> Result<(), RuntimeError> {
        let session_id = self.require_session_id().await?;
        set_config_option_thinking_effort(
            &self.client,
            &session_id,
            &self.current_effort,
            &self.supports_set_config_option,
            self.hooks.thinking_effort_config_id(),
            effort.as_deref(),
        )
        .await
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
            let payload = acp_permission_response_payload(
                response.decision,
                response.option_id.as_deref(),
                response.feedback.as_deref(),
            );
            return self
                .client
                .respond_server_request(pending.server_id, payload)
                .await
                .map_err(|e| RuntimeError::new(format!("respond_permission write failed: {e}")));
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

    fn pid(&self) -> Option<u32> {
        self.pid
    }
}
