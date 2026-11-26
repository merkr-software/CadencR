//! fs watch callback wiring + the background compute loop.
//!
//! The compute task pulls `RecomputePing`s from a channel, applies the
//! post-completion sustained-churn cooldown (with adaptive backoff on slow
//! recomputes), and delegates the actual Git refresh + fan-out to
//! [`super::recompute`].

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tracing::debug;

use super::filter::is_relevant;
use super::handle::{RecomputePing, RegistryInner};
use super::recompute::recompute_for_path;
use crate::app_state::AppState;
use crate::error::AppError;
use crate::shared::discard::IgnoreClosed;
use crate::shared::git_cli::run_git_background;
use crate::shared::ignore_watch::IgnoreAwareWatcher;
use crate::shared::watch_limits::describe_watch_error;

/// Debounce window for raw fs events before triggering a recompute.
pub(super) const GIT_WATCHER_DEBOUNCE_MS: u64 = 250;
/// Window after a `nudge()` during which raw fs events are ignored as our
/// own writes (commit, push, etc.).
pub(super) const NUDGE_DEDUPE_MS: i64 = 750;
/// Minimum post-completion rest gap between successive recomputes for the
/// same worktree under sustained churn.
const MIN_RECOMPUTE_GAP_MS: i64 = 1000;
/// Slow-compute threshold; above this the cooldown stretches adaptively.
const SLOW_COMPUTE_MS: u128 = 500;
/// Upper bound for adaptive slow-compute cooldown backoff.
const MAX_ADAPTIVE_GAP_MS: i64 = 5000;

/// Monotonic millisecond timestamp (`>= 1`, reserving `0` for "never").
/// Immune to NTP wall-clock steps backward.
pub(super) fn now_ms() -> i64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    let elapsed = EPOCH.get_or_init(Instant::now).elapsed().as_millis();
    i64::try_from(elapsed)
        .unwrap_or(i64::MAX - 1)
        .saturating_add(1)
}

fn within_nudge_window(last_nudge_ms: i64, now: i64) -> bool {
    if last_nudge_ms <= 0 {
        return false;
    }
    let since_nudge = now.saturating_sub(last_nudge_ms);
    (0..NUDGE_DEDUPE_MS).contains(&since_nudge)
}

fn remaining_cooldown_ms(last_compute_ms: i64, now: i64, gap_ms: i64) -> Option<u64> {
    if last_compute_ms <= 0 {
        return None;
    }
    let since_last = now.saturating_sub(last_compute_ms);
    if since_last < 0 || since_last >= gap_ms {
        return None;
    }
    u64::try_from(gap_ms - since_last).ok()
}

fn next_cooldown_gap_ms(compute_elapsed: Duration) -> i64 {
    if compute_elapsed.as_millis() > SLOW_COMPUTE_MS {
        let doubled = i64::try_from(compute_elapsed.as_millis().saturating_mul(2))
            .unwrap_or(MAX_ADAPTIVE_GAP_MS);
        doubled.clamp(MIN_RECOMPUTE_GAP_MS, MAX_ADAPTIVE_GAP_MS)
    } else {
        MIN_RECOMPUTE_GAP_MS
    }
}

/// Start the gitignore-aware fs watch of the worktree. Blocking: walks the
/// non-ignored tree once.
pub(super) fn build_watcher(
    worktree_path: PathBuf,
    git_roots: Vec<PathBuf>,
    ping_tx: mpsc::UnboundedSender<RecomputePing>,
    last_nudge_ms: Arc<AtomicI64>,
    write_generation: Arc<AtomicU64>,
) -> Result<IgnoreAwareWatcher, AppError> {
    let cb_path = worktree_path.clone();
    let cb_roots = git_roots.clone();
    let on_change = move |paths: Vec<PathBuf>| {
        let generation = write_generation.load(Ordering::Acquire);
        if within_nudge_window(last_nudge_ms.load(Ordering::Relaxed), now_ms()) {
            debug!(
                path = %cb_path.display(),
                "git watcher: dropping fs event in self-write window"
            );
            return;
        }
        if has_relevant_path(&cb_path, &cb_roots, &paths) {
            ping_tx
                .send(RecomputePing::FsEvent(generation))
                .ignore_closed();
        }
    };
    let watcher = IgnoreAwareWatcher::start(
        worktree_path,
        git_roots,
        Duration::from_millis(GIT_WATCHER_DEBOUNCE_MS),
        on_change,
    )
    .map_err(|e| AppError::internal(describe_watch_error("git watcher", &e)))?;
    debug!(watches = watcher.watch_count(), "git watcher started");
    Ok(watcher)
}

