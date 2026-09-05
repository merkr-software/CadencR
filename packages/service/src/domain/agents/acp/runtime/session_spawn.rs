//! Spawn-time wiring for [`AcpRuntimeSession`]. Lifted out of `session.rs`
//! so the session module stays under the 400-line ceiling. Owns the
//! end-to-end spawn flow: subprocess + handshake + struct assembly + event
//! loop + initial-prompt detach.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::sync::{broadcast, mpsc, Mutex as AsyncMutex, RwLock};

use crate::domain::agents::acp::{
    AcpClient, AcpClientInfo, AcpEvent, AcpProcessTreePolicy, AcpSpawnOptions, AcpStderrPolicy,
};
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
    RuntimeInitEvent, RuntimeSpawnConfig,
};

use super::events_stream_blocks::EventIndexer;
use super::lifecycle::{negotiate_session, NegotiatedSession};
use super::permissions::PendingPermissions;
use super::prompt_receipts::PendingPromptReceipts;
use super::provider_hooks::AcpProviderHooks;
use super::server_requests::{spawn_event_loop, EventLoopConfig};
use super::session::{AcpRuntimeSession, MESSAGE_CHANNEL_CAPACITY};
use super::session_config::AcpSessionConfigState;
use super::session_permissions::SessionPermissions;
use super::spawn_initial_config::{apply_initial_model, apply_initial_thinking_effort};
use super::spawn_initial_mode::apply_initial_permission_mode;
use super::terminal_registry::TerminalRegistry;
use super::turn_lifecycle::{drive_initial_prompt, PromptCancel};

/// Options for [`spawn_acp_runtime_session`].
pub struct AcpRuntimeSpawnArgs {
    pub command: tokio::process::Command,
    pub spawn_guard: Option<Box<dyn Send + 'static>>,
    pub client_info: AcpClientInfo,
    pub stderr_policy: AcpStderrPolicy,
    pub process_tree_policy: AcpProcessTreePolicy,
    pub config: RuntimeSpawnConfig,
    pub initial_content: Value,
    /// Provider-resolved context window for the negotiated model.
    pub context_window: Option<u64>,
    pub hooks: Arc<dyn AcpProviderHooks>,
}

