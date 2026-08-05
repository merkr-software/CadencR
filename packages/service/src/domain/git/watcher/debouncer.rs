//! `notify-debouncer-mini` callback wiring + the background compute task.
//!
//! The compute task pulls `RecomputePing`s from a channel, applies the
//! sustained-churn cap, runs `compute_status` per registered feature, and
//! pushes `git.status` envelopes back over the WS senders.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::Message;
use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEvent, DebouncedEventKind, Debouncer};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use super::filter::is_relevant;
use super::handle::{RecomputePing, RegistryInner};
use crate::app_state::AppState;
use crate::domain::git::git_status;
use crate::domain::ws_session::protocol::WsEnvelope;

/// Debounce window for raw fs events before triggering a recompute.
pub(super) const GIT_WATCHER_DEBOUNCE_MS: u64 = 250;
/// Window after a `nudge()` during which raw fs events are ignored as our
/// own writes (commit, push, etc.).
pub(super) const NUDGE_DEDUPE_MS: i64 = 750;
/// Minimum gap between successive recomputes for the same worktree under
/// sustained churn.
const MIN_RECOMPUTE_GAP_MS: i64 = 1000;
/// Slow-compute threshold; above this we coalesce.
const SLOW_COMPUTE_MS: u128 = 500;

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Build the underlying `notify-debouncer-mini` and start watching the
/// worktree recursively.
///
/// For linked worktrees (`git worktree add`), the worktree's gitdir and the
/// shared common dir live outside the worktree path. We resolve both via
/// `git rev-parse` and add them as additional watched roots so events on
/// `index`, `HEAD`, refs, etc. are not missed.
pub(super) fn build_debouncer(
    worktree_path: PathBuf,
    ping_tx: mpsc::UnboundedSender<RecomputePing>,
    last_nudge_ms: Arc<AtomicI64>,
    write_generation: Arc<AtomicU64>,
) -> Result<Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>, crate::error::AppError> {
    let extra_git_roots = resolve_git_roots(&worktree_path);
    let cb_path = worktree_path.clone();
    let cb_extra = extra_git_roots.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(GIT_WATCHER_DEBOUNCE_MS),
        move |result: Result<Vec<DebouncedEvent>, _>| {
            let events = match result {
                Ok(events) => events,
                Err(e) => {
                    warn!("git watcher error: {e:?}");
                    return;
                }
            };
            let generation = write_generation.load(Ordering::Acquire);
            // Self-write dedupe: ignore raw fs events within NUDGE_DEDUPE_MS
            // of an explicit nudge.
            if now_ms() - last_nudge_ms.load(Ordering::Relaxed) < NUDGE_DEDUPE_MS {
                debug!(
                    path = %cb_path.display(),
                    "git watcher: dropping fs event in self-write window"
                );
                return;
            }
            if has_relevant_event(&cb_path, &cb_extra, &events) {
                let _ = ping_tx.send(RecomputePing::FsEvent(generation));
            }
        },
    )
    .map_err(|e| crate::error::AppError::Internal(format!("git watcher: {e}")))?;

    debouncer
        .watcher()
        .watch(&worktree_path, RecursiveMode::Recursive)
        .map_err(|e| crate::error::AppError::Internal(format!("git watcher watch: {e}")))?;

    // Linked-worktree support: the worktree's own gitdir
    // (`<main>/.git/worktrees/<name>/`) and the shared common dir
    // (`<main>/.git/`) hold the index, HEAD, and refs we need to observe.
    // Skip any root that's already inside `worktree_path` (the embedded-gitdir
    // case for the main worktree) — `notify` would otherwise emit duplicate
    // events from overlapping recursive watches.
    for extra in &extra_git_roots {
        if path_starts_with(extra, &worktree_path) {
            continue;
        }
        if let Err(e) = debouncer.watcher().watch(extra, RecursiveMode::Recursive) {
            // Non-fatal: surface it, but keep the worktree watcher running.
            // A missing common-dir watch only means linked-worktree events on
            // refs/HEAD won't be observed; fs events inside the worktree
            // still trigger recomputes, which still pick up index changes.
            warn!(
                path = %extra.display(),
                error = %e,
                "git watcher: failed to watch extra git root, continuing without it"
            );
        }
    }

    Ok(debouncer)
}

/// Both settled and continuous debounced events represent real filesystem
/// changes. The compute task coalesces sustained churn, so forwarding both
/// variants remains bounded.
fn has_relevant_event(
    worktree_root: &Path,
    extra_git_roots: &[PathBuf],
    events: &[DebouncedEvent],
) -> bool {
    events.iter().any(|event| {
        matches!(
            event.kind,
            DebouncedEventKind::Any | DebouncedEventKind::AnyContinuous
        ) && is_relevant(worktree_root, extra_git_roots, &event.path)
    })
}

