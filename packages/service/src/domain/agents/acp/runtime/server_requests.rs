//! Event-loop and server-request dispatch for the ACP runtime.
//!
//! Consumes the `AcpClient` reliable (ordered, lossless) event queue,
//! dispatches `session/update` notifications through the events.rs mapper,
//! routes server-initiated requests through the appropriate handler module
//! (permissions / fs / terminal), and turns `ProcessExited` or a queue
//! overflow into a visible `RuntimeError` on the runtime channel.
//!
//! Requests that can block indefinitely (`terminal/wait_for_exit`) are
//! answered from tasks owned by the loop so later notifications and requests
//! (including `terminal/kill`) keep flowing.
//!
//! Notifications and server-requests arrive as typed envelopes
//! (`AcpNotification` / `AcpServerRequest`) that retain raw JSON. Handlers
//! prefer the typed payload when present and fall back to raw access for
//! OpenCode-style provider extensions.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::{mpsc, RwLock};
use tokio::task::{JoinHandle, JoinSet};

use crate::domain::agents::acp::event_hub::AcpReliableEventReceiver;
use crate::domain::agents::acp::incoming::{AcpNotification, AcpServerRequest};
use crate::domain::agents::acp::{AcpClient, AcpEvent};
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent, RuntimeStreamStatus};
use crate::domain::mcp::trusted::CadencrBrowserTrust;

use super::event_loop_state::{latched_turn_model, sync_session_state_from_update};
use super::events::session_update_to_events;
use super::events_stream_blocks::EventIndexer;
use super::events_tool_call_metadata::is_empty_value;
use super::fs::{handle_read_text_file, handle_write_text_file};
use super::permissions::{
    has_pending_permission_for_tool_call, refreshed_permission_event_for_tool_input,
    PendingPermissions,
};
use super::prompt_receipts::PendingPromptReceipts;
use super::provider_hooks::AcpProviderHooks;
use super::server_request_permission::handle_permission_request;
use super::server_request_response::{
    describe_exit, fs_outcome_from, respond_or_reject, terminal_id_param,
};
use super::session_config::AcpSessionConfigState;
use super::session_permissions::SessionPermissions;
use super::terminal_enrich::enrich_session_update;
use super::terminal_registry::TerminalRegistry;

#[derive(Clone)]
pub struct EventLoopConfig {
    pub session_id: Arc<RwLock<Option<String>>>,
    pub current_model: Arc<RwLock<Option<String>>>,
    pub current_effort: Arc<RwLock<Option<String>>>,
    pub current_mode: Arc<RwLock<String>>,
    pub session_config: AcpSessionConfigState,
    pub cwd: PathBuf,
    pub closing: Arc<AtomicBool>,
    pub pending_permissions: PendingPermissions,
    pub session_permissions: SessionPermissions,
    pub terminals: Arc<TerminalRegistry>,
    pub hooks: Arc<dyn AcpProviderHooks>,
    /// Shared streaming-block indexer. Owned jointly by the event loop (which
    /// mutates it on every `session/update`) and the prompt-turn path (which
    /// drains open blocks at `stop_reason` time — see W4).
    pub indexer: Arc<Mutex<EventIndexer>>,
    /// Suppresses durable transcript replay from `session/load` until the
    /// first new prompt is dispatched.
    pub replay_suppression: Arc<AtomicBool>,
    /// Prompt client ids waiting for provider-side receipt confirmation.
    pub pending_prompt_receipts: Arc<PendingPromptReceipts>,
    /// Whether Cadencr's browser tools skip the permission prompt.
    pub browser_trust: CadencrBrowserTrust,
}