/// End-to-end spawn for a generic ACP subprocess: client + handshake +
/// session + event loop, then drive the initial prompt off-thread so the
/// spawn doesn't wedge on a blocking tool call.
pub async fn spawn_acp_runtime_session(
    args: AcpRuntimeSpawnArgs,
) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
    let AcpRuntimeSpawnArgs {
        command,
        spawn_guard,
        client_info,
        stderr_policy,
        process_tree_policy,
        config,
        initial_content,
        context_window,
        hooks,
    } = args;
    // `session/new` carries the workspace root, and every ACP path also sets it
    // as the child's working directory. An empty one would reach the agent as a
    // relative cwd and fail deep inside the handshake, so refuse it here where
    // all four ACP providers get the same stable error.
    if config.cwd.as_os_str().is_empty() {
        return Err(RuntimeError::new(
            "an ACP session needs a workspace directory",
        ));
    }
    let client = AcpClient::spawn(
        AcpSpawnOptions::builder()
            .command(command)
            .client_info(client_info)
            .stderr_policy(stderr_policy)
            .process_tree_policy(process_tree_policy)
            .maybe_spawn_guard(spawn_guard)
            .build(),
    )
    .await
    .map_err(|e| RuntimeError::new(format!("failed to spawn ACP subprocess: {e}")))?;
    let pid = client.pid();
    let mut event_rx = client.subscribe();
    let negotiated = negotiate_session(&client, &config, context_window, hooks.as_ref()).await?;

    let (tx, rx) = mpsc::channel(MESSAGE_CHANNEL_CAPACITY);
    let indexer = Arc::new(StdMutex::new(EventIndexer::default()));
    let mut session = AcpRuntimeSession::assemble(
        &client,
        &negotiated,
        config.cwd.clone(),
        pid,
        rx,
        tx.clone(),
        hooks.clone(),
        Arc::clone(&indexer),
    );
    if negotiated.may_replay_history {
        session
            .replay_suppression
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    apply_initial_permission_mode(&session, &negotiated, &config).await?;
    // Push the user-selected model and thinking effort to the agent before
    // the first `session/prompt`, otherwise the agent runs at its own
    // default. Model goes first because its authoritative response may replace
    // the effort choices that the second update must validate and select.
    apply_initial_model(&session, &negotiated, &config).await?;
    apply_initial_thinking_effort(&session, &negotiated, &config).await?;

    emit_init_event(&tx, &negotiated).await;
    if negotiated.may_replay_history {
        let drained = drain_resume_backlog(&mut event_rx);
        if drained > 0 {
            tracing::debug!(drained, "drained ACP resume replay backlog");
        }
    }
    let loop_task = spawn_event_loop(
        client.clone(),
        event_rx,
        tx.clone(),
        EventLoopConfig {
            session_id: Arc::clone(&session.session_id),
            current_model: Arc::clone(&session.current_model),
            current_effort: Arc::clone(&session.current_effort),
            current_mode: Arc::clone(&session.current_mode),
            session_config: session.session_config.clone(),
            cwd: config.cwd.clone(),
            closing: Arc::clone(&session.closing),
            pending_permissions: Arc::clone(&session.pending_permissions),
            session_permissions: session.session_permissions.clone(),
            terminals: Arc::new(TerminalRegistry::default()),
            hooks: hooks.clone(),
            indexer: Arc::clone(&session.indexer),
            replay_suppression: Arc::clone(&session.replay_suppression),
            pending_prompt_receipts: Arc::clone(&session.pending_prompt_receipts),
        },
    );
    session.loop_task = Some(loop_task);

    // Provider-spawned side channel (e.g. OpenCode's HTTP polling listener for
    // sub-agent child-session events). Started after the event loop so the
    // listener's emitted events queue behind any spawn-time init events the
    // FE expects to see first.
    session.side_channel_task = hooks.start_side_channel(
        &negotiated.session_id,
        config.cwd.as_path(),
        session.context_window,
        tx.clone(),
    );

    if !initial_content.is_null() {
        spawn_initial_prompt(&session, &tx, initial_content);
    }

    tracing::info!(transport = "acp", pid = ?pid, "ACP runtime session spawned");
    Ok(Box::new(session))
}

fn drain_resume_backlog(event_rx: &mut broadcast::Receiver<AcpEvent>) -> usize {
    let mut drained = 0usize;
    loop {
        match event_rx.try_recv() {
            Ok(_) => drained += 1,
            Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                drained = drained.saturating_add(usize::try_from(skipped).unwrap_or(usize::MAX));
            }
            Err(broadcast::error::TryRecvError::Empty | broadcast::error::TryRecvError::Closed) => {
                break;
            }
        }
    }
    drained
}

/// Detach: awaiting `session/prompt` here would deadlock the spawn when the
/// agent's first tool blocks on user input. The initial prompt routes
/// through the full-turn prompt path; follow-up FE prompts can steer through
/// `AcpRuntimeSession::stream_input` while this initial turn is still active.
fn spawn_initial_prompt(
    session: &AcpRuntimeSession,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    initial_content: Value,
) {
    let session_for_prompt = session.client.clone();
    let session_id_arc = Arc::clone(&session.session_id);
    let current_model_arc = Arc::clone(&session.current_model);
    let current_effort_arc = Arc::clone(&session.current_effort);
    let local_tx = tx.clone();
    let indexer_arc = Arc::clone(&session.indexer);
    let context_window = session.context_window;
    let hooks = Arc::clone(&session.hooks);
    let prompt_turn_lock = Arc::clone(&session.prompt_turn_lock);
    let prompt_cancel = session.prompt_cancel.clone();
    let replay_suppression = Arc::clone(&session.replay_suppression);
    tokio::spawn(async move {
        replay_suppression.store(false, std::sync::atomic::Ordering::SeqCst);
        if let Err(error) = drive_initial_prompt(
            &session_for_prompt,
            &session_id_arc,
            &current_model_arc,
            &current_effort_arc,
            initial_content,
            &local_tx,
            &indexer_arc,
            context_window,
            hooks.as_ref(),
            &prompt_turn_lock,
            &prompt_cancel,
        )
        .await
        {
            let _ = local_tx.send(Err(error)).await;
        }
    });
}

