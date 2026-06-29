//! Prompt-turn lifecycle helpers.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex as AsyncMutex, Notify, RwLock};

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent, RuntimeUsage};

use super::events_stream_blocks::EventIndexer;
use super::prompt_turn::{acp_prompt_blocks_from_content, build_prompt_params};
use super::provider_hooks::AcpProviderHooks;
use super::turn_result::emit_turn_result;

pub type PromptTurnLock = Arc<AsyncMutex<()>>;

#[derive(Clone, Default)]
pub struct PromptCancel {
    epoch: Arc<AtomicU64>,
    notify: Arc<Notify>,
}

impl PromptCancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel_current_turn(&self) {
        self.epoch.fetch_add(1, Ordering::Relaxed);
        self.notify.notify_waiters();
    }

    fn current_epoch(&self) -> u64 {
        self.epoch.load(Ordering::Relaxed)
    }

    async fn wait_for_cancel_after(&self, epoch: u64) {
        loop {
            if self.current_epoch() > epoch {
                return;
            }
            self.notify.notified().await;
        }
    }
}

const CANCEL_GRACE: Duration = Duration::from_millis(150);

#[allow(clippy::too_many_arguments)]
pub async fn drive_initial_prompt(
    client: &AcpClient,
    session_id_lock: &Arc<RwLock<Option<String>>>,
    current_model_lock: &Arc<RwLock<Option<String>>>,
    current_effort_lock: &Arc<RwLock<Option<String>>>,
    content: Value,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    indexer: &Arc<StdMutex<EventIndexer>>,
    context_window: Option<u64>,
    hooks: &dyn AcpProviderHooks,
    prompt_turn_lock: &PromptTurnLock,
    prompt_cancel: &PromptCancel,
) -> Result<(), RuntimeError> {
    let _guard = prompt_turn_lock.lock().await;
    let session_id = session_id_lock
        .read()
        .await
        .clone()
        .ok_or_else(|| RuntimeError::new("ACP session_id missing for initial prompt"))?;
    let prompt = acp_prompt_blocks_from_content(content);
    let model = current_model_lock.read().await.clone();
    let effort = current_effort_lock.read().await.clone();
    let params = build_prompt_params(
        &session_id,
        prompt,
        model.as_deref(),
        effort.as_deref(),
        false,
    );
    let response = request_prompt_with_cancel(client, params, prompt_cancel).await?;
    if let Some(reason) = response.get("stopReason").and_then(Value::as_str) {
        finalize_turn(
            tx,
            indexer,
            Some(session_id),
            context_window,
            hooks.prompt_response_usage(&response),
            reason,
            &response,
        )
        .await;
    }
    Ok(())
}

pub async fn request_prompt_with_cancel(
    client: &AcpClient,
    params: Value,
    prompt_cancel: &PromptCancel,
) -> Result<Value, RuntimeError> {
    let start_epoch = prompt_cancel.current_epoch();
    let prompt =
        client.request_with_timeout("session/prompt", params, Duration::from_secs(60 * 60));
    tokio::pin!(prompt);

    tokio::select! {
        result = &mut prompt => prompt_result(result),
        _ = prompt_cancel.wait_for_cancel_after(start_epoch) => {
            match tokio::time::timeout(CANCEL_GRACE, &mut prompt).await {
                Ok(result) => prompt_result_after_cancel(result),
                Err(_) => {
                    client.shutdown().await;
                    Ok(cancelled_prompt_response())
                }
            }
        }
    }
}

fn prompt_result(
    result: Result<Value, crate::domain::agents::acp::error::AcpError>,
) -> Result<Value, RuntimeError> {
    result.map_err(|e| RuntimeError::new(format!("session/prompt failed: {e}")))
}

fn prompt_result_after_cancel(
    result: Result<Value, crate::domain::agents::acp::error::AcpError>,
) -> Result<Value, RuntimeError> {
    Ok(result.unwrap_or_else(|_| cancelled_prompt_response()))
}

