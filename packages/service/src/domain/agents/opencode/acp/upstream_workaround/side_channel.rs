//! Spawns the polling loop that supplements OpenCode's ACP wire:
//!
//! - Sub-agent listener (`subagent_listener::poll_once`) — discover
//!   `Task`/`Agent` child sessions, tail their messages, and surface
//!   their permission prompts.
//! - Root usage poller (`root_usage_listener::poll_once`) — context-token
//!   updates that ACP only emits at turn end.
//!
//! One loop drives both pollers so they share a backoff schedule and a
//! single sleep interval. Both push onto the same per-session runtime
//! channel.

use std::path::PathBuf;
use std::time::Duration;

use opencode_sdk_rs::OpenCodeClient;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::pending_subagents::PendingSubagentTasks;
use super::root_usage_listener::{self, RootUsageState};
use super::subagent_listener::{self, ListenerState, PermissionRegistry};
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent};

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const IDLE_INTERVAL: Duration = Duration::from_secs(2);
const ACTIVE_USAGE_POLLS: u8 = 4;
/// Initial children-snapshot retry budget — covers the few-ms window
/// between subprocess spawn and the embedded HTTP backend accepting
/// connections. Must complete before the agent fires its first Task
/// tool, so we keep total wait short.
const SNAPSHOT_MAX_ATTEMPTS: u8 = 10;
const SNAPSHOT_RETRY_DELAY: Duration = Duration::from_millis(100);

pub(in crate::domain::agents::opencode::acp) fn spawn_side_channel_listeners(
    client: OpenCodeClient,
    cwd: PathBuf,
    root_session_id: String,
    context_window: Option<u64>,
    pending_tasks: PendingSubagentTasks,
    permissions: PermissionRegistry,
    runtime_tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) -> JoinHandle<()> {
    tracing::info!(
        backend = %client.base_url(),
        cwd = %cwd.display(),
        root_session_id = %root_session_id,
        "OpenCode side channel: spawning HTTP polling task"
    );
    tokio::spawn(async move {
        let directory = cwd.to_string_lossy().to_string();
        let mut usage_state = RootUsageState::default();
        let mut subagent_state = ListenerState::new(root_session_id.clone());
        let mut active_usage_polls = ACTIVE_USAGE_POLLS;
        // Snapshot pre-existing children NOW — before the agent can fire
        // its first Task tool. Doing this lazily inside the poll loop
        // would race the agent and mis-classify the current turn's new
        // sub-agents as historical, leaving their messages and
        // permission prompts permanently silent.
        prime_subagent_snapshot(&client, &root_session_id, &directory, &mut subagent_state).await;
        loop {
            let poll_usage = active_usage_polls > 0;
            if poll_usage {
                match root_usage_listener::poll_once(
                    &client,
                    &directory,
                    &root_session_id,
                    context_window,
                    &mut usage_state,
                    &runtime_tx,
                )
                .await
                {
                    Ok(true) => active_usage_polls = ACTIVE_USAGE_POLLS,
                    Ok(false) => active_usage_polls = active_usage_polls.saturating_sub(1),
                    Err(()) => return,
                }
            }
            // Sub-agent state is "active" whenever a Task is pending OR a
            // child session is already known: pending → we're waiting for
            // its child to appear; known → we still need to tail its
            // messages and watch for new permission prompts.
            let subagent_active = pending_tasks
                .lock()
                .ok()
                .map(|pending| !pending.is_empty())
                .unwrap_or(false)
                || !subagent_state.is_empty();
            if subagent_active
                && subagent_listener::poll_once(
                    &client,
                    &directory,
                    &root_session_id,
                    &mut subagent_state,
                    &pending_tasks,
                    &permissions,
                    &runtime_tx,
                )
                .await
                .is_err()
            {
                return;
            }
            let interval = if poll_usage || subagent_active {
                POLL_INTERVAL
            } else {
                active_usage_polls = ACTIVE_USAGE_POLLS;
                IDLE_INTERVAL
            };
            tokio::time::sleep(interval).await;
        }
    })
}

/// Retry-loop wrapper around `list_children_in_directory` for the
/// startup snapshot. The embedded HTTP backend may not be accepting
/// connections in the first few ms after subprocess spawn; we keep
/// retrying briefly so the snapshot lands before the first Task tool.
async fn prime_subagent_snapshot(
    client: &OpenCodeClient,
    root_session_id: &str,
    directory: &str,
    state: &mut ListenerState,
) {
    for attempt in 1..=SNAPSHOT_MAX_ATTEMPTS {
        match client
            .list_children_in_directory(root_session_id, Some(directory))
            .await
        {
            Ok(children) => {
                state.prime_snapshot(&children);
                return;
            }
            Err(error) => {
                tracing::debug!(
                    %error, attempt,
                    "OpenCode side channel: initial children snapshot failed, retrying"
                );
                tokio::time::sleep(SNAPSHOT_RETRY_DELAY).await;
            }
        }
    }
    tracing::warn!(
        root = %root_session_id,
        "OpenCode side channel: initial children snapshot never succeeded; \
         proceeding with empty baseline (pre-existing sub-agents on a \
         resumed session may be mispaired with this turn's Task queue)"
    );
    state.prime_snapshot(&[]);
}
