//! Manual ACP compaction support.
//!
//! Runs OpenCode ACP `/compact` in the background so Stop can still interrupt
//! the in-flight `session/prompt` turn.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::sync::{mpsc, RwLock};

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeCompactMetadata, RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
};

use super::super::events_stream_blocks::EventIndexer;
use super::super::prompt_turn::{acp_prompt_blocks_from_content, build_prompt_params};
use super::super::provider_hooks::AcpProviderHooks;
use super::super::turn_lifecycle::{
    finalize_turn, request_prompt_with_cancel, PromptCancel, PromptTurnLock,
};
use super::implementation::AcpRuntimeSession;

pub(super) async fn spawn_compact_turn(session: &AcpRuntimeSession) -> Result<(), RuntimeError> {
    if session.closing.load(Ordering::SeqCst) {
        return Err(RuntimeError::new("ACP session is closing"));
    }
    let session_id = session.require_session_id().await?;
    session
        .manual_compact_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| RuntimeError::new("manual compaction is already running"))?;

    let local_tx = session.local_tx.clone();
    let turn = CompactTurn {
        client: session.client.clone(),
        session_id_lock: Arc::clone(&session.session_id),
        current_model: Arc::clone(&session.current_model),
        current_effort: Arc::clone(&session.current_effort),
        supports_set_config_option: Arc::clone(&session.supports_set_config_option),
        local_tx: local_tx.clone(),
        indexer: Arc::clone(&session.indexer),
        context_window: session.context_window,
        prompt_turn_lock: Arc::clone(&session.prompt_turn_lock),
        prompt_cancel: session.prompt_cancel.clone(),
        closing: Arc::clone(&session.closing),
        running: Arc::clone(&session.manual_compact_running),
        initial_session_id: session_id,
        compact_prompt: session.hooks.compact_prompt(),
        hooks: Arc::clone(&session.hooks),
    };

    tokio::spawn(async move {
        let result = turn.run().await;
        if let Err(error) = result {
            let _ = local_tx.send(Err(error)).await;
        }
    });
    Ok(())
}

struct CompactTurn {
    client: AcpClient,
    session_id_lock: Arc<RwLock<Option<String>>>,
    current_model: Arc<RwLock<Option<String>>>,
    current_effort: Arc<RwLock<Option<String>>>,
    supports_set_config_option: Arc<AtomicBool>,
    local_tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    indexer: Arc<StdMutex<EventIndexer>>,
    context_window: Option<u64>,
    prompt_turn_lock: PromptTurnLock,
    prompt_cancel: PromptCancel,
    closing: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    initial_session_id: String,
    compact_prompt: Option<&'static str>,
    hooks: Arc<dyn AcpProviderHooks>,
}

impl CompactTurn {
    async fn run(self) -> Result<(), RuntimeError> {
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    use async_trait::async_trait;
    use serde_json::{json, Value};
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

    use super::*;
    use crate::domain::agents::acp::runtime::lifecycle::NegotiatedSession;
    use crate::domain::agents::acp::runtime::prompt_receipts::PendingPromptReceipts;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::server_requests::{spawn_event_loop, EventLoopConfig};
    use crate::domain::agents::acp::runtime::terminal_registry::TerminalRegistry;
    use crate::domain::agents::acp::AcpClientInfo;
    use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimePermissionMode};

    struct PlainHooks;

