//! Slash-command snapshot store + on-demand ACP refresh probe for
//! OpenCode.
//!
//! Two cooperating paths populate the per-cwd snapshot the synchronous
//! WS `commands.get` request reads back:
//!
//! 1. **Live ACP push** — every `opencode acp` session pushes its full
//!    catalog (built-ins + project-local) on creation and on every
//!    change as `session/update` notifications whose `sessionUpdate`
//!    is `available_commands_update`. `OpenCodeAcpAdapter::
//!    record_available_commands` mirrors each push into the snapshot.
//!
//! 2. **On-demand ephemeral probe** — when the FE opens the `/` menu,
//!    `OpenCodeAdapter::refresh_runtime_slash_commands` spawns a
//!    one-shot `opencode acp` subprocess, runs the
//!    `initialize` / `session/new` handshake, waits for the agent's
//!    first `available_commands_update`, snapshots, and shuts down.
//!    Multiple concurrent refreshes for the same cwd are coalesced
//!    via single-flight so rapid `/` toggles share one probe.
//!
//! The FE consumes both: it calls `commands.get` for an instant
//! cached read (with `refreshing: true`), and the WS bridge later
//! pushes a `commands.updated` envelope when the probe (or a live
//! session's ACP push) produces fresh data.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{broadcast, RwLock};

use super::acp::spawn_headless_acp;
use crate::domain::agents::acp::incoming::AcpNotification;
use crate::domain::agents::acp::runtime::events::parse_available_commands;
use crate::domain::agents::acp::{AcpClient, AcpEvent};
use crate::domain::agents::adapter::{RuntimeError, RuntimeSlashCommand};

/// Upper bound on the time we'll wait for opencode to spawn,
/// handshake, and push its first `available_commands_update`. Generous
/// because the first probe on a cold-cached binary is the slow case;
/// follow-up probes (single-flight + cached snapshot) won't pay this.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const PROBE_LOG_PREFIX: &str = "opencode ACP /command probe";

static SNAPSHOTS: OnceLock<RwLock<HashMap<String, Arc<Vec<RuntimeSlashCommand>>>>> =
    OnceLock::new();

fn snapshots() -> &'static RwLock<HashMap<String, Arc<Vec<RuntimeSlashCommand>>>> {
    SNAPSHOTS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Replace the snapshot for `cwd` with the latest ACP-advertised list.
///
/// Visibility scoped to the opencode module so the ACP runtime hook
/// (`opencode::acp::adapter::OpenCodeAcpAdapter::record_available_commands`)
/// can mirror updates while keeping the snapshot store as
/// implementation detail.
pub(in crate::domain::agents::opencode) async fn record_snapshot(
    cwd: &str,
    commands: Vec<RuntimeSlashCommand>,
) {
    snapshots()
        .write()
        .await
        .insert(cwd.to_string(), Arc::new(commands));
}

/// Read the latest snapshot for `cwd`. Returns an empty list when no
/// ACP session has yet pushed a catalog for this cwd in this process.
pub(in crate::domain::agents::opencode) async fn runtime_slash_commands(
    cwd: &str,
) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
    let snapshot = snapshots().read().await.get(cwd).cloned();
    Ok(snapshot.map(|arc| (*arc).clone()).unwrap_or_default())
}

#[cfg(test)]
pub(in crate::domain::agents::opencode) async fn reset_for_test() {
    snapshots().write().await.clear();
    if let Some(map) = INFLIGHT.get() {
        if let Ok(mut guard) = map.lock() {
            guard.clear();
        }
    }
}

// --- On-demand ACP refresh ------------------------------------------------

/// Stringified probe result. Broadcast channels require `Clone` and
/// `RuntimeError` isn't, so concurrent subscribers see the error text.
type ProbeResult = Result<Vec<RuntimeSlashCommand>, String>;

/// Per-cwd single-flight registry. While a probe is running for a cwd,
/// concurrent callers subscribe to the same broadcast instead of
/// spawning a second subprocess.
static INFLIGHT: OnceLock<StdMutex<HashMap<String, broadcast::Sender<ProbeResult>>>> =
    OnceLock::new();

