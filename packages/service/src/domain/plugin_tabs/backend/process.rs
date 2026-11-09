//! One run of a tab's backend process: spawn, supervise, shutdown. The stdio
//! protocol itself is in [`super::protocol`], its `ready` handshake in
//! [`super::handshake`]. A stopped backend gets its stdin closed; after a
//! grace period the whole process tree is terminated.

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::http::StatusCode;
use cadencr_tab_backend::protocol::{HostMessage, Request, RequestId, EXIT_GRACE, MAX_IN_FLIGHT};
use serde_json::Value;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::ending;
use super::handshake::{self, FailureKind, Handshake, HandshakeFailure, HandshakeState};
use super::history::{ExitRecord, History};
use super::launch::unavailable;
use super::models::PluginBackendResponse;
use super::protocol::{lock, read_stderr, read_stdout, write_stdin, Pending, Reply, Stdout};
use super::request::Budget;
use super::{BackendLaunch, StopReason};
use crate::domain::agents::acp::process_tree::ProcessTreeControl;
use crate::domain::agents::providers::installed::managed::process_policy::{
    long_lived_managed_command, managed_process_tree_policy,
};
use crate::domain::plugin_tabs::grants::{GrantRequest, GrantStore, Lifetime};
use crate::domain::plugin_tabs::managed::storage::{ManagedFacts, RevisionLease};
use crate::error::AppError;

const TERMINATE_GRACE: Duration = Duration::from_secs(3);
/// Upper bound on one stop: both graces, plus the tree cleanup.
pub const STOP_DEADLINE: Duration = Duration::from_secs(8);

/// A start that passed every check ([`super::BackendLaunch::prepare`]):
/// what to run and its `ready` budget ([`super::first_start`]).
pub(super) struct Prepared {
    pub executable: std::path::PathBuf,
    pub ready_budget: Duration,
}

/// A live backend process.
pub(super) struct Running {
    pub pid: u32,
    /// Which start of this backend it is (see [`History::record_start`]).
    run: u32,
    pub grant_key: String,
    pub permissions_hash: String,
    /// The tab folder it runs in: a new revision means a new process.
    pub plugin_dir: std::path::PathBuf,
    /// The version and signed facts of the marketplace revision it runs
    /// (`None` for a local tab), for the revocation policy's verdict.
    pub plugin_version: String,
    pub managed: Option<ManagedFacts>,
    /// Cancelled to stop the process; [`Running::request_stop`] also says why.
    pub stop: CancellationToken,
    stop_reason: OnceLock<StopReason>,
    /// Cancelled once the process has exited and been cleaned up.
    pub exited: CancellationToken,
    stdin: mpsc::Sender<String>,
    pending: Pending,
    next_id: AtomicU64,
    /// Requests wait for it to be ready; none is written before.
    pub(super) handshake: HandshakeState,
    ready_budget: Duration,
}

impl Running {
    /// The process has not exited yet (it may be stopping).
    pub fn is_live(&self) -> bool {
        !self.exited.is_cancelled()
    }

    /// Ask the process to stop. `reason` ends up in its Activity ("why it
    /// last stopped"); the first reason given wins.
    pub fn request_stop(&self, reason: StopReason) {
        let _ = self.stop_reason.set(reason);
        self.stop.cancel();
    }

    /// Why it was asked to stop, else `otherwise`.
    fn stop_reason(&self, otherwise: StopReason) -> StopReason {
        self.stop_reason.get().copied().unwrap_or(otherwise)
    }

    /// Live, not asked to stop, and not failed its handshake: new requests
    /// may use it. A run that missed its `ready` deadline is being stopped;
    /// the next request starts a fresh one rather than inherit its failure.
    pub fn is_usable(&self) -> bool {
        self.is_live()
            && !self.stop.is_cancelled()
            && !matches!(*self.handshake.borrow(), Handshake::Failed(_))
    }

    /// Started, but has not written its `ready` line yet.
    pub fn is_starting(&self) -> bool {
        *self.handshake.borrow() == Handshake::Waiting
    }

    /// Send one request and wait for its response.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        budget: Budget,
    ) -> Result<PluginBackendResponse, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = lock(&self.pending);
            if pending.len() >= MAX_IN_FLIGHT {
                return Err(AppError::coded(
                    StatusCode::TOO_MANY_REQUESTS,
                    "PLUGIN_BACKEND_BUSY",
                    format!("at most {MAX_IN_FLIGHT} backend requests at a time"),
                ));
            }
            pending.insert(id.clone(), tx);
        }
        // However this call ends — answered, timed out, or dropped because
        // the tab went away — its slot is freed.
        let _waiting = Waiting {
            pending: &self.pending,
            id: &id,
        };
        let line = serde_json::to_string(&HostMessage::Request(Request {
            id: RequestId::String(id.clone()),
            method: method.to_owned(),
            params,
        }))
        .map_err(|error| AppError::internal(format!("backend request encoding failed: {error}")))?;
        // One deadline for all three: the handshake of a backend just
        // started, and a backend that stops reading stdin fills the queue, so
        // `send` would otherwise wait on it forever.
        let exchange = async {
            handshake::wait_ready(&self.handshake).await?;
            if self.stdin.send(line).await.is_err() {
                return Err(exited_error("the backend is not running"));
            }
            match rx.await {
                Ok(Reply::Response(response)) => Ok(response),
                Ok(Reply::Exited(reason)) => Err(exited_error(&reason)),
                Err(_) => Err(exited_error("the backend stopped")),
            }
        };
        tokio::time::timeout_at(budget.deadline, exchange)
            .await
            .unwrap_or_else(|_| Err(budget.exceeded(method)))
    }
}