/// The watch already dropped gitignored paths; this drops Git's own churn.
fn has_relevant_path(worktree_root: &Path, git_roots: &[PathBuf], paths: &[PathBuf]) -> bool {
    paths
        .iter()
        .any(|path| is_relevant(worktree_root, git_roots, path))
}

/// Resolve the worktree-specific gitdir and the shared common dir for
/// `worktree_path`. Returns canonicalized paths, deduped.
pub(super) async fn resolve_git_roots(worktree_path: &Path) -> Result<Vec<PathBuf>, AppError> {
    let output = run_git_background(
        &["rev-parse", "--git-dir", "--git-common-dir"],
        worktree_path,
    )
    .await?;
    let mut roots: Vec<PathBuf> = Vec::with_capacity(2);
    for raw in output.lines().filter(|line| !line.is_empty()) {
        let candidate = worktree_path.join(raw);
        let canonical = tokio::fs::canonicalize(&candidate)
            .await
            .unwrap_or(candidate);
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
    }
    Ok(roots)
}

/// Spawn the long-lived compute task. Exits when `RecomputePing::Shutdown`
/// is received or the channel closes.
pub(super) fn spawn_compute_task(
    registry: Arc<Mutex<RegistryInner>>,
    worktree_path: PathBuf,
    state: AppState,
    ping_rx: mpsc::UnboundedReceiver<RecomputePing>,
    last_compute_ms: Arc<AtomicI64>,
    last_nudge_ms: Arc<AtomicI64>,
    write_generation: Arc<AtomicU64>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let task_path = worktree_path.clone();
        let gen_for_closure = write_generation.clone();
        run_compute_loop(
            worktree_path,
            ping_rx,
            last_compute_ms,
            last_nudge_ms,
            write_generation,
            move |expected_generation| {
                let registry = registry.clone();
                let task_path = task_path.clone();
                let state = state.clone();
                let gen = gen_for_closure.clone();
                async move {
                    recompute_for_path(
                        &registry,
                        &task_path,
                        &state,
                        Some((gen, expected_generation)),
                    )
                    .await
                }
            },
        )
        .await;
    })
}

