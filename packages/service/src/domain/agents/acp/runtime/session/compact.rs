//! Manual ACP compaction support.
//!
//! Runs OpenCode ACP `/compact` in the background so Stop can still interrupt
//! the in-flight `session/prompt` turn.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::domain::agents::adapter::RuntimeError;

use super::compact_turn::CompactTurn;
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
        replay_suppression: Arc::clone(&session.replay_suppression),
        initial_session_id: session_id,
        compact_prompt: session.hooks.compact_prompt(),
        hooks: Arc::clone(&session.hooks),
    };

    tokio::spawn(async move {
        let result = turn.run().await;
        if let Err(error) = result {
            let _ = local_tx
                .send(Err(RuntimeError::compact_failed(error.to_string())))
                .await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};

    use async_trait::async_trait;
    use serde_json::{json, Value};
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::sync::{mpsc, RwLock};

    use super::*;
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::lifecycle::NegotiatedSession;
    use crate::domain::agents::acp::runtime::prompt_receipts::PendingPromptReceipts;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::server_requests::{spawn_event_loop, EventLoopConfig};
    use crate::domain::agents::acp::runtime::terminal_registry::TerminalRegistry;
    use crate::domain::agents::acp::{AcpClient, AcpClientInfo};
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
            std::env::temp_dir(),
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
    async fn compact_clears_resume_replay_suppression_and_emits_turn_started() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let (tx, rx) = mpsc::channel(8);
        let mut session = AcpRuntimeSession::assemble(
            &client,
            &negotiated("s-compact-resume"),
            std::env::temp_dir(),
            None,
            rx,
            tx,
            Arc::new(PlainHooks),
            Arc::new(StdMutex::new(EventIndexer::default())),
        );
        session.replay_suppression.store(true, Ordering::SeqCst);
        let mut runtime_rx = session.take_message_rx();

        session.compact().await.unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_millis(250), runtime_rx.recv())
            .await
            .expect("compact should emit a turn-start signal")
            .expect("runtime channel closed")
            .expect("runtime error");
        let request = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            read_one_request(&mut agent_stdin),
        )
        .await
        .expect("compact should still send session/prompt");

        assert_eq!(request["method"], "session/prompt");
        assert!(!session.replay_suppression.load(Ordering::SeqCst));
        assert_eq!(
            crate::domain::session_status::provider_signal_for_event(&event),
            Some(crate::domain::session_status::ProviderSignal::TurnStarted)
        );
        assert!(event.stream_event().is_none());
    }

    #[tokio::test]
    async fn compact_rejects_duplicate_manual_turn_while_running() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let (tx, rx) = mpsc::channel(8);
        let session = AcpRuntimeSession::assemble(
            &client,
            &negotiated("s-compact-single"),
            std::env::temp_dir(),
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
            std::env::temp_dir(),
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
            json!({
                "jsonrpc": "2.0",
                "id": request["id"].clone(),
                "result": { "stopReason": "end_turn" }
            }),
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