/// Spawn the loop. Returns a handle the session can `abort()` on close;
/// aborting it also aborts the deferred request tasks it owns.
pub fn spawn_event_loop(
    client: AcpClient,
    mut source_rx: AcpReliableEventReceiver,
    tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    config: EventLoopConfig,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut deferred = JoinSet::new();
        loop {
            let event = tokio::select! {
                event = source_rx.recv() => event,
                Some(joined) = deferred.join_next(), if !deferred.is_empty() => {
                    report_deferred_request_join(joined);
                    continue;
                }
            };
            let Some(event) = event else { break };
            match event {
                AcpEvent::Notification(notification) => {
                    handle_notification(&notification, &tx, &config).await;
                }
                AcpEvent::ServerRequest(request) => {
                    handle_server_request(&client, request, &tx, &config, &mut deferred).await;
                }
                AcpEvent::EventBarrier(barrier) => barrier.release(),
                AcpEvent::ProcessExited { status, signal } => {
                    if !config.closing.load(Ordering::SeqCst) {
                        let message =
                            format!("ACP process exited: {}", describe_exit(status, signal));
                        emit_terminal_error(&tx, message).await;
                    }
                    break;
                }
                AcpEvent::TransportError { message } => {
                    // Events past the limit were not delivered, possibly
                    // including server requests the agent now waits on.
                    // End the session visibly rather than leave it wedged.
                    tracing::error!(%message, "ACP runtime event queue overflowed");
                    if !config.closing.load(Ordering::SeqCst) {
                        emit_terminal_error(&tx, message).await;
                    }
                    client.shutdown().await;
                    break;
                }
            }
        }
    })
}

async fn emit_terminal_error(
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    message: String,
) {
    let degraded = RuntimeEvent::stream_status_event(RuntimeStreamStatus::Degraded {
        reason: message.clone(),
    });
    if tx.send(Ok(degraded)).await.is_err() {
        return;
    }
    let _ = tx.send(Err(RuntimeError::new(message))).await;
}

fn report_deferred_request_join(joined: Result<(), tokio::task::JoinError>) {
    if let Err(error) = joined {
        if error.is_panic() {
            tracing::error!(%error, "ACP deferred server request panicked");
        }
    }
}

async fn handle_notification(
    notification: &AcpNotification,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    config: &EventLoopConfig,
) {
    match notification {
        AcpNotification::SessionUpdate { .. } => {
            let params = notification.params();
            let synced = sync_session_state_from_update(params, config).await;
            if let Some(event) = synced.mode_changed {
                let _ = tx.send(Ok(event)).await;
            }
            let agent_moved_model = synced.agent_moved_model;
            if config.replay_suppression.load(Ordering::SeqCst)
                && is_transcript_session_update(params)
            {
                tracing::debug!("suppressing ACP resume replay transcript update");
                return;
            }
            if let Some(event) = config
                .pending_prompt_receipts
                .acknowledge_from_session_update(params)
            {
                if tx.send(Ok(event)).await.is_err() {
                    return;
                }
            }
            let session_id = config.session_id.read().await.clone();
            let model = config.current_model.read().await.clone();
            // Resolve any `terminalId` references so Bash tool blocks reach
            // the FE with both `toolInput.command` and an inline text result.
            let enriched = enrich_session_update(params, &config.terminals).await;
            let payload = enriched.as_ref().unwrap_or(params);
            let mapped = {
                // Hold the mutex only across the (synchronous) mapping call;
                // never across `await`. The prompt-turn path competes for
                // this lock at turn end (see drain_open_blocks).
                let mut indexer = config.indexer.lock().expect("EventIndexer poisoned");
                let turn_model = latched_turn_model(&mut indexer, agent_moved_model, model);
                session_update_to_events(
                    payload,
                    &mut indexer,
                    turn_model.as_deref(),
                    session_id.as_deref(),
                    config.hooks.as_ref(),
                )
            };
            for event in mapped.events {
                if tx.send(Ok(event)).await.is_err() {
                    return;
                }
            }
            if let Some(event) = refreshed_pending_permission_event(payload, config).await {
                let _ = tx.send(Ok(event)).await;
            }
        }
        AcpNotification::Extension { method, .. } => {
            // Provider extensions are the connector's business: an installed
            // provider translates them into standard ACP before they get here.
            tracing::debug!(method, "ignoring ACP extension notification");
        }
    }
}