impl AcpRuntimeSession {
    /// Assemble a session struct from negotiated handshake state.
    /// Pulled out of [`spawn_acp_runtime_session`] for readability.
    pub(super) fn assemble(
        client: &AcpClient,
        negotiated: &NegotiatedSession,
        cwd: std::path::PathBuf,
        pid: Option<u32>,
        rx: mpsc::Receiver<Result<RuntimeEvent, RuntimeError>>,
        local_tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
        hooks: Arc<dyn AcpProviderHooks>,
        indexer: Arc<StdMutex<EventIndexer>>,
    ) -> AcpRuntimeSession {
        AcpRuntimeSession {
            client: client.clone(),
            session_id: Arc::new(RwLock::new(Some(negotiated.session_id.clone()))),
            // Start as `None` so the first `set_config_option` call doesn't
            // short-circuit on `current == intent` and skip telling the
            // agent. See `spawn_initial_config::apply_initial_model`.
            current_model: Arc::new(RwLock::new(None)),
            current_effort: Arc::new(RwLock::new(None)),
            current_mode: Arc::new(RwLock::new(
                // Fall back to "build" only if the agent omitted
                // `currentModeId` in `session/new`. Every ACP provider we
                // ship today reports a mode, so this is just a safety net.
                negotiated
                    .current_mode
                    .clone()
                    .or_else(|| hooks.default_mode_id().map(ToOwned::to_owned))
                    .unwrap_or_default(),
            )),
            session_config: AcpSessionConfigState::new(
                negotiated.session_config.clone(),
                hooks.clone(),
            ),
            supports_session_close: negotiated.supports_session_close,
            supports_set_config_option: Arc::new(AtomicBool::new(true)),
            supports_set_mode: Arc::new(AtomicBool::new(true)),
            pending_permissions: PendingPermissions::default(),
            session_permissions: SessionPermissions::new(),
            closing: Arc::new(AtomicBool::new(false)),
            manual_compact_running: Arc::new(AtomicBool::new(false)),
            pid,
            cwd,
            context_window: negotiated.context_window,
            configured_mcp_servers: negotiated.mcp_servers.clone(),
            mcp_servers: Arc::new(RwLock::new(negotiated.mcp_servers.clone())),
            message_rx: Some(rx),
            loop_task: None,
            side_channel_task: None,
            local_tx,
            hooks,
            indexer,
            replay_suppression: Arc::new(AtomicBool::new(false)),
            pending_prompt_receipts: Arc::new(PendingPromptReceipts::default()),
            pending_followups: Arc::new(RwLock::new(std::collections::VecDeque::new())),
            prompt_turn_lock: Arc::new(AsyncMutex::new(())),
            prompt_cancel: PromptCancel::new(),
        }
    }
}

async fn emit_init_event(
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    negotiated: &NegotiatedSession,
) {
    let raw = serde_json::json!({
        "type": "session.init",
        "transport": "acp",
        "model": negotiated.model,
        "mcp_servers": negotiated.mcp_servers.iter().map(|s| serde_json::json!({
            "name": s.name,
            "status": s.status,
        })).collect::<Vec<_>>(),
    });
    let init_event = RuntimeEvent::new(
        RuntimeEventMetadata {
            session_id: Some(negotiated.session_id.clone()),
            usage: None,
            context_window: negotiated.context_window,
            raw,
        },
        RuntimeEventKind::Init(RuntimeInitEvent {
            model: negotiated.model.clone(),
            mcp_servers: negotiated.mcp_servers.clone(),
            context_window: negotiated.context_window,
        }),
    );
    if let Err(error) = tx.send(Ok(init_event)).await {
        tracing::warn!(%error, "failed to send ACP init event");
    }
}
