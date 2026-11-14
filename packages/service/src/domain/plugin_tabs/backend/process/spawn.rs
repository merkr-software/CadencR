//! Spawning and wiring one native run. Supervision stays in the parent module.
use super::{supervise, Prepared, Process, Running};
use crate::domain::agents::acp::process_tree::ProcessTreeControl;
use crate::domain::agents::providers::installed::managed::process_policy::{
    long_lived_managed_command, managed_process_tree_policy,
};
use crate::domain::plugin_tabs::backend::launch::unavailable;
use crate::domain::plugin_tabs::backend::protocol::{
    read_stderr, read_stdout, write_stdin, Pending, Stdout,
};
use crate::domain::plugin_tabs::backend::{
    events::Events, handshake, history::History, BackendLaunch,
};
use crate::domain::plugin_tabs::grants::{GrantRequest, GrantStore, Lifetime};
use crate::error::AppError;
use cadencr_tab_backend::protocol::MAX_IN_FLIGHT;
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, OnceLock};
use tokio::process::Child;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Start `launch`'s `prepared` backend; its tasks report into `history`.
#[bon::builder]
pub(in crate::domain::plugin_tabs::backend) fn spawn(
    launch: &BackendLaunch,
    prepared: Prepared,
    grants: &GrantStore,
    history: Arc<History>,
    events: Events,
) -> Result<Arc<Running>, AppError> {
    let (mut child, tree) = spawn_child(launch, &prepared)?;
    let (Some(pid), Some(stdin), Some(stdout), Some(stderr)) = (
        child.id(),
        child.stdin.take(),
        child.stdout.take(),
        child.stderr.take(),
    ) else {
        let _ = child.start_kill();
        return Err(unavailable("the backend's stdio was unavailable".into()));
    };
    let minted = grants.mint(
        GrantRequest::builder()
            .plugin_id(launch.plugin_id.clone())
            .project_id(launch.project_id)
            .feature_id(launch.feature_id)
            .scopes(launch.scopes.clone())
            .permissions_hash(launch.permissions_hash.clone())
            .lifetime(Lifetime::UntilRevoked)
            .build(),
    );
    let run = history.record_start();
    let (stdin_tx, stdin_rx) = mpsc::channel(MAX_IN_FLIGHT);
    let running = Arc::new(Running {
        run_id: uuid::Uuid::new_v4().to_string(),
        events,
        pid,
        run,
        grant_key: minted.grant.key.clone(),
        permissions_hash: launch.permissions_hash.clone(),
        plugin_dir: launch.plugin_dir.clone(),
        plugin_version: launch.plugin_version.clone(),
        managed: launch.managed.clone(),
        stop: CancellationToken::new(),
        stop_reason: OnceLock::new(),
        exited: CancellationToken::new(),
        stdin: stdin_tx,
        pending: Pending::default(),
        next_id: AtomicU64::new(1),
        handshake: handshake::new_state(),
        ready_budget: prepared.ready_budget,
    });
    let hello = match launch.hello(&minted.token) {
        Ok(hello) => hello,
        Err(error) => {
            let _ = child.start_kill();
            grants.revoke_key(&minted.grant.key);
            return Err(error);
        }
    };
    running.events.start(&running.run_id);
    tokio::spawn(write_stdin(stdin, hello, stdin_rx, running.stop.clone()));
    tokio::spawn(read_stdout(Stdout {
        stop: running.stop.clone(),
        stdout,
        pending: running.pending.clone(),
        history: history.clone(),
        handshake: running.handshake.clone(),
        protocol: launch.backend.protocol,
        events: running.events.clone(),
        run_id: running.run_id.clone(),
    }));
    tokio::spawn(read_stderr(stderr, history.clone()));
    tokio::spawn(supervise(
        Process {
            child,
            tree,
            lease: launch.lease.clone(),
        },
        running.clone(),
        minted.grant.revoked.clone(),
        grants.clone(),
        history,
    ));
    Ok(running)
}

fn spawn_child(
    launch: &BackendLaunch,
    prepared: &Prepared,
) -> Result<(Child, ProcessTreeControl), AppError> {
    let mut command = long_lived_managed_command(&prepared.executable, &launch.plugin_dir)
        .map_err(|error| unavailable(format!("the backend cannot start: {error}")))?;
    command.stdin(Stdio::piped());
    let tree = ProcessTreeControl::prepare(&mut command, managed_process_tree_policy())
        .map_err(|error| unavailable(format!("the backend cannot be contained: {error}")))?;
    let mut child = command
        .spawn()
        .map_err(|error| unavailable(format!("the backend failed to start: {error}")))?;
    if let Err(error) = tree.attach(&child) {
        let _ = child.start_kill();
        return Err(unavailable(format!(
            "the backend cannot be contained: {error}"
        )));
    }
    Ok((child, tree))
}