fn is_transcript_session_update(params: &Value) -> bool {
    let body = params.get("update").unwrap_or(params);
    matches!(
        body.get("sessionUpdate").and_then(Value::as_str),
        Some(
            "agent_message_chunk"
                | "agent_thought_chunk"
                | "tool_call"
                | "tool_call_update"
                | "plan"
                | "user_message_chunk"
        )
    )
}

async fn refreshed_pending_permission_event(
    session_update_params: &Value,
    config: &EventLoopConfig,
) -> Option<RuntimeEvent> {
    let update = session_update_params.get("update")?;
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("tool_call_update") {
        return None;
    }
    let tool_call_id = update
        .get("toolCallId")
        .or_else(|| update.get("toolUseId"))
        .and_then(Value::as_str)?;
    if !has_pending_permission_for_tool_call(&config.pending_permissions, tool_call_id).await {
        return None;
    }
    let tool_input = {
        config
            .indexer
            .lock()
            .expect("EventIndexer poisoned")
            .tool_input_for(tool_call_id)
            .cloned()
    }?;
    if is_empty_value(&tool_input) {
        return None;
    }
    refreshed_permission_event_for_tool_input(
        &config.pending_permissions,
        config.session_id.read().await.clone(),
        tool_call_id,
        tool_input,
    )
    .await
}