    #[async_trait]
    impl AcpProviderHooks for PlainHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }

        fn normalize_tool_input(&self, _tool_name: &str, input: Value) -> Value {
            input
        }

        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            None
        }

        fn compact_prompt(&self) -> Option<&'static str> {
            Some("/compact")
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

    async fn write_frame(stdout: &mut DuplexStream, value: Value) {
        let mut frame = serde_json::to_vec(&value).unwrap();
        frame.push(b'\n');
        stdout.write_all(&frame).await.unwrap();
    }

    async fn read_one_request(reader: &mut BufReader<DuplexStream>) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    fn negotiated(session_id: &str) -> NegotiatedSession {
        NegotiatedSession {
            session_id: session_id.to_string(),
            model: None,
            mcp_servers: Vec::new(),
            context_window: None,
            current_mode: None,
        }
    }

    #[tokio::test]
    async fn compact_returns_before_prompt_response() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let (tx, rx) = mpsc::channel(8);
        let session = AcpRuntimeSession::assemble(
            &client,
            &negotiated("s-compact-fast"),
            None,
            rx,
            tx,
            Arc::new(PlainHooks),
            Arc::new(StdMutex::new(EventIndexer::default())),
        );

        tokio::time::timeout(std::time::Duration::from_millis(100), session.compact())
            .await
            .expect("compact should only enqueue the compact turn")
            .unwrap();
        let request = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            read_one_request(&mut agent_stdin),
        )
        .await
        .expect("compact should still send session/prompt");
        assert_eq!(request["method"], "session/prompt");
        assert_eq!(request["params"]["prompt"][0]["text"], "/compact");
    }

    #[tokio::test]
    async fn compact_rejects_duplicate_manual_turn_while_running() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let (tx, rx) = mpsc::channel(8);
        let session = AcpRuntimeSession::assemble(
            &client,
            &negotiated("s-compact-single"),
            None,
            rx,
            tx,
            Arc::new(PlainHooks),
            Arc::new(StdMutex::new(EventIndexer::default())),
        );

        session.compact().await.unwrap();
        let error = session.compact().await.unwrap_err();
        assert!(error
            .to_string()
            .contains("manual compaction is already running"));

        let request = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            read_one_request(&mut agent_stdin),
        )
        .await
        .expect("first compact should still send one prompt");
        assert_eq!(request["method"], "session/prompt");
        assert_eq!(request["params"]["prompt"][0]["text"], "/compact");
    }

    #[tokio::test]
    async fn compact_does_not_emit_duplicate_boundary_when_agent_reports_one() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let session_id = Arc::new(RwLock::new(Some("s-compact-dedupe".to_string())));
        let model = Arc::new(RwLock::new(None));
        let effort = Arc::new(RwLock::new(None));
        let mode = Arc::new(RwLock::new("build".to_string()));
        let indexer = Arc::new(StdMutex::new(EventIndexer::default()));
        let (tx, rx) = mpsc::channel(16);
        let event_rx = client.subscribe();
        let cfg = EventLoopConfig {
            session_id,
            current_model: model,
            current_effort: effort,
            current_mode: mode,
            cwd: PathBuf::from("/tmp"),
            closing: Arc::new(AtomicBool::new(false)),
            pending_permissions: Default::default(),
            session_permissions: Default::default(),
            terminals: Arc::new(TerminalRegistry::default()),
            hooks: Arc::new(PlainHooks),
            replay_suppression: Arc::new(AtomicBool::new(false)),
            pending_prompt_receipts: Arc::new(PendingPromptReceipts::default()),
            indexer: Arc::clone(&indexer),
        };
        let _loop_task = spawn_event_loop(client.clone(), event_rx, tx.clone(), cfg);
        let mut session = AcpRuntimeSession::assemble(
            &client,
            &negotiated("s-compact-dedupe"),
            None,
            rx,
            tx,
            Arc::new(PlainHooks),
            indexer,
        );
        let mut runtime_rx = session.take_message_rx();

        session.compact().await.unwrap();
        let request = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            read_one_request(&mut agent_stdin),
        )
        .await
        .expect("compact should send session/prompt");
        write_frame(
            &mut agent_stdout,
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s-compact-dedupe",
                    "update": {
                        "sessionUpdate": "user_message_chunk",
                        "content": { "type": "compaction", "auto": false, "overflow": false }
                    }
                }
            }),
        )
        .await;
        write_frame(
            &mut agent_stdout,
            json!({ "id": request["id"].clone(), "result": { "stopReason": "end_turn" } }),
        )
        .await;

        let mut compact_boundaries = 0;
        for _ in 0..4 {
            let event =
                tokio::time::timeout(std::time::Duration::from_millis(500), runtime_rx.recv())
                    .await
                    .expect("timed out waiting for compact events")
                    .expect("runtime channel closed")
                    .expect("runtime error");
            if event.is_compact_boundary() {
                compact_boundaries += 1;
            }
            if event.is_result() {
                break;
            }
        }
        assert_eq!(compact_boundaries, 1);
    }
}
