//! Prompt-turn lifecycle helpers.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex as AsyncMutex, Notify, RwLock};

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent, RuntimeUsage};

use super::events_stream_blocks::{message_start_for, EventIndexer};
use super::prompt_turn::{acp_prompt_blocks_from_content, build_prompt_params};
use super::provider_hooks::AcpProviderHooks;
use super::turn_result::emit_turn_result;

pub type PromptTurnLock = Arc<AsyncMutex<()>>;

/// How long a cancelled `session/prompt` may take to settle (ACP: the agent
/// answers with stop reason `cancelled`) before the process is terminated.
/// Generous on purpose: agents unwind tool calls, MCP requests and
/// subprocesses first, and killing the process loses all of that state.
pub const DEFAULT_CANCEL_GRACE: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct PromptCancel {
    epoch: Arc<AtomicU64>,
    notify: Arc<Notify>,
    /// Set by a cancel, cleared when the next prompt is dispatched: tool calls
    /// the agent fails in between were interrupted, not broken.
    interrupted: Arc<AtomicBool>,
    grace: Duration,
}

impl Default for PromptCancel {
    fn default() -> Self {
        Self {
            epoch: Arc::default(),
            notify: Arc::default(),
            interrupted: Arc::default(),
            grace: DEFAULT_CANCEL_GRACE,
        }
    }
}

impl PromptCancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Override the cancel grace (see [`DEFAULT_CANCEL_GRACE`]).
    pub fn with_cancel_grace(mut self, grace: Duration) -> Self {
        self.grace = grace;
        self
    }

    pub fn cancel_current_turn(&self) {
        self.interrupted.store(true, Ordering::Relaxed);
        self.epoch.fetch_add(1, Ordering::Relaxed);
        self.notify.notify_waiters();
    }

    pub fn turn_interrupted(&self) -> bool {
        self.interrupted.load(Ordering::Relaxed)
    }

    fn current_epoch(&self) -> u64 {
        self.epoch.load(Ordering::Relaxed)
    }

    /// The cancel count now, to tell later whether a cancel came since.
    pub fn cancels(&self) -> u64 {
        self.current_epoch()
    }

    /// Whether a turn was cancelled since `cancels` was read.
    pub fn cancelled_since(&self, cancels: u64) -> bool {
        self.current_epoch() > cancels
    }

    async fn wait_for_cancel_after(&self, epoch: u64) {
        loop {
            // Register before re-checking the epoch: `notify_waiters` only
            // wakes registered waiters, so a cancel landing between the check
            // and the await would otherwise be missed.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.current_epoch() > epoch {
                return;
            }
            notified.await;
        }
    }
}

/// Wait until the event loop has handled every event received before the
/// prompt response. No deadline: the barrier is never skipped (lossless
/// queue), and a loop that stops drops it, which fails this wait.
pub async fn await_event_loop_barrier(client: &AcpClient) -> Result<(), RuntimeError> {
    let released = client
        .enqueue_event_barrier()
        .map_err(|error| RuntimeError::new(format!("could not fence ACP events: {error}")))?;
    released
        .await
        .map_err(|_| RuntimeError::new("ACP event loop stopped before turn completion"))
}

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
    hooks.validate_prompt_blocks(&prompt)?;
    let model = current_model_lock.read().await.clone();
    let effort = current_effort_lock.read().await.clone();
    start_turn_on_model(tx, indexer, &session_id, model.clone()).await;
    let params = build_prompt_params(
        &session_id,
        prompt,
        model.as_deref(),
        effort.as_deref(),
        false,
    );
    let response = request_prompt_with_cancel(client, params, prompt_cancel, tx).await?;
    if agent_was_terminated(&response) {
        return Ok(());
    }
    await_event_loop_barrier(client).await?;
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

/// Latch the model a prompt is sent on and announce it at once: ACP only
/// synthesises a `message_start` before the agent's first text, so a turn
/// opening with tool calls would otherwise run unnamed on the "Working" line.
pub async fn start_turn_on_model(
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    indexer: &StdMutex<EventIndexer>,
    session_id: &str,
    model: Option<String>,
) {
    indexer
        .lock()
        .expect("EventIndexer poisoned")
        .latch_turn_model(model.clone());
    if model.is_some() {
        let _ = tx
            .send(Ok(message_start_for(Some(session_id), model.as_deref())))
            .await;
    }
}