async fn handle_server_request(
    client: &AcpClient,
    request: AcpServerRequest,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    config: &EventLoopConfig,
    deferred: &mut JoinSet<()>,
) {
    let id = request.id().clone();
    match request.method() {
        "session/request_permission" => {
            handle_permission_request(client, id, &request, tx, config).await;
        }
        "fs/read_text_file" => {
            let outcome = handle_read_text_file(&request, &config.cwd).await;
            respond_or_reject(client, id, outcome).await;
        }
        "fs/write_text_file" => {
            let outcome = handle_write_text_file(&request, &config.cwd).await;
            respond_or_reject(client, id, outcome).await;
        }
        "terminal/create" => {
            let result = config.terminals.create(request.params(), &config.cwd).await;
            respond_or_reject(client, id, fs_outcome_from(result)).await;
        }
        "terminal/output" => {
            let result = config
                .terminals
                .output(terminal_id_param(request.params()))
                .await;
            respond_or_reject(client, id, fs_outcome_from(result)).await;
        }
        "terminal/wait_for_exit" => {
            match config
                .terminals
                .exit_waiter(terminal_id_param(request.params()))
                .await
            {
                Ok(waiter) => {
                    let client = client.clone();
                    deferred.spawn(async move {
                        let result = waiter.wait().await;
                        respond_or_reject(&client, id, fs_outcome_from(result)).await;
                    });
                }
                Err(error) => respond_or_reject(client, id, fs_outcome_from(Err(error))).await,
            }
        }
        "terminal/kill" => {
            let result = config
                .terminals
                .kill(terminal_id_param(request.params()))
                .await;
            respond_or_reject(client, id, fs_outcome_from(result)).await;
        }
        "terminal/release" => {
            let result = config
                .terminals
                .release(terminal_id_param(request.params()))
                .await;
            respond_or_reject(client, id, fs_outcome_from(result)).await;
        }
        other => {
            tracing::warn!(method = other, "unhandled ACP server request");
            if let Err(error) = client
                .reject_server_request(id, -32601, "method not found")
                .await
            {
                tracing::error!(%error, method = other, "failed to reject unknown ACP request");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::server_request_event_loop_tests::{
        client_with_agent_io, event_loop_config, read_agent_response, write_agent_request,
    };
    use super::spawn_event_loop;
    use serde_json::{json, Value};
    use tokio::io::{BufReader, DuplexStream};
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn event_loop_round_trips_file_writes_reads_and_sandbox_errors() {
        let directory = tempfile::tempdir().unwrap();
        let (client, mut stdout, mut stdin) = client_with_agent_io().await;
        let (tx, _rx) = mpsc::channel(8);
        let task = spawn_event_loop(
            client.clone(),
            client.subscribe_reliable(),
            tx,
            event_loop_config(directory.path().to_path_buf()),
        );
        let response = exchange_request(
            &mut stdout,
            &mut stdin,
            json!(41),
            "fs/write_text_file",
            json!({"sessionId": "s-1", "path": directory.path().join("nested/roundtrip.txt"), "content": "first\nsecond\n"}),
        )
        .await;
        assert!(response.get("result").is_some(), "{response}");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("nested/roundtrip.txt")).unwrap(),
            "first\nsecond\n"
        );
        let response = exchange_request(
            &mut stdout,
            &mut stdin,
            json!("41"),
            "fs/read_text_file",
            json!({"sessionId": "s-1", "path": directory.path().join("nested/roundtrip.txt"), "line": 2, "limit": 1}),
        )
        .await;
        assert_eq!(response["result"]["content"], "second");
        let response = exchange_request(
            &mut stdout,
            &mut stdin,
            json!(42),
            "fs/write_text_file",
            json!({"sessionId": "s-1", "path": directory.path().join("../escape-acp.txt"), "content": "must be rejected"}),
        )
        .await;
        assert_eq!(response["error"]["code"], -32602);
        client.shutdown().await;
        task.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn event_loop_round_trips_terminal_lifecycle_over_acp() {
        let directory = tempfile::tempdir().unwrap();
        let (client, mut stdout, mut stdin) = client_with_agent_io().await;
        let (tx, _rx) = mpsc::channel(8);
        let task = spawn_event_loop(
            client.clone(),
            client.subscribe_reliable(),
            tx,
            event_loop_config(directory.path().to_path_buf()),
        );
        let created = exchange_request(&mut stdout, &mut stdin, json!(51), "terminal/create",
            json!({"sessionId": "s-1", "command": "/bin/sh", "args": ["-c", "printf ACP-transport-ok"], "outputByteLimit": 128})).await;
        let terminal_id = created["result"]["terminalId"]
            .as_str()
            .expect("created terminal");
        let params = json!({"sessionId": "s-1", "terminalId": terminal_id});
        let exited = exchange_request(
            &mut stdout,
            &mut stdin,
            json!("51"),
            "terminal/wait_for_exit",
            params.clone(),
        )
        .await;
        assert_eq!(exited["result"]["exitCode"], 0);
        let output = exchange_request(
            &mut stdout,
            &mut stdin,
            json!(52),
            "terminal/output",
            params.clone(),
        )
        .await;
        assert_eq!(output["result"]["output"], "ACP-transport-ok");
        assert_eq!(output["result"]["truncated"], false);
        let released = exchange_request(
            &mut stdout,
            &mut stdin,
            json!(53),
            "terminal/release",
            params.clone(),
        )
        .await;
        assert!(released.get("result").is_some(), "{released}");
        let gone = exchange_request(
            &mut stdout,
            &mut stdin,
            json!(54),
            "terminal/output",
            params,
        )
        .await;
        assert_eq!(gone["error"]["code"], -32602);
        client.shutdown().await;
        task.abort();
    }

    async fn exchange_request(
        stdout: &mut DuplexStream,
        stdin: &mut BufReader<DuplexStream>,
        id: Value,
        method: &str,
        params: Value,
    ) -> Value {
        write_agent_request(
            stdout,
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
        )
        .await;
        let response = read_agent_response(stdin).await;
        assert_eq!(
            response["id"], id,
            "response must preserve the request ID type"
        );
        response
    }
}
