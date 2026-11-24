use crate::shared::discard::IgnoreClosed;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::sync::{mpsc, RwLock};

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeCompactMetadata, RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
    RuntimeTurnStartedSource,
};

use super::super::detached_replies::DetachedReply;
use super::super::events_stream_blocks::EventIndexer;
use super::super::prompt_turn::{acp_prompt_blocks_from_content, build_prompt_params};
use super::super::provider_hooks::AcpProviderHooks;
use super::super::turn_lifecycle::{
    finalize_turn, request_prompt_with_cancel, PromptCancel, PromptTurnLock,
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
    pub(super) compact_prompt: Option<String>,
    pub(super) hooks: Arc<dyn AcpProviderHooks>,
}

impl CompactTurn {
    pub(super) async fn run(self) -> Result<(), RuntimeError> {
        let _running_guard = CompactRunningGuard(Arc::clone(&self.running));
        let turn_guard = self.prompt_turn_lock.lock().await;
        if self.closing.load(Ordering::SeqCst) {
            return Ok(());
        }

        {
            let mut indexer = self.indexer.lock().expect("EventIndexer poisoned");
            indexer.detached_reply = DetachedReply::Inactive;
            indexer.take_compact_boundary_emitted();
        }
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
        let prompt = acp_prompt_blocks_from_content(Value::String(compact_prompt));
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
        let Some(reply) =
            request_prompt_with_cancel(&self.client, params, &self.prompt_cancel, &self.local_tx)
                .await?
        else {
            return Ok(());
        };
        let (response, resume_updates) = match reply
            .after_prior_events(&self.client, &self.prompt_cancel, &self.local_tx)
            .await
        {
            Ok(pair) => pair,
            Err(error) if error.is_stop_escalation() => return Ok(()),
            Err(error) => return Err(error),
        };
        let stop_reason = response.get("stopReason").and_then(Value::as_str);
        let cancelled = stop_reason == Some("cancelled");
        let provider_boundary_emitted = self
            .indexer
            .lock()
            .expect("EventIndexer poisoned")
            .take_compact_boundary_emitted();
        let current_session_id = self.session_id_lock.read().await.clone();
        // Emit the compact boundary BEFORE finalizing the turn with Result:
        // StreamReaderTask drains queued prompts on Result, so the divider must
        // land first and a cancelled compaction must not emit a fake boundary.
        if !provider_boundary_emitted && !cancelled {
            emit_manual_compact_boundary(
                &self.local_tx,
                current_session_id.clone(),
                self.context_window,
            )
            .await;
        }
        // Clear the compaction flag before publishing Result so post-turn queue
        // draining sees `requires_prompt_queue() == false` immediately.
        self.running.store(false, Ordering::SeqCst);
        if let Some(reason) = stop_reason {
            finalize_turn(
                &self.local_tx,
                &self.indexer,
                current_session_id,
                self.context_window,
                self.hooks.prompt_response_usage(&response),
                reason,
                &response,
            )
            .await;
        }
        drop(turn_guard);
        drop(resume_updates);
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
    tx.send(Ok(event)).await.ignore_closed();
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
    tx.send(Ok(event)).await.ignore_closed();
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::domain::agents::acp::runtime::standard_hooks::StandardAcpHooks;
    use crate::domain::agents::acp::runtime::test_support::{
        build_in_memory_client, read_request, send_response, spawn_event_barrier_acker,
    };
    use serde_json::json;

    async fn run_compact_with_stop_reason(
        stop_reason: &str,
    ) -> (Vec<RuntimeEvent>, Arc<AtomicBool>, bool) {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        spawn_event_barrier_acker(&client);
        // Capacity 1 forces CompactTurn to still be live inside `finalize_turn`
        // when we observe `Result`, proving `self.running` was cleared BEFORE
        // Result (not merely when CompactRunningGuard dropped on task exit).
        let (tx, mut rx) = mpsc::channel(1);
        let running = Arc::new(AtomicBool::new(true));
        let turn = CompactTurn {
            client: client.clone(),
            session_id_lock: Arc::new(RwLock::new(Some("s-compact".into()))),
            current_model: Arc::new(RwLock::new(None)),
            current_effort: Arc::new(RwLock::new(None)),
            supports_set_config_option: Arc::new(AtomicBool::new(false)),
            local_tx: tx,
            indexer: Arc::new(StdMutex::new(EventIndexer::default())),
            context_window: Some(200_000),
            prompt_turn_lock: PromptTurnLock::default(),
            prompt_cancel: PromptCancel::new(),
            closing: Arc::new(AtomicBool::new(false)),
            running: Arc::clone(&running),
            replay_suppression: Arc::new(AtomicBool::new(false)),
            initial_session_id: "s-compact".into(),
            compact_prompt: Some("/compact".into()),
            hooks: Arc::new(StandardAcpHooks),
        };
        let handle = tokio::spawn(turn.run());
        // Drain the initial ManualCompact turn_started event so the turn can proceed.
        let started = rx.recv().await.unwrap().unwrap();
        let request = read_request(&mut stdin).await;
        assert_eq!(request["method"], "session/prompt");
        send_response(
            &mut stdout,
            request["id"].clone(),
            json!({ "stopReason": stop_reason }),
        )
        .await;

        let mut events = vec![started];
        let mut running_at_result = true;
        while let Some(item) = rx.recv().await {
            let event = item.unwrap();
            if event.is_result() {
                running_at_result = running.load(Ordering::SeqCst);
            }
            events.push(event);
        }
        handle.await.unwrap().unwrap();
        (events, running, running_at_result)
    }

    #[tokio::test]
    async fn compact_turn_emits_boundary_and_clears_running_before_result() {
        let (events, running, running_at_result) = run_compact_with_stop_reason("end_turn").await;
        let boundary_idx = events
            .iter()
            .position(|event| event.compact_metadata().is_some())
            .expect("manual compact must emit a compact boundary");
        let result_idx = events
            .iter()
            .position(RuntimeEvent::is_result)
            .expect("manual compact must emit a Result");
        assert!(
            boundary_idx < result_idx,
            "CompactBoundary ({boundary_idx}) must precede Result ({result_idx})"
        );
        assert!(
            !running_at_result,
            "manual_compact_running must be cleared before Result so post-turn queue draining sees idle"
        );
        assert!(!running.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancelled_compact_turn_does_not_emit_fake_boundary() {
        let (events, running, _) = run_compact_with_stop_reason("cancelled").await;
        assert!(
            events
                .iter()
                .all(|event| event.compact_metadata().is_none()),
            "cancelled compaction must not fabricate a CompactBoundary"
        );
        assert!(events.iter().any(RuntimeEvent::is_result));
        assert!(!running.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn barrier_stop_escalation_in_compact_turn_returns_ok_without_compact_error() {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        // Keep reliable event receiver open without acknowledging barriers.
        let _stalled = client.subscribe_reliable();
        let (tx, mut rx) = mpsc::channel(8);
        let running = Arc::new(AtomicBool::new(true));
        let cancel = PromptCancel::new().with_cancel_grace(Duration::from_millis(80));
        let turn = CompactTurn {
            client: client.clone(),
            session_id_lock: Arc::new(RwLock::new(Some("s-compact-esc".into()))),
            current_model: Arc::new(RwLock::new(None)),
            current_effort: Arc::new(RwLock::new(None)),
            supports_set_config_option: Arc::new(AtomicBool::new(false)),
            local_tx: tx,
            indexer: Arc::new(StdMutex::new(EventIndexer::default())),
            context_window: None,
            prompt_turn_lock: PromptTurnLock::default(),
            prompt_cancel: cancel.clone(),
            closing: Arc::new(AtomicBool::new(false)),
            running: Arc::clone(&running),
            replay_suppression: Arc::new(AtomicBool::new(false)),
            initial_session_id: "s-compact-esc".into(),
            compact_prompt: Some("/compact".into()),
            hooks: Arc::new(StandardAcpHooks),
        };
        let handle = tokio::spawn(turn.run());
        let request = read_request(&mut stdin).await;
        send_response(
            &mut stdout,
            request["id"].clone(),
            json!({ "stopReason": "cancelled" }),
        )
        .await;
        cancel.cancel_current_turn();

        // Must return Ok(()) so spawn_compact_turn does not re-wrap as COMPACT_ERROR.
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("barrier escalation must settle CompactTurn")
            .unwrap()
            .expect("stop escalation must not bubble as COMPACT_ERROR");
        let mut saw_escalation = false;
        while let Ok(item) = rx.try_recv() {
            if let Err(err) = item {
                assert!(err.is_stop_escalation(), "{err:?}");
                saw_escalation = true;
            }
        }
        assert!(saw_escalation);
        assert!(!running.load(Ordering::SeqCst));
    }
}
