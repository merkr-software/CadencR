use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use tokio::sync::RwLock;

use super::provider::{CiRollup, CiState, PrStatusSnapshot};
use crate::error::AppError;
use crate::shared::singleflight::Singleflight;

mod publish_order;

pub(super) use publish_order::PublishOrder;

#[derive(Default)]
pub struct ForgeStatusCache {
    by_feature: RwLock<HashMap<i64, PrStatusSnapshot>>,
    /// The branch each published snapshot's top-level proposal belongs to.
    current_branches: RwLock<HashMap<i64, String>>,
    /// Serializes full polls, network calls included, so concurrent sweeps
    /// (periodic, forced, HTTP) never query the forges twice at once.
    pub(super) sweep_lock: tokio::sync::Mutex<()>,
    /// Held only to publish, by full and per-feature polls alike. Remembers
    /// which target resolution each publication came from, so a poll that
    /// resolved its branches earlier never republishes an older view.
    pub(super) publish_order: tokio::sync::Mutex<PublishOrder>,
    /// Numbers target resolutions in the order they start.
    pub(super) resolve_tickets: AtomicU64,
    /// Bumped by forced/on-demand refreshes so the background poller drops its
    /// cached `next_due_at` (e.g., when auth changed or CI entered `Running`).
    schedule_generation: AtomicU64,
    pub(super) forced: ForcedRefreshQueue,
    /// Coalesces concurrent HTTP full-refresh callers onto one in-flight sweep.
    pub(super) full_refresh: Singleflight<(), Result<(), AppError>>,
    /// Coalesces concurrent HTTP single-feature callers onto one in-flight refresh.
    pub(super) feature_refreshes: Singleflight<i64, Result<(), AppError>>,
}

/// Forced refreshes asked for with `request_refresh`. One worker runs them;
/// every request made while it polls folds into a single follow-up poll, so a
/// burst of branch moves costs one forge sweep, not one each.
#[derive(Default)]
pub(super) struct ForcedRefreshQueue {
    state: Mutex<ForcedRefreshState>,
}

#[derive(Default)]
struct ForcedRefreshState {
    requested: bool,
    running: bool,
}

impl ForcedRefreshQueue {
    /// Record a request; true when the caller must start the worker.
    pub(super) fn request(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.requested = true;
        !std::mem::replace(&mut state.running, true)
    }

    /// Claim the pending request for the worker; false (and the worker stops)
    /// when none is left.
    pub(super) fn take(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if std::mem::take(&mut state.requested) {
            return true;
        }
        state.running = false;
        false
    }

    /// The worker ended without draining (it panicked): let the next request
    /// start another. True when a request is still pending.
    pub(super) fn abandon(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.running = false;
        state.requested
    }
}

impl ForgeStatusCache {
    pub async fn list(&self) -> Vec<PrStatusSnapshot> {
        let mut values = self
            .by_feature
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by_key(|snapshot| snapshot.feature_id);
        values
    }

    pub async fn get(&self, feature_id: i64) -> Option<PrStatusSnapshot> {
        self.by_feature.read().await.get(&feature_id).cloned()
    }

    /// Whether a snapshot was published for `feature_id`, without cloning it.
    pub(super) async fn contains(&self, feature_id: i64) -> bool {
        self.by_feature.read().await.contains_key(&feature_id)
    }

    /// Whether any proposal in `feature_id`'s published snapshot has checks
    /// still running, without cloning the snapshot.
    pub(super) async fn has_running_ci(&self, feature_id: i64) -> bool {
        let running = |ci: Option<&CiRollup>| ci.is_some_and(|ci| ci.state == CiState::Running);
        self.by_feature
            .read()
            .await
            .get(&feature_id)
            .is_some_and(|snapshot| {
                running(snapshot.ci.as_ref())
                    || snapshot
                        .other_prs
                        .iter()
                        .any(|other| running(other.ci.as_ref()))
            })
    }

    pub async fn is_fresh(&self, feature_id: i64, stale_ms: i64) -> bool {
        self.by_feature
            .read()
            .await
            .get(&feature_id)
            .is_some_and(|status| {
                chrono::Utc::now()
                    .timestamp_millis()
                    .saturating_sub(status.fetched_at)
                    < stale_ms
            })
    }

    pub async fn matches_feature_ids(&self, feature_ids: &HashSet<i64>) -> bool {
        let cache = self.by_feature.read().await;
        cache.len() == feature_ids.len() && feature_ids.iter().all(|id| cache.contains_key(id))
    }

