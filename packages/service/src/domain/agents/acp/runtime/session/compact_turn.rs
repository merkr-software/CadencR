use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::sync::{mpsc, RwLock};

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeCompactMetadata, RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
    RuntimeTurnStartedSource,
};

use super::super::events_stream_blocks::EventIndexer;
use super::super::prompt_turn::{acp_prompt_blocks_from_content, build_prompt_params};
use super::super::provider_hooks::AcpProviderHooks;
use super::super::turn_lifecycle::{
    await_event_loop_barrier, finalize_turn, request_prompt_with_cancel, PromptCancel,
    PromptTurnLock,
};

pub(super) struct CompactTurn {
    pub(super) client: AcpClient,
    pub(super) session_id_lock: Arc<RwLock<Option<String>>>,
    pub(super) current_model: Arc<RwLock<Option<String>>>,
    pub(super) current_effort: Arc<RwLock<Option<String>>>,
    pub(super) supports_set_config_option: Arc<AtomicBool>,
    pub(super) local_tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    pub(super) indexer: Arc<StdMutex<EventIndexer>>,
    pub(super) context_window: Option<u64>,
    pub(super) prompt_turn_lock: PromptTurnLock,
    pub(super) prompt_cancel: PromptCancel,
    pub(super) closing: Arc<AtomicBool>,
    pub(super) running: Arc<AtomicBool>,
    pub(super) replay_suppression: Arc<AtomicBool>,
    pub(super) initial_session_id: String,
    pub(super) compact_prompt: Option<&'static str>,
    pub(super) hooks: Arc<dyn AcpProviderHooks>,
}

impl CompactTurn {
    pub(super) async fn run(self) -> Result<(), RuntimeError> {
        let _running_guard = CompactRunningGuard(Arc::clone(&self.running));
        let _turn_guard = self.prompt_turn_lock.lock().await;
        if self.closing.load(Ordering::SeqCst) {
            return Ok(());
        }

        self.indexer
            .lock()
            .expect("EventIndexer poisoned")
            .take_compact_boundary_emitted();
        let session_id = self
            .session_id_lock
            .read()
            .await
            .clone()
            .unwrap_or(self.initial_session_id);
        self.replay_suppression.store(false, Ordering::SeqCst);
        emit_manual_compact_started(&self.local_tx, Some(session_id.clone())).await;
        let compact_prompt = self
            .compact_prompt
            .ok_or_else(|| RuntimeError::new("ACP provider does not support manual compaction"))?;
        let prompt = acp_prompt_blocks_from_content(Value::String(compact_prompt.to_string()));
        let supports = self.supports_set_config_option.load(Ordering::SeqCst);
        let model = self.current_model.read().await.clone();
        let effort = self.current_effort.read().await.clone();
        let params = build_prompt_params(
            &session_id,
            prompt,
            model.as_deref(),
            effort.as_deref(),
            supports,
        );
        let response =
            request_prompt_with_cancel(&self.client, params, &self.prompt_cancel).await?;
        await_event_loop_barrier(&self.client).await?;
        if let Some(reason) = response.get("stopReason").and_then(Value::as_str) {
            finalize_turn(
                &self.local_tx,
                &self.indexer,
                self.session_id_lock.read().await.clone(),
                self.context_window,
                self.hooks.prompt_response_usage(&response),
                reason,
                &response,
            )
            .await;
        }
        let provider_boundary_emitted = self
            .indexer
            .lock()
            .expect("EventIndexer poisoned")
            .take_compact_boundary_emitted();
        if !provider_boundary_emitted {
            emit_manual_compact_boundary(
                &self.local_tx,
                self.session_id_lock.read().await.clone(),
                self.context_window,
            )
            .await;
        }
        Ok(())
    }
}

struct CompactRunningGuard(Arc<AtomicBool>);

impl Drop for CompactRunningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn emit_manual_compact_started(
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    session_id: Option<String>,
) {
    let event = RuntimeEvent::turn_started_signal(
        session_id,
        RuntimeTurnStartedSource::ManualCompact,
        None,
    );
    let _ = tx.send(Ok(event)).await;
}

async fn emit_manual_compact_boundary(
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    session_id: Option<String>,
    context_window: Option<u64>,
) {
    let compact_metadata = RuntimeCompactMetadata {
        trigger: Some("manual".to_string()),
        pre_tokens: None,
    };
    let raw = serde_json::json!({
        "type": "system",
        "subtype": "compact_boundary",
        "session_id": session_id,
        "compact_metadata": {
            "trigger": compact_metadata.trigger.clone(),
            "pre_tokens": compact_metadata.pre_tokens,
        },
    });
    let event = RuntimeEvent::new(
        RuntimeEventMetadata {
            session_id,
            usage: None,
            context_window,
            raw,
        },
        RuntimeEventKind::CompactBoundary {
            metadata: Some(compact_metadata),
        },
    );
    let _ = tx.send(Ok(event)).await;
}