fn cancelled_prompt_response() -> Value {
    json!({ "stopReason": "cancelled", "cadencrSynthetic": true })
}

/// Drain open streaming blocks, then emit the per-turn `Result` envelope.
pub async fn finalize_turn(
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    indexer: &Arc<StdMutex<EventIndexer>>,
    session_id: Option<String>,
    context_window: Option<u64>,
    prompt_response_usage: Option<RuntimeUsage>,
    stop_reason: &str,
    response: &Value,
) {
    let drained = {
        let mut guard = indexer.lock().expect("EventIndexer poisoned");
        guard.drain_open_blocks(session_id.as_deref())
    };
    for event in drained {
        if tx.send(Ok(event)).await.is_err() {
            tracing::debug!("ACP runtime channel closed during turn-end drain");
            return;
        }
    }
    emit_turn_result(
        tx,
        session_id,
        context_window,
        prompt_response_usage,
        stop_reason,
        response,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::{drive_initial_prompt, finalize_turn, EventIndexer, PromptCancel, PromptTurnLock};
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::{AcpClient, AcpClientInfo};
    use crate::domain::agents::adapter::RuntimePermissionMode;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::sync::{mpsc, Mutex as AsyncMutex, RwLock};

    struct NoUsageHooks;

    #[async_trait::async_trait]
    impl AcpProviderHooks for NoUsageHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }
        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }
        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            None
        }
    }

    async fn build_in_memory_client() -> (AcpClient, DuplexStream, BufReader<DuplexStream>) {
        let (client_reads_stdout, agent_writes_stdout) = duplex(64 * 1024);
        let (agent_reads_stdin, client_writes_stdin) = duplex(64 * 1024);
        let client = AcpClient::spawn_with_streams(
            Box::new(client_writes_stdin),
            client_reads_stdout,
            tokio::io::empty(),
            AcpClientInfo::default(),
        )
        .await
        .unwrap();
        (
            client,
            agent_writes_stdout,
            BufReader::new(agent_reads_stdin),
        )
    }

    async fn read_one_request(reader: &mut BufReader<DuplexStream>) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    async fn reply_with_stop(stdout: &mut DuplexStream, id: Value, stop_reason: &str) {
        let frame = format!(
            "{}\n",
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "stopReason": stop_reason }
            })
        );
        stdout.write_all(frame.as_bytes()).await.unwrap();
    }

    #[tokio::test]
    async fn finalize_turn_drains_open_text_block_before_emitting_result() {
        let (tx, mut rx) = mpsc::channel(8);
        let indexer = Arc::new(StdMutex::new(EventIndexer::default()));
        // Open a streaming text block, simulating in-flight assistant text.
        indexer.lock().unwrap().open_text_block();
        finalize_turn(
            &tx,
            &indexer,
            Some("s-1".into()),
            None,
            None,
            "end_turn",
            &json!({}),
        )
        .await;
        let first = rx.recv().await.unwrap().unwrap();
        assert!(
            !first.is_result(),
            "expected ContentBlockStop before the Result event"
        );
        let second = rx.recv().await.unwrap().unwrap();
        assert!(second.is_result(), "Result event must follow the drain");
        assert!(indexer.lock().unwrap().current_text_index.is_none());
    }

    #[tokio::test]
    async fn finalize_turn_drains_on_cancelled_stop_reason() {
        let (tx, mut rx) = mpsc::channel(8);
        let indexer = Arc::new(StdMutex::new(EventIndexer::default()));
        indexer.lock().unwrap().open_text_block();
        finalize_turn(
            &tx,
            &indexer,
            Some("s-1".into()),
            None,
            None,
            "cancelled",
            &json!({}),
        )
        .await;
        let first = rx.recv().await.unwrap().unwrap();
        assert!(!first.is_result());
        let second = rx.recv().await.unwrap().unwrap();
        assert!(second.is_result());
        assert_eq!(second.raw_json()["stop_reason"], "cancelled");
    }

    #[tokio::test]
    async fn finalize_turn_emits_only_result_when_no_block_was_open() {
        let (tx, mut rx) = mpsc::channel(4);
        let indexer = Arc::new(StdMutex::new(EventIndexer::default()));
        finalize_turn(
            &tx,
            &indexer,
            Some("s-1".into()),
            None,
            None,
            "end_turn",
            &json!({}),
        )
        .await;
        let event = rx.recv().await.unwrap().unwrap();
        assert!(event.is_result());
        assert!(rx.try_recv().is_err(), "no extra events expected");
    }

    fn make_lock() -> PromptTurnLock {
        Arc::new(AsyncMutex::new(()))
    }

    #[tokio::test]
    async fn drive_initial_prompt_serialises_concurrent_callers_through_the_lock() {
        // Two concurrent `drive_initial_prompt` calls (proxy for two
        // `stream_input` calls) must hit the wire in sequence: first call
        // sends, the second blocks on the lock until the first response
        // returns and its drain runs.
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let session_id = Arc::new(RwLock::new(Some("s-1".to_string())));
        let model = Arc::new(RwLock::new(None));
        let effort = Arc::new(RwLock::new(None));
        let indexer = Arc::new(StdMutex::new(EventIndexer::default()));
        let lock = make_lock();
        let cancel = PromptCancel::new();
        let hooks = Arc::new(NoUsageHooks);
        let (tx, mut rx) = mpsc::channel(16);

        let first = tokio::spawn({
            let client = client.clone();
            let session_id = Arc::clone(&session_id);
            let model = Arc::clone(&model);
            let effort = Arc::clone(&effort);
            let indexer = Arc::clone(&indexer);
            let lock = Arc::clone(&lock);
            let cancel = cancel.clone();
            let tx = tx.clone();
            let hooks = Arc::clone(&hooks);
            async move {
                drive_initial_prompt(
                    &client,
                    &session_id,
                    &model,
                    &effort,
                    json!("first"),
                    &tx,
                    &indexer,
                    None,
                    hooks.as_ref(),
                    &lock,
                    &cancel,
                )
                .await
            }
        });

        let first_req = read_one_request(&mut agent_stdin).await;
        assert_eq!(first_req["params"]["prompt"][0]["text"], "first");
        let first_id = first_req["id"].clone();

        // Second caller should block on the lock and not emit yet.
        let second = tokio::spawn({
            let client = client.clone();
            let session_id = Arc::clone(&session_id);
            let model = Arc::clone(&model);
            let effort = Arc::clone(&effort);
            let indexer = Arc::clone(&indexer);
            let lock = Arc::clone(&lock);
            let cancel = cancel.clone();
            let hooks = Arc::clone(&hooks);
            async move {
                drive_initial_prompt(
                    &client,
                    &session_id,
                    &model,
                    &effort,
                    json!("second"),
                    &tx,
                    &indexer,
                    None,
                    hooks.as_ref(),
                    &lock,
                    &cancel,
                )
                .await
            }
        });
        let mut peek = String::new();
        let blocked =
            tokio::time::timeout(Duration::from_millis(100), agent_stdin.read_line(&mut peek))
                .await;
        assert!(
            blocked.is_err(),
            "second caller must wait for the lock; saw: {peek}"
        );

        reply_with_stop(&mut agent_stdout, first_id, "end_turn").await;
        first.await.unwrap().unwrap();
        let first_evt = rx.recv().await.unwrap().unwrap();
        assert!(first_evt.is_result());

        let second_req = read_one_request(&mut agent_stdin).await;
        assert_eq!(second_req["params"]["prompt"][0]["text"], "second");
        let second_id = second_req["id"].clone();
        reply_with_stop(&mut agent_stdout, second_id, "end_turn").await;
        second.await.unwrap().unwrap();
    }
}