async fn run_compute_loop<F, Fut>(
    worktree_path: PathBuf,
    mut ping_rx: mpsc::UnboundedReceiver<RecomputePing>,
    last_compute_ms: Arc<AtomicI64>,
    last_nudge_ms: Arc<AtomicI64>,
    write_generation: Arc<AtomicU64>,
    mut run_recompute: F,
) where
    F: FnMut(u64) -> Fut,
    Fut: Future<Output = bool>,
{
    let mut current_gap_ms = MIN_RECOMPUTE_GAP_MS;
    while let Some(ping) = ping_rx.recv().await {
        let mut expected_generation = match ping {
            RecomputePing::FsEvent(generation) => generation,
            RecomputePing::Shutdown => break,
        };
        // Post-completion rest gap: ensures sustained edits never lock a slow
        // repository into a 100% duty-cycle `git status` loop.
        let last = last_compute_ms.load(Ordering::Relaxed);
        if let Some(sleep_ms) = remaining_cooldown_ms(last, now_ms(), current_gap_ms) {
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
        }
        match drain_latest_generation(&mut ping_rx) {
            Ok(Some(generation)) => expected_generation = generation,
            Ok(None) => {}
            Err(()) => return,
        }
        if write_generation.load(Ordering::Acquire) != expected_generation
            || within_nudge_window(last_nudge_ms.load(Ordering::Relaxed), now_ms())
        {
            continue;
        }

        let started = std::time::Instant::now();
        let did_compute = run_recompute(expected_generation).await;
        if !did_compute {
            continue;
        }
        let elapsed = started.elapsed();
        last_compute_ms.store(now_ms(), Ordering::Relaxed);
        current_gap_ms = next_cooldown_gap_ms(elapsed);
        if elapsed.as_millis() > SLOW_COMPUTE_MS {
            debug!(
                path = %worktree_path.display(),
                ms = elapsed.as_millis(),
                next_gap_ms = current_gap_ms,
                "git watcher: slow compute, extending post-completion cooldown"
            );
        }
    }
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    #[test]
    fn worktree_changes_trigger_a_refresh() {
        let root = PathBuf::from("/repo");
        assert!(has_relevant_path(&root, &[], &[root.join("src/main.rs")]));
    }

    #[test]
    fn git_noise_stays_filtered() {
        let root = PathBuf::from("/repo");
        assert!(!has_relevant_path(
            &root,
            &[],
            &[root.join(".git/objects/aa/bb")]
        ));
    }

    #[test]
    fn cooldown_and_nudge_helpers_ignore_unset_and_backward_timestamps() {
        assert_eq!(remaining_cooldown_ms(0, 10, MIN_RECOMPUTE_GAP_MS), None);
        assert_eq!(remaining_cooldown_ms(500, 200, MIN_RECOMPUTE_GAP_MS), None);
        assert_eq!(
            remaining_cooldown_ms(500, 750, MIN_RECOMPUTE_GAP_MS),
            Some(750)
        );
        assert_eq!(remaining_cooldown_ms(500, 1500, MIN_RECOMPUTE_GAP_MS), None);

        assert!(!within_nudge_window(0, 10));
        assert!(!within_nudge_window(500, 200));
        assert!(within_nudge_window(500, 700));
        assert!(!within_nudge_window(500, 500 + NUDGE_DEDUPE_MS));
    }

    #[test]
    fn adaptive_cooldown_scales_for_slow_computes_and_caps_at_five_seconds() {
        assert_eq!(
            next_cooldown_gap_ms(Duration::from_millis(100)),
            MIN_RECOMPUTE_GAP_MS
        );
        assert_eq!(
            next_cooldown_gap_ms(Duration::from_millis(500)),
            MIN_RECOMPUTE_GAP_MS
        );
        assert_eq!(next_cooldown_gap_ms(Duration::from_millis(750)), 1500);
        assert_eq!(next_cooldown_gap_ms(Duration::from_millis(1200)), 2400);
        assert_eq!(
            next_cooldown_gap_ms(Duration::from_millis(4000)),
            MAX_ADAPTIVE_GAP_MS
        );
    }

    #[tokio::test]
    async fn rapid_writes_coalesce_to_one_emission() {
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

    #[tokio::test]
    async fn slow_recompute_enforces_post_completion_adaptive_cooldown_before_next_ping() {
        let (ping_tx, ping_rx) = mpsc::unbounded_channel::<RecomputePing>();
        let last_compute_ms = Arc::new(AtomicI64::new(0));
        let last_nudge_ms = Arc::new(AtomicI64::new(0));
        let write_generation = Arc::new(AtomicU64::new(0));
        let (events_tx, mut events_rx) = mpsc::unbounded_channel::<(usize, std::time::Instant)>();
        let run_count = Arc::new(AtomicUsize::new(0));

        let loop_task = tokio::spawn({
            let run_count = Arc::clone(&run_count);
            run_compute_loop(
                PathBuf::from("/slow-repo"),
                ping_rx,
                last_compute_ms,
                last_nudge_ms,
                write_generation,
                move |_| {
                    let run_count = Arc::clone(&run_count);
                    let events_tx = events_tx.clone();
                    async move {
                        let idx = run_count.fetch_add(1, Ordering::SeqCst);
                        events_tx.send((idx, std::time::Instant::now())).unwrap();
                        if idx == 0 {
                            tokio::time::sleep(Duration::from_millis(1050)).await;
                        }
                        true
                    }
                },
            )
        });

        ping_tx.send(RecomputePing::FsEvent(0)).unwrap();
        let (first_idx, first_start) = events_rx.recv().await.unwrap();
        assert_eq!(first_idx, 0);

        tokio::time::sleep(Duration::from_millis(100)).await;
        ping_tx.send(RecomputePing::FsEvent(0)).unwrap();

        let (second_idx, second_start) =
            tokio::time::timeout(Duration::from_secs(5), events_rx.recv())
                .await
                .expect("second recompute should run after adaptive cooldown")
                .unwrap();
        assert_eq!(second_idx, 1);

        let first_end_approx = first_start + Duration::from_millis(1050);
        let post_completion_gap = second_start.saturating_duration_since(first_end_approx);
        assert!(
            post_completion_gap >= Duration::from_millis(1800),
            "expected adaptive post-completion gap (~2100 ms), got {post_completion_gap:?}"
        );

        ping_tx.send(RecomputePing::Shutdown).unwrap();
        loop_task.await.unwrap();
    }
}