    pub(super) fn bump_schedule_generation(&self) {
        self.schedule_generation.fetch_add(1, Ordering::Release);
    }

    pub(super) fn schedule_generation(&self) -> u64 {
        self.schedule_generation.load(Ordering::Acquire)
    }

    /// Store a snapshot and report whether a semantically-visible field changed.
    /// `fetched_at` alone never emits a WebSocket event.
    pub async fn upsert(&self, snapshot: PrStatusSnapshot) -> bool {
        let mut cache = self.by_feature.write().await;
        let changed = cache
            .get(&snapshot.feature_id)
            .is_none_or(|existing| !existing.semantic_eq(&snapshot));
        cache.insert(snapshot.feature_id, snapshot);
        changed
    }

    /// Record the branch the poller just treated as `feature_id`'s current one.
    pub(super) async fn set_current_branch(&self, feature_id: i64, branch: Option<&str>) {
        let mut branches = self.current_branches.write().await;
        match branch {
            Some(branch) => branches.insert(feature_id, branch.to_string()),
            None => branches.remove(&feature_id),
        };
    }

    /// Note `current` as `feature_id`'s current branch and report whether the
    /// published snapshot describes another one — the conversation switched
    /// branches since the last poll. True once per switch: the git status
    /// recomputes that follow see `current` already noted.
    pub async fn note_current_branch(&self, feature_id: i64, current: &str) -> bool {
        // Read first: nearly every recompute finds nothing new.
        let unchanged = self
            .current_branches
            .read()
            .await
            .get(&feature_id)
            .is_none_or(|known| known == current);
        if unchanged {
            return false;
        }
        let mut branches = self.current_branches.write().await;
        match branches.get_mut(&feature_id) {
            Some(known) if known != current => {
                *known = current.to_string();
                true
            }
            _ => false,
        }
    }

    pub async fn retain_features(&self, feature_ids: &HashSet<i64>) {
        self.by_feature
            .write()
            .await
            .retain(|feature_id, _| feature_ids.contains(feature_id));
        self.current_branches
            .write()
            .await
            .retain(|feature_id, _| feature_ids.contains(feature_id));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    #[test]
    fn requests_during_a_forced_refresh_fold_into_one_follow_up() {
        let queue = ForcedRefreshQueue::default();
        assert!(queue.request(), "the first request starts the worker");
        assert!(queue.take());
        // Three requests while the worker polls: no new worker, one more poll.
        assert!(!queue.request());
        assert!(!queue.request());
        assert!(!queue.request());
        assert!(queue.take());
        assert!(!queue.take(), "drained: the worker stops");
        assert!(queue.request(), "a later request starts a new worker");
        assert!(queue.abandon(), "the request it had not claimed is pending");
        assert!(
            queue.request(),
            "an abandoned worker does not block requests"
        );
    }

    #[tokio::test]
    async fn a_branch_switch_is_reported_once_and_only_after_a_poll() {
        let cache = ForgeStatusCache::default();
        // Nothing published yet: the first poll will describe the branch anyway.
        assert!(!cache.note_current_branch(1, "fix/b").await);

        cache.set_current_branch(1, Some("feature/a")).await;
        assert!(!cache.note_current_branch(1, "feature/a").await);
        assert!(cache.note_current_branch(1, "fix/b").await);
        assert!(!cache.note_current_branch(1, "fix/b").await);
        assert!(cache.note_current_branch(1, "feature/a").await);
    }

    #[tokio::test]
    async fn singleflight_coalesces_concurrent_http_refreshes_and_preserves_error_variants() {
        let sf = Arc::new(Singleflight::<i64, Result<(), AppError>>::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());

        let mut tasks = Vec::new();
        for _ in 0..4 {
            let sf = Arc::clone(&sf);
            let runs = Arc::clone(&runs);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            tasks.push(tokio::spawn(async move {
                sf.run(7, || {
                    let runs = Arc::clone(&runs);
                    let started = Arc::clone(&started);
                    let release = Arc::clone(&release);
                    async move {
                        runs.fetch_add(1, Ordering::SeqCst);
                        started.notify_one();
                        release.notified().await;
                        Err(AppError::database_busy("db locked"))
                    }
                })
                .await
            }));
        }

        started.notified().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        release.notify_waiters();
        for task in tasks {
            let err = task.await.unwrap().unwrap_err();
            assert!(
                matches!(err, AppError::DatabaseBusy(_)),
                "waiter must preserve structured AppError variant, got {err:?}"
            );
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }
}