fn inflight() -> &'static StdMutex<HashMap<String, broadcast::Sender<ProbeResult>>> {
    INFLIGHT.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// Force a fresh re-resolve of the slash-command catalog by spawning a
/// short-lived `opencode acp` subprocess, running the handshake, and
/// capturing the first `available_commands_update` push. Updates the
/// per-cwd snapshot on success.
///
/// Single-flighted per cwd: rapid `/` toggles from the FE share one
/// probe. Errors are logged + returned to the caller; the snapshot is
/// left unchanged so the FE keeps showing the last known catalog.
pub(in crate::domain::agents::opencode) async fn refresh_via_acp(
    cwd: &str,
) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
    if let Some(mut rx) = join_existing_probe(cwd) {
        return match rx.recv().await {
            Ok(result) => result.map_err(RuntimeError::new),
            Err(_) => Err(RuntimeError::new(format!(
                "{PROBE_LOG_PREFIX}: in-flight probe dropped before completing"
            ))),
        };
    }
    let (tx, _rx) = broadcast::channel(1);
    register_inflight(cwd, tx.clone());
    let outcome = run_probe(cwd).await;
    unregister_inflight(cwd);
    let broadcast_payload = outcome
        .as_ref()
        .map(|commands| commands.clone())
        .map_err(|error| error.to_string());
    let _ = tx.send(broadcast_payload);
    if let Ok(ref commands) = outcome {
        record_snapshot(cwd, commands.clone()).await;
    }
    outcome
}

fn join_existing_probe(cwd: &str) -> Option<broadcast::Receiver<ProbeResult>> {
    inflight().lock().ok()?.get(cwd).map(|tx| tx.subscribe())
}

fn register_inflight(cwd: &str, tx: broadcast::Sender<ProbeResult>) {
    if let Ok(mut guard) = inflight().lock() {
        guard.insert(cwd.to_string(), tx);
    }
}

fn unregister_inflight(cwd: &str) {
    if let Ok(mut guard) = inflight().lock() {
        guard.remove(cwd);
    }
}

async fn run_probe(cwd: &str) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
    tokio::time::timeout(PROBE_TIMEOUT, probe_inner(cwd))
        .await
        .map_err(|_| {
            RuntimeError::new(format!(
                "{PROBE_LOG_PREFIX}: timed out after {PROBE_TIMEOUT:?}"
            ))
        })?
}

/// Drive the actual probe: reserve a port, spawn `opencode acp`, do
/// the ACP handshake, then loop on the subscription until the agent
/// pushes `available_commands_update`. The client's `Drop` impl reaps
/// the subprocess.
async fn probe_inner(cwd: &str) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
    let (client, _) = spawn_headless_acp(std::ffi::OsStr::new(cwd))
        .await
        .map_err(|e| RuntimeError::new(format!("{PROBE_LOG_PREFIX}: spawn failed: {e}")))?;

    // Subscribe BEFORE the handshake so the broadcast doesn't lose the
    // first `available_commands_update` that arrives during/right after
    // `session/new`.
    let mut events = client.subscribe();
    handshake(&client, cwd).await?;
    let commands = wait_for_catalog(&mut events).await?;
    client.shutdown().await;
    Ok(commands)
}

async fn handshake(client: &AcpClient, cwd: &str) -> Result<(), RuntimeError> {
    let info = client.client_info().clone();
    client
        .request_with_timeout(
            "initialize",
            serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } },
                "clientInfo": { "name": info.name, "title": info.title, "version": info.version }
            }),
            HANDSHAKE_TIMEOUT,
        )
        .await
        .map_err(|e| RuntimeError::new(format!("{PROBE_LOG_PREFIX}: initialize failed: {e}")))?;
    let cwd_path = PathBuf::from(cwd);
    client
        .request_with_timeout(
            "session/new",
            serde_json::json!({
                "cwd": cwd_path.to_string_lossy(),
                "mcpServers": [],
            }),
            HANDSHAKE_TIMEOUT,
        )
        .await
        .map_err(|e| RuntimeError::new(format!("{PROBE_LOG_PREFIX}: session/new failed: {e}")))?;
    Ok(())
}