/// Send `session/prompt` and wait for its response without a wall-clock cap:
/// it settles when the agent answers or the transport closes. A cancel is a
/// protocol state — the caller already sent `session/cancel`, and the agent
/// should answer with stop reason `cancelled`. Only when it does not settle
/// within the cancel grace is the process terminated, visibly.
pub async fn request_prompt_with_cancel(
    client: &AcpClient,
    params: Value,
    prompt_cancel: &PromptCancel,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) -> Result<Value, RuntimeError> {
    let start_epoch = prompt_cancel.current_epoch();
    prompt_cancel.interrupted.store(false, Ordering::Relaxed);
    let prompt = client.request_until_closed("session/prompt", params);
    tokio::pin!(prompt);

    tokio::select! {
        result = &mut prompt => prompt_result(result),
        _ = prompt_cancel.wait_for_cancel_after(start_epoch) => {
            match tokio::time::timeout(prompt_cancel.grace, &mut prompt).await {
                Ok(result) => prompt_result_after_cancel(result),
                Err(_) => {
                    escalate_unresponsive_cancel(client, prompt_cancel.grace, tx).await;
                    Ok(terminated_prompt_response())
                }
            }
        }
    }
}

async fn escalate_unresponsive_cancel(
    client: &AcpClient,
    grace: Duration,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) {
    let message = unresponsive_cancel_message(grace);
    tracing::warn!(grace_ms = grace.as_millis() as u64, "{message}");
    // The kill must never wait on the runtime channel. Queue the reason
    // without blocking so it normally precedes the generic "process exited"
    // error that follows the kill; a full channel gets it after the kill.
    match tx.try_send(Err(RuntimeError::stop_escalated(message))) {
        Ok(()) => client.shutdown().await,
        Err(mpsc::error::TrySendError::Full(escalation)) => {
            client.shutdown().await;
            if tx.send(escalation).await.is_err() {
                tracing::debug!("ACP runtime channel closed before cancel escalation");
            }
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            tracing::debug!("ACP runtime channel closed before cancel escalation");
            client.shutdown().await;
        }
    }
}

