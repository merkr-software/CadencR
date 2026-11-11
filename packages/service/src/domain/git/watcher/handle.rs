//! Per-worktree handle and refcount lifecycle helpers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::Message;
use notify_debouncer_mini::Debouncer;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tracing::debug;

use super::debouncer::{build_debouncer, resolve_git_roots, spawn_compute_task};
use crate::app_state::AppState;
use crate::error::AppError;
use crate::shared::keyed_locks::KeyedLocks;

/// Grace period before tearing down a watcher whose refcount hits zero.
pub(super) const GRACE_PERIOD: Duration = Duration::from_secs(30);

/// One subscriber tied to a specific WebSocket connection.
///
/// `target_branch` is intentionally **not** cached here: it's mutable state
/// (the user can change it via the branch chip → PATCH), and a stale cached
/// value made target-branch changes silently no-op the recompute. The
/// recompute path resolves it fresh from the DB per (feature_id) on every
/// run; the cost is one indexed `feature_settings` lookup per debounce
/// window, which is negligible compared to the git calls that follow.
pub(super) struct Subscriber {
    pub(super) feature_id: i64,
    pub(super) sender: mpsc::UnboundedSender<Message>,
}

/// What the fs callback pushes through to the compute task.
pub(super) enum RecomputePing {
    /// Triggered by debounced fs events.
    FsEvent(u64),
    /// Asks the compute task to exit (used by `shutdown`).
    Shutdown,
}

/// Per-worktree state. Multiple features (and multiple WS sessions per
/// feature) may register against a single handle.
pub(super) struct WatcherHandle {
    pub(super) subscribers: Vec<Subscriber>,
    /// Underlying fs watcher; dropping releases the OS resources.
    pub(super) _debouncer: Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>,
    /// Channel the fs callback pushes coalesced "recompute requested" pings on.
    pub(super) ping_tx: mpsc::UnboundedSender<RecomputePing>,
    /// Background task that consumes `ping_tx` and runs `compute_status`.
    pub(super) compute_task: JoinHandle<()>,
    /// Last time a Cadencr-initiated write was confirmed (unix millis).
    pub(super) last_nudge_ms: Arc<AtomicI64>,
    /// Bumped whenever a user-initiated write supersedes queued fs work.
    pub(super) write_generation: Arc<AtomicU64>,
    /// Pending grace-timer task — `None` while the handle has subscribers.
    pub(super) grace_task: Option<JoinHandle<()>>,
    /// Bumped on every subscribe/unsubscribe so the grace timer can detect
    /// resubscription during the 30-second window.
    pub(super) epoch: Arc<AtomicU64>,
}

impl WatcherHandle {
    pub(super) fn cancel_grace(&mut self) {
        if let Some(task) = self.grace_task.take() {
            task.abort();
        }
    }
}

/// Inner registry state — a `HashMap` keyed by canonicalized worktree path.
///
/// Held only for bookkeeping, never across a Git command or a filesystem walk:
/// every subscription, WebSocket teardown and refresh in the app waits on it.
pub(super) struct RegistryInner {
    pub(super) handles: HashMap<PathBuf, WatcherHandle>,
    /// Serializes the Git work of one repository (status snapshots, watcher
    /// start) without holding up the others.
    pub(super) repo_locks: Arc<KeyedLocks<PathBuf>>,
}

/// The lock serializing Git work on `worktree_path`.
pub(super) async fn repo_lock(
    registry: &Mutex<RegistryInner>,
    worktree_path: &Path,
) -> Arc<Mutex<()>> {
    let locks = registry.lock().await.repo_locks.clone();
    locks.lock_for(&worktree_path.to_path_buf()).await
}

/// Spawn a fresh handle: resolve the Git directories, start the fs watcher
/// off the async runtime (a recursive watch walks the whole tree), and spawn
/// the compute task. The caller must not hold the registry lock.
pub(super) async fn spawn_handle(
    registry: Arc<Mutex<RegistryInner>>,
    worktree_path: PathBuf,
    state: AppState,
) -> Result<WatcherHandle, AppError> {
    let last_nudge_ms = Arc::new(AtomicI64::new(0));
    let write_generation = Arc::new(AtomicU64::new(0));
    let last_compute_ms = Arc::new(AtomicI64::new(0));
    let epoch = Arc::new(AtomicU64::new(0));
    let (ping_tx, ping_rx) = mpsc::unbounded_channel::<RecomputePing>();

    let extra_git_roots = resolve_git_roots(&worktree_path).await;
    let debouncer = tokio::task::spawn_blocking({
        let worktree_path = worktree_path.clone();
        let ping_tx = ping_tx.clone();
        let last_nudge_ms = last_nudge_ms.clone();
        let write_generation = write_generation.clone();
        move || {
            build_debouncer(
                worktree_path,
                extra_git_roots,
                ping_tx,
                last_nudge_ms,
                write_generation,
            )
        }
    })
    .await
    .map_err(|error| AppError::internal(format!("git watcher start failed: {error}")))??;

    let compute_task = spawn_compute_task(
        registry,
        worktree_path,
        state,
        ping_rx,
        last_compute_ms,
        last_nudge_ms.clone(),
        write_generation.clone(),
    );

    Ok(WatcherHandle {
        subscribers: Vec::new(),
        _debouncer: debouncer,
        ping_tx,
        compute_task,
        last_nudge_ms,
        write_generation,
        grace_task: None,
        epoch,
    })
}

/// Schedule a deferred drop for an empty handle. Captures the `epoch` at
/// scheduling time; if a resubscribe bumps it before the timer fires, the
/// drop is a no-op.
pub(super) fn schedule_grace_drop(
    inner: &mut RegistryInner,
    path: &Path,
    registry: Arc<Mutex<RegistryInner>>,
) {
    let Some(handle) = inner.handles.get_mut(path) else {
        return;
    };
    handle.cancel_grace();
    let epoch_at_schedule = handle.epoch.load(Ordering::Relaxed);
    let epoch = handle.epoch.clone();
    let path_owned = path.to_path_buf();
    let task = tokio::spawn(async move {
        tokio::time::sleep(GRACE_PERIOD).await;
        if epoch.load(Ordering::Relaxed) != epoch_at_schedule {
            return;
        }
        let mut inner = registry.lock().await;
        if let Some(handle) = inner.handles.get(&path_owned) {
            if !handle.subscribers.is_empty() {
                return;
            }
        }
        if let Some(mut handle) = inner.handles.remove(&path_owned) {
            let _ = handle.ping_tx.send(RecomputePing::Shutdown);
            handle.cancel_grace();
            handle.compute_task.abort();
            debug!(path = %path_owned.display(), "git watcher dropped after grace");
        }
    });
    handle.grace_task = Some(task);
}

/// Best-effort sender identity check. `mpsc::UnboundedSender` exposes
/// `same_channel`, which is what we want — every WS connection holds one
/// sender clone.
pub(super) fn sender_eq(
    a: &mpsc::UnboundedSender<Message>,
    b: &mpsc::UnboundedSender<Message>,
) -> bool {
    a.same_channel(b)
}