async fn wait_for_catalog(
    events: &mut broadcast::Receiver<AcpEvent>,
) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
    loop {
        match events.recv().await {
            Ok(AcpEvent::Notification(notification)) => {
                let AcpNotification::SessionUpdate { raw: params } = notification else {
                    continue;
                };
                let body = params.get("update").unwrap_or(&params);
                let kind = body.get("sessionUpdate").and_then(Value::as_str);
                if kind == Some("available_commands_update") {
                    return Ok(parse_available_commands(body));
                }
            }
            Ok(AcpEvent::ProcessExited { status, signal }) => {
                return Err(RuntimeError::new(format!(
                    "{PROBE_LOG_PREFIX}: subprocess exited before pushing catalog (status={status:?}, signal={signal:?})"
                )));
            }
            Ok(_) => continue,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                tracing::warn!(skipped, "ACP probe event channel lagged");
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => {
                return Err(RuntimeError::new(format!(
                    "{PROBE_LOG_PREFIX}: event channel closed before catalog arrived"
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::RuntimeSlashCommandKind;

    /// Tests share the process-global snapshot map; serialize them.
    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn cmd(name: &str) -> RuntimeSlashCommand {
        RuntimeSlashCommand {
            name: name.to_string(),
            description: Some(format!("desc for {name}")),
            kind: RuntimeSlashCommandKind::Command,
        }
    }

    #[tokio::test]
    async fn cold_lookup_returns_empty_list() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        let result = runtime_slash_commands("/cold").await.expect("ok");
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn record_then_lookup_returns_latest_snapshot() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        record_snapshot("/repo", vec![cmd("compact"), cmd("help")]).await;
        let result = runtime_slash_commands("/repo").await.expect("ok");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "compact");
        assert_eq!(result[1].name, "help");
        reset_for_test().await;
    }

    #[tokio::test]
    async fn second_record_replaces_prior_snapshot() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        record_snapshot("/repo", vec![cmd("first")]).await;
        record_snapshot("/repo", vec![cmd("second"), cmd("third")]).await;
        let result = runtime_slash_commands("/repo").await.expect("ok");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "second");
        reset_for_test().await;
    }

    #[tokio::test]
    async fn snapshots_are_per_cwd() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        record_snapshot("/a", vec![cmd("alpha")]).await;
        record_snapshot("/b", vec![cmd("bravo")]).await;
        let a = runtime_slash_commands("/a").await.expect("ok");
        let b = runtime_slash_commands("/b").await.expect("ok");
        assert_eq!(a[0].name, "alpha");
        assert_eq!(b[0].name, "bravo");
        reset_for_test().await;
    }

    /// Sanity-check the single-flight registry: while a probe is
    /// notionally in-flight (we register a sender by hand), a
    /// concurrent caller subscribes to the same broadcast and receives
    /// the eventual result without spawning a second subprocess.
    #[tokio::test]
    async fn concurrent_refreshes_coalesce_via_inflight_registry() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;

        let (tx, _initial_rx) = broadcast::channel::<ProbeResult>(1);
        register_inflight("/coalesce", tx.clone());

        let mut subscriber =
            join_existing_probe("/coalesce").expect("should join the in-flight probe");

        // Simulate the probe completing.
        let _ = tx.send(Ok(vec![cmd("from-probe")]));
        unregister_inflight("/coalesce");

        let received = subscriber.recv().await.expect("broadcast not closed");
        let commands = received.expect("probe ok");
        assert_eq!(commands[0].name, "from-probe");

        // After unregister, a fresh lookup must miss the in-flight
        // registry (would trigger a new probe in real flow).
        assert!(join_existing_probe("/coalesce").is_none());
        reset_for_test().await;
    }
}