/// One request's entry in [`Pending`], removed when the call ends.
struct Waiting<'a> {
    pending: &'a Pending,
    id: &'a str,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        lock(self.pending).remove(self.id);
    }
}

pub(super) fn exited_error(reason: &str) -> AppError {
    AppError::coded(
        StatusCode::BAD_GATEWAY,
        "PLUGIN_BACKEND_EXITED",
        format!("the tab's backend exited before answering: {reason}"),
    )
}

/// Start `launch`'s `prepared` backend; its tasks report into `history`.
pub(super) fn spawn(
    launch: &BackendLaunch,
    prepared: Prepared,
    grants: &GrantStore,
    history: Arc<History>,
) -> Result<Arc<Running>, AppError> {
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
    tokio::spawn(write_stdin(stdin, hello, stdin_rx, running.stop.clone()));
    tokio::spawn(read_stdout(Stdout {
        stdout,
        pending: running.pending.clone(),
        history: history.clone(),
        handshake: running.handshake.clone(),
        protocol: launch.backend.protocol,
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

/// What [`supervise`] owns of one run.
struct Process {
    child: Child,
    tree: ProcessTreeControl,
    /// Keeps a marketplace revision on disk while the process runs; released
    /// once it exited (the slot keeps the record of the last run).
    lease: Option<RevisionLease>,
}

enum Ending {
    Exited(std::io::Result<std::process::ExitStatus>),
    Stopped(StopReason),
    /// It never became ready: stopped, and recorded as a failure.
    Refused(HandshakeFailure),
}

/// Wait for the process to exit or be stopped, then clean up: terminate the
/// tree, fail pending requests, revoke the backend's grant, record the exit.
async fn supervise(
    Process {
        mut child,
        tree,
        lease,
    }: Process,
    running: Arc<Running>,
    revoked: CancellationToken,
    grants: GrantStore,
    history: Arc<History>,
) {
    let pid = running.pid;
    let ending = tokio::select! {
        status = child.wait() => Ending::Exited(status),
        () = running.stop.cancelled() => Ending::Stopped(running.stop_reason(StopReason::Unspecified)),
        // A stop requested just before the revocation (a blocked tab) keeps its reason.
        () = revoked.cancelled() => Ending::Stopped(running.stop_reason(StopReason::GrantRevoked)),
        failure = handshake::failed(&running.handshake, running.ready_budget) => {
            Ending::Refused(failure)
        }
    };
    let exit = match ending {
        Ending::Exited(status) => ending::exited(status, &running, &history).await,
        Ending::Stopped(reason) => ExitRecord {
            code: stop_child(&mut child, &tree, &running).await,
            reason: reason.to_string(),
            crashed: false,
        },
        Ending::Refused(failure) => {
            if failure.kind == FailureKind::ProtocolMismatch {
                // The same binary would fail the same way: no restart until
                // the user asks for one.
                history.refuse(failure.message.clone());
            }
            ExitRecord {
                code: stop_child(&mut child, &tree, &running).await,
                reason: failure.message,
                crashed: true,
            }
        }
    };
    // Requests still waiting on a run that ended before it was ready.
    handshake::settle(
        &running.handshake,
        Handshake::Failed(HandshakeFailure::exited(&exit.reason)),
    );
    if let Err(error) = tree.cleanup_after_exit(Some(pid)).await {
        history.push_stderr(format!(
            "[cadencr] could not clean up its processes: {error}"
        ));
    }
    tracing::info!(
        pid,
        reason = exit.reason,
        crashed = exit.crashed,
        "custom tab backend exited"
    );
    let reason = exit.reason.clone();
    // Recorded before `exited` fires, so a status read as "not running"
    // already says why.
    history.record_exit(running.run, exit);
    // Its revision may be reclaimed now.
    if let Some(lease) = lease {
        ending::release(lease, &history).await;
    }
    // Ends `write_stdin` after a process that exited on its own.
    running.stop.cancel();
    running.exited.cancel();
    grants.revoke_key(&running.grant_key);
    for (_, waiter) in lock(&running.pending).drain() {
        let _ = waiter.send(Reply::Exited(reason.clone()));
    }
}

/// Close stdin, the backend's cue to exit (a revoked grant or a failed
/// handshake has not cancelled `stop` yet), then terminate the tree if it
/// outlasts [`EXIT_GRACE`]. Its exit code, when it has one.
async fn stop_child(
    child: &mut Child,
    tree: &ProcessTreeControl,
    running: &Running,
) -> Option<i32> {
    running.stop.cancel();
    match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
        Ok(Ok(status)) => status.code(),
        _ => tree
            .terminate(child, TERMINATE_GRACE)
            .await
            .ok()
            .and_then(|status| status.code()),
    }
}