/// Resolve the worktree-specific gitdir and the shared common dir for
/// `worktree_path`. Returns canonicalized paths, deduped. Empty on error
/// (caller logs and continues — see `build_debouncer`).
fn resolve_git_roots(worktree_path: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::with_capacity(2);
    for arg in ["--git-dir", "--git-common-dir"] {
        let Some(raw) = run_git_rev_parse(worktree_path, arg) else {
            continue;
        };
        // `git rev-parse --git-dir` may return a path relative to the
        // worktree (`.git`) or absolute (linked worktree). Normalize.
        let candidate = if Path::new(&raw).is_absolute() {
            PathBuf::from(&raw)
        } else {
            worktree_path.join(&raw)
        };
        let canonical = std::fs::canonicalize(&candidate).unwrap_or(candidate);
        if !roots.iter().any(|p| p == &canonical) {
            roots.push(canonical);
        }
    }
    roots
}

/// Synchronous `git rev-parse <arg>` helper — `build_debouncer` itself is
/// sync (called from `spawn_handle`) and the cost is one fork per watcher
/// startup, which is negligible.
fn run_git_rev_parse(cwd: &Path, arg: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", arg])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn path_starts_with(child: &Path, parent: &Path) -> bool {
    child.starts_with(parent)
}

/// Spawn the long-lived compute task. Exits when `RecomputePing::Shutdown`
/// is received or the channel closes.
pub(super) fn spawn_compute_task(
    registry: Arc<Mutex<RegistryInner>>,
    worktree_path: PathBuf,
    state: AppState,
    mut ping_rx: mpsc::UnboundedReceiver<RecomputePing>,
    last_compute_ms: Arc<AtomicI64>,
    last_nudge_ms: Arc<AtomicI64>,
    write_generation: Arc<AtomicU64>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(ping) = ping_rx.recv().await {
            let mut expected_generation = match ping {
                RecomputePing::FsEvent(generation) => generation,
                RecomputePing::Shutdown => break,
            };
            // Sustained-churn cap: ensure at least MIN_RECOMPUTE_GAP_MS
            // between recomputes.
            let now = now_ms();
            let last = last_compute_ms.load(Ordering::Relaxed);
            let elapsed = now - last;
            if elapsed < MIN_RECOMPUTE_GAP_MS {
                tokio::time::sleep(Duration::from_millis(
                    (MIN_RECOMPUTE_GAP_MS - elapsed) as u64,
                ))
                .await;
            }
            // Always collapse work queued during the previous Git computation.
            // In large repositories that computation can exceed the minimum
            // gap; draining only after the sleep would then replay every stale
            // ping from the unbounded channel.
            match drain_latest_generation(&mut ping_rx) {
                Ok(Some(generation)) => expected_generation = generation,
                Ok(None) => {}
                Err(()) => return,
            }
            if write_generation.load(Ordering::Acquire) != expected_generation
                || now_ms() - last_nudge_ms.load(Ordering::Relaxed) < NUDGE_DEDUPE_MS
            {
                continue;
            }
            last_compute_ms.store(now_ms(), Ordering::Relaxed);

            let started = std::time::Instant::now();
            recompute_for_path(
                &registry,
                &worktree_path,
                &state,
                Some((write_generation.clone(), expected_generation)),
            )
            .await;
            let elapsed = started.elapsed();
            if elapsed.as_millis() > SLOW_COMPUTE_MS {
                debug!(
                    path = %worktree_path.display(),
                    ms = elapsed.as_millis(),
                    "git watcher: slow compute, will coalesce"
                );
            }
        }
    })
}

/// Coalesce pending fs pings to their latest write generation. A shutdown
/// takes precedence so the background task can exit promptly.
fn drain_latest_generation(
    ping_rx: &mut mpsc::UnboundedReceiver<RecomputePing>,
) -> Result<Option<u64>, ()> {
    let mut latest = None;
    while let Ok(extra) = ping_rx.try_recv() {
        match extra {
            RecomputePing::FsEvent(generation) => latest = Some(generation),
            RecomputePing::Shutdown => return Err(()),
        }
    }
    Ok(latest)
}

