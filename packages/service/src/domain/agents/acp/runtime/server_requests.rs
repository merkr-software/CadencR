//! Event-loop and server-request dispatch for the ACP runtime.
//!
//! Subscribes to the `AcpClient` broadcast channel, dispatches `session/update`
//! notifications through the events.rs mapper, routes server-initiated requests
//! through the appropriate handler module (permissions / fs / terminal), and
//! turns `ProcessExited` into a visible `RuntimeError` on the runtime channel.
//!
//! Notifications and server-requests arrive as typed envelopes
//! (`AcpNotification` / `AcpServerRequest`) that retain raw JSON. Handlers
//! prefer the typed payload when present and fall back to raw access for
//! OpenCode-style provider extensions.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio::task::JoinHandle;

use crate::domain::agents::acp::incoming::{AcpNotification, AcpServerRequest};
use crate::domain::agents::acp::{AcpClient, AcpEvent};
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent, RuntimeStreamStatus};

use super::event_loop_state::{latched_turn_model, sync_session_state_from_update};
use super::events::session_update_to_events;
use super::events_stream_blocks::EventIndexer;
use super::events_tool_call_metadata::is_empty_value;
use super::fs::{handle_read_text_file, handle_write_text_file};
use super::permission_tool_updates::emit_permission_tool_update;
use super::permissions::{
    derive_preview, dispatch_permission_request_with_cache, has_pending_permission_for_tool_call,
    permission_request_from_server_request, refreshed_permission_event_for_tool_input,
    PendingPermissions,
};
use super::prompt_receipts::PendingPromptReceipts;
use super::provider_hooks::AcpProviderHooks;
use super::server_request_response::{
    describe_exit, emit_recovered, fs_outcome_from, respond_or_reject, terminal_id_param,
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
}

/// Spawn the loop. Returns a handle the session can `abort()` on close.
pub fn spawn_event_loop(
    client: AcpClient,
    mut source_rx: broadcast::Receiver<AcpEvent>,
    tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    config: EventLoopConfig,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // Tracks whether we've previously emitted a `Degraded` banner so we
        // can pair it with a `Recovered` banner once the next regular event
        // arrives. Without this the FE sees a stuck Degraded indicator
        // after a transient lag spike.
        let mut degraded = false;
        loop {
            match source_rx.recv().await {
                Ok(AcpEvent::Notification(notification)) => {
                    if degraded {
                        emit_recovered(&tx).await;
                        degraded = false;
                    }
                    handle_notification(&notification, &tx, &config).await;
                }
                Ok(AcpEvent::ServerRequest(request)) => {
                    if degraded {
                        emit_recovered(&tx).await;
                        degraded = false;
                    }
                    handle_server_request(&client, request, &tx, &config).await;
                }
                Ok(AcpEvent::EventBarrier(barrier)) => {
                    barrier.notify_one();
                }
                Ok(AcpEvent::ProcessExited { status, signal }) => {
                    if !config.closing.load(Ordering::SeqCst) {
                        let message = describe_exit(status, signal);
                        let _ = tx
                            .send(Ok(RuntimeEvent::stream_status_event(
                                RuntimeStreamStatus::Degraded {
                                    reason: format!("ACP process exited: {message}"),
                                },
                            )))
                            .await;
                        let _ = tx
                            .send(Err(RuntimeError::new(format!(
                                "ACP process exited: {message}"
                            ))))
                            .await;
                    }
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "ACP event broadcast lagged");
                    let _ = tx
                        .send(Ok(RuntimeEvent::stream_status_event(
                            RuntimeStreamStatus::Degraded {
                                reason: format!("event backlog: {skipped} skipped"),
                            },
                        )))
                        .await;
                    degraded = true;
                }
            }
        }
    })
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
            let result = config
                .terminals
                .wait_for_exit(terminal_id_param(request.params()))
                .await;
            respond_or_reject(client, id, fs_outcome_from(result)).await;
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

async fn handle_permission_request(
    client: &AcpClient,
    id: Value,
    request: &AcpServerRequest,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    config: &EventLoopConfig,
) {
    let request_id = id
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| id.to_string());
    let parsed = permission_request_from_server_request(&request_id, request);
    let Some(mut permission) = parsed else {
        if let Err(error) = client
            .reject_server_request(id, -32602, "missing toolCall")
            .await
        {
            tracing::error!(%error, "failed to reject malformed ACP permission request");
        }
        return;
    };
    enrich_permission_from_recorded_tool_input(&mut permission, config);
    let normalized_name = config.hooks.normalize_tool_name(&permission.tool_name);
    permission.tool_name = normalized_name;
    permission.tool_input = config.hooks.normalize_tool_input(
        &permission.tool_name,
        std::mem::take(&mut permission.tool_input),
    );
    permission.preview = derive_preview(&permission.tool_input);
    let session_id = config.session_id.read().await.clone();
    if permission.tool_name.starts_with("mcp__") {
        emit_permission_tool_update(&permission, session_id.as_deref(), &config.indexer, tx).await;
    }
    if let Err(error) = dispatch_permission_request_with_cache(
        client,
        &config.pending_permissions,
        &config.session_permissions,
        session_id,
        &request_id,
        id.clone(),
        permission,
        request.params(),
        tx,
    )
    .await
    {
        tracing::error!(%error, "failed to surface ACP permission request");
        if let Err(reject_error) = client
            .reject_server_request(id, -32800, "permission request could not be surfaced")
            .await
        {
            tracing::error!(%reject_error, "failed to reject unsurfaced ACP permission request");
        }
    }
}

fn enrich_permission_from_recorded_tool_input(
    permission: &mut crate::domain::agents::adapter::RuntimePermissionRequest,
    config: &EventLoopConfig,
) {
    if !is_empty_value(&permission.tool_input) && permission.preview.is_some() {
        return;
    }
    let Some(tool_use_id) = permission.tool_use_id.as_deref() else {
        return;
    };
    let Some(recorded) = config
        .indexer
        .lock()
        .expect("EventIndexer poisoned")
        .tool_input_for(tool_use_id)
        .cloned()
    else {
        return;
    };
    if is_empty_value(&permission.tool_input) {
        permission.tool_input = recorded;
    }
    if permission.preview.is_none() {
        permission.preview = derive_preview(&permission.tool_input);
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
            client.subscribe(),
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
            client.subscribe(),
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