fn unresponsive_cancel_message(grace: Duration) -> String {
    format!(
        "The agent did not stop within {}s after Stop; its ACP process was terminated.",
        grace.as_secs_f32()
    )
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

fn terminated_prompt_response() -> Value {
    json!({ "stopReason": "cancelled", "cadencrSynthetic": true, "cadencrTerminated": true })
}

/// Whether the prompt ended by killing the agent after an ignored Stop. Its
/// event loop is gone and the reader already got the escalation error, so the
/// caller neither fences events nor finalizes the turn: either would only add
/// a second, misleading error.
pub fn agent_was_terminated(response: &Value) -> bool {
    response.get("cadencrTerminated") == Some(&Value::Bool(true))
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
    use super::{
        await_event_loop_barrier, drive_initial_prompt, finalize_turn, request_prompt_with_cancel,
        start_turn_on_model, EventIndexer, PromptCancel, PromptTurnLock, DEFAULT_CANCEL_GRACE,
    };
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::test_support::spawn_event_barrier_acker;
    use crate::domain::agents::acp::{AcpClient, AcpClientInfo};
    use crate::domain::agents::adapter::{RuntimePermissionMode, RuntimeStreamEvent};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::sync::{mpsc, Mutex as AsyncMutex, RwLock};

    struct NoUsageHooks;

    #[test]
    fn a_cancel_after_reading_the_count_is_seen() {
        let cancel = PromptCancel::new();
        let cancels = cancel.cancels();
        assert!(!cancel.cancelled_since(cancels));
        cancel.cancel_current_turn();
        assert!(cancel.cancelled_since(cancels));
        assert!(!cancel.cancelled_since(cancel.cancels()));
    }

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
    async fn a_prompt_names_its_model_before_the_agent_writes_anything() {
        let (tx, mut rx) = mpsc::channel(4);
        let indexer = StdMutex::new(EventIndexer::default());
        start_turn_on_model(&tx, &indexer, "s1", Some("openai/gpt-6.1-terra".into())).await;
        assert_eq!(
            indexer.lock().unwrap().turn_model(),
            Some("openai/gpt-6.1-terra")
        );
        let event = rx.try_recv().unwrap().unwrap();
        assert!(matches!(
            event.stream_event(),
            Some(RuntimeStreamEvent::MessageStart { model: Some(model), .. })
                if model == "openai/gpt-6.1-terra"
        ));

        start_turn_on_model(&tx, &indexer, "s1", None).await;
        assert_eq!(indexer.lock().unwrap().turn_model(), None);
        assert!(rx.try_recv().is_err(), "no model, nothing to announce");
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
        spawn_event_barrier_acker(&client);
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

    async fn spawn_prompt(
        client: &AcpClient,
        cancel: &PromptCancel,
        tx: &mpsc::Sender<
            Result<
                crate::domain::agents::adapter::RuntimeEvent,
                crate::domain::agents::adapter::RuntimeError,
            >,
        >,
    ) -> tokio::task::JoinHandle<Result<Value, crate::domain::agents::adapter::RuntimeError>> {
        let (client, cancel, tx) = (client.clone(), cancel.clone(), tx.clone());
        tokio::spawn(async move {
            request_prompt_with_cancel(&client, json!({"sessionId": "s-1"}), &cancel, &tx).await
        })
    }

    #[tokio::test]
    async fn stop_waits_for_the_agents_cancelled_response_instead_of_killing() {
        // Regression: the process used to be shut down 150 ms after Stop.
        assert!(DEFAULT_CANCEL_GRACE >= Duration::from_secs(10));
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let cancel = PromptCancel::new();
        let (tx, mut rx) = mpsc::channel(4);
        let prompt = spawn_prompt(&client, &cancel, &tx).await;
        let request = read_one_request(&mut agent_stdin).await;
        cancel.cancel_current_turn();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            !prompt.is_finished(),
            "Stop must wait for the agent to unwind"
        );
        reply_with_stop(&mut agent_stdout, request["id"].clone(), "cancelled").await;
        let response = prompt.await.unwrap().expect("cancelled turn settles");
        assert_eq!(response["stopReason"], "cancelled");
        assert!(response.get("cadencrSynthetic").is_none());
        assert!(rx.try_recv().is_err(), "no escalation error");
        // The process (here: the transport) survived the Stop.
        let follow_up = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .request_with_timeout("ping", json!({}), Duration::from_secs(2))
                    .await
            }
        });
        let ping = read_one_request(&mut agent_stdin).await;
        reply_with_stop(&mut agent_stdout, ping["id"].clone(), "end_turn").await;
        assert!(follow_up.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn unresponsive_stop_escalates_visibly_after_the_grace() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let cancel = PromptCancel::new().with_cancel_grace(Duration::from_millis(100));
        let (tx, mut rx) = mpsc::channel(4);
        let prompt = spawn_prompt(&client, &cancel, &tx).await;
        read_one_request(&mut agent_stdin).await;
        cancel.cancel_current_turn();
        let response = tokio::time::timeout(Duration::from_secs(5), prompt)
            .await
            .expect("escalation settles the turn")
            .unwrap()
            .unwrap();
        assert_eq!(response["stopReason"], "cancelled");
        assert!(
            super::agent_was_terminated(&response),
            "callers must not fence or finalize a killed agent"
        );
        let error = rx.recv().await.unwrap().expect_err("visible escalation");
        assert!(error.is_stop_escalation(), "{error:?}");
        assert!(error.to_string().contains("did not stop"), "{error}");
        let mut eof = String::new();
        let read = tokio::time::timeout(Duration::from_secs(2), agent_stdin.read_line(&mut eof))
            .await
            .expect("transport must be shut down")
            .unwrap();
        assert_eq!(read, 0);
    }

    #[tokio::test]
    async fn escalation_kills_before_waiting_on_a_full_runtime_channel() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let cancel = PromptCancel::new().with_cancel_grace(Duration::from_millis(100));
        let (tx, mut rx) = mpsc::channel(1);
        tx.send(Ok(super::message_start_for(Some("s-1"), None)))
            .await
            .unwrap();
        let prompt = spawn_prompt(&client, &cancel, &tx).await;
        read_one_request(&mut agent_stdin).await;
        cancel.cancel_current_turn();
        // Nobody drains the channel yet: the kill must not wait for it.
        let mut eof = String::new();
        let read = tokio::time::timeout(Duration::from_secs(2), agent_stdin.read_line(&mut eof))
            .await
            .expect("a full channel must not delay the kill")
            .unwrap();
        assert_eq!(read, 0);
        assert!(rx.recv().await.unwrap().is_ok(), "earlier event first");
        let error = rx.recv().await.unwrap().expect_err("visible escalation");
        assert!(error.is_stop_escalation(), "{error:?}");
        let response = tokio::time::timeout(Duration::from_secs(5), prompt)
            .await
            .expect("escalation settles the turn")
            .unwrap()
            .unwrap();
        assert_eq!(response["stopReason"], "cancelled");
    }

    #[tokio::test]
    async fn barrier_fails_fast_without_an_event_loop() {
        // Previously this waited 2 s and then failed the turn.
        let (client, _agent_stdout, _agent_stdin) = build_in_memory_client().await;
        let error = tokio::time::timeout(
            Duration::from_millis(200),
            await_event_loop_barrier(&client),
        )
        .await
        .expect("no hidden deadline")
        .expect_err("no loop to drain events");
        assert!(error.to_string().contains("could not fence"), "{error}");
        let receiver = client.subscribe_reliable();
        let released = client.enqueue_event_barrier().expect("queued");
        drop(receiver);
        tokio::time::timeout(Duration::from_secs(1), released)
            .await
            .expect("a dropped loop releases the waiter")
            .expect_err("barrier was never reached");
    }
}