/// Resolve the live subscriber list for a worktree, then run
/// `compute_status` per feature and broadcast the resulting envelopes.
///
/// `target_branch` is resolved fresh from the DB per feature on every call
/// (not cached on `Subscriber`) so that a target-branch PATCH propagates on
/// the next recompute without needing the registry to be mutated.
///
/// `pub(super)` so the parent `mod.rs` can drive a synchronous recompute
/// from `recompute_and_broadcast` (commit / push handlers) without going
/// through the channel + gap-enforcement path that fs events take.
pub(super) async fn recompute_for_path(
    registry: &Arc<Mutex<RegistryInner>>,
    worktree_path: &Path,
    state: &AppState,
    expected_write_generation: Option<(Arc<AtomicU64>, u64)>,
) {
    // Skip observer runs that begin while Cadencr owns the worktree mutation.
    // The endpoint drops its permit before `confirm_after_write`, which emits
    // the fresh snapshot afterward. An observer already in flight remains
    // protected by `--no-optional-locks` and the update runner's bounded lock
    // recovery; terminal-driven mutations keep the existing read protection.
    if state.git_mutations.is_active_canonical(worktree_path) {
        return;
    }

    // Snapshot the subscriber list under the lock, then drop it before
    // running per-feature compute calls so we don't serialize on the slow
    // git call.
    let snapshot_inputs: Vec<(i64, mpsc::UnboundedSender<Message>)> = {
        let inner = registry.lock().await;
        match inner.handles.get(worktree_path) {
            Some(handle) => handle
                .subscribers
                .iter()
                .map(|s| (s.feature_id, s.sender.clone()))
                .collect(),
            None => return,
        }
    };

    // Group senders by feature_id so we issue a single `compute_status` per
    // feature and fan out the result to every subscriber on that feature.
    let mut by_feature: HashMap<i64, Vec<mpsc::UnboundedSender<Message>>> = HashMap::new();
    for (fid, tx) in snapshot_inputs {
        by_feature.entry(fid).or_default().push(tx);
    }

    let futs = by_feature.into_iter().map(|(fid, senders)| {
        let path = worktree_path.to_path_buf();
        let state = state.clone();
        let expected_write_generation = expected_write_generation.clone();
        async move {
            // Re-resolve target_branch every time so PATCHes on the
            // feature setting are reflected without registry mutation.
            // Falls back to "main" so a transient DB error still yields
            // a determinate snapshot rather than a blank one.
            let target =
                crate::domain::git::workflow_service::resolve_target_branch(&state, fid, &path)
                    .await
                    .unwrap_or_else(|_| "main".to_string());
            match git_status::compute_status_or_empty(&path, fid, &target).await {
                Ok(mut snap) => {
                    crate::domain::git::workflow_service::enrich_with_sharing(
                        &state,
                        &mut snap,
                        &path.to_string_lossy(),
                    )
                    .await;
                    if generation_changed(&expected_write_generation) {
                        return;
                    }
                    let env =
                        WsEnvelope::new("git", "status", serde_json::to_value(&snap).unwrap());
                    broadcast(&senders, &env);
                }
                Err(err) => {
                    if generation_changed(&expected_write_generation) {
                        return;
                    }
                    warn!(
                        feature_id = fid,
                        path = %path.display(),
                        error = %err,
                        "git watcher: compute_status failed"
                    );
                    let env = WsEnvelope::new(
                        "git",
                        "status_error",
                        serde_json::json!({
                            "feature_id": fid,
                            "error": err.to_string(),
                        }),
                    );
                    broadcast(&senders, &env);
                }
            }
        }
    });

    futures::future::join_all(futs).await;
}

fn generation_changed(expected: &Option<(Arc<AtomicU64>, u64)>) -> bool {
    expected
        .as_ref()
        .is_some_and(|(generation, value)| generation.load(Ordering::Acquire) != *value)
}

fn broadcast(senders: &[mpsc::UnboundedSender<Message>], envelope: &WsEnvelope) {
    let payload = String::from(envelope.clone());
    for tx in senders {
        let _ = tx.send(Message::Text(payload.clone().into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuous_events_trigger_a_refresh() {
        let root = PathBuf::from("/repo");
        let events = vec![DebouncedEvent::new(
            root.join("src/main.rs"),
            DebouncedEventKind::AnyContinuous,
        )];

        assert!(has_relevant_event(&root, &[], &events));
    }

    #[test]
    fn continuous_git_noise_stays_filtered() {
        let root = PathBuf::from("/repo");
        let events = vec![DebouncedEvent::new(
            root.join(".git/objects/aa/bb"),
            DebouncedEventKind::AnyContinuous,
        )];

        assert!(!has_relevant_event(&root, &[], &events));
    }

    #[tokio::test]
    async fn rapid_writes_coalesce_to_one_emission() {
        // Simulate the fs callback path directly: the OS-level debouncer is
        // too platform-dependent to assert exact emission counts in a unit
        // test. What we own is the channel between callback and compute
        // task, and the gap-enforcement drain logic.
        let (tx, mut rx) = mpsc::unbounded_channel::<RecomputePing>();
        for _ in 0..5 {
            tx.send(RecomputePing::FsEvent(0)).unwrap();
        }
        let _first = rx.recv().await.unwrap();
        let mut drained = 0;
        while let Ok(_extra) = rx.try_recv() {
            drained += 1;
        }
        assert_eq!(drained, 4, "remaining pings should be coalesced");
    }

    #[test]
    fn drain_latest_generation_honors_shutdown() {
        let (tx, mut rx) = mpsc::unbounded_channel::<RecomputePing>();
        tx.send(RecomputePing::FsEvent(1)).unwrap();
        tx.send(RecomputePing::Shutdown).unwrap();
        assert_eq!(drain_latest_generation(&mut rx), Err(()));
    }

    #[test]
    fn drain_latest_generation_coalesces_to_newest_ping() {
        let (tx, mut rx) = mpsc::unbounded_channel::<RecomputePing>();
        tx.send(RecomputePing::FsEvent(1)).unwrap();
        tx.send(RecomputePing::FsEvent(2)).unwrap();
        assert_eq!(drain_latest_generation(&mut rx), Ok(Some(2)));
    }
}
