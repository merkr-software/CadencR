use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::time::Instant;

use futures::{stream, StreamExt};
use tracing::{info, warn};

mod assemble;
mod group;
mod matching;
mod schedule;
mod targets;
mod unresolved_threads;

use self::group::{build_single_group, group_targets, publish, refresh_group, PR_FANOUT};
use self::schedule::{
    compute_next_due, has_any_configured_auth, should_poll, should_skip_periodic_tick,
    PollSchedule, RUNNING_CI_POLL_INTERVAL,
};
use self::targets::target_without_repo_snapshot;
use super::auth::host_configs;
use super::cache::SharedRefreshError;
use super::provider::ForgeHostConfig;
use super::repository::{
    active_feature_targets, resolve_feature_target, FeatureForgeTarget, TrackedBranch,
};
use crate::app_state::AppState;
use crate::domain::git::host::{GitHost, RemoteInfo};
use crate::error::AppError;

#[derive(Clone, Hash, PartialEq, Eq)]
struct RepoKey {
    hostname: String,
    api_base_url: String,
    owner: String,
    repo: String,
    kind: GitHost,
}

struct RepoGroup {
    key: RepoKey,
    remote: RemoteInfo,
    kind: GitHost,
    config: Option<ForgeHostConfig>,
    features: Vec<GroupFeature>,
}

/// One conversation of a repo group and the branches to look proposals up
/// for — the current branch first.
struct GroupFeature {
    feature_id: i64,
    tracked: Vec<TrackedBranch>,
}

pub fn spawn(state: AppState) {
    info!("starting forge PR status poller");
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RUNNING_CI_POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut schedule = PollSchedule::default();
        loop {
            ticker.tick().await;
            if let Err(error) = refresh(&state, false, Some(&mut schedule)).await {
                warn!(%error, "forge PR status refresh failed");
            }
        }
    });
}

pub async fn refresh_all(state: &AppState) -> Result<(), AppError> {
    let result = refresh(state, true, None).await;
    if result.is_ok() {
        state.forge_status.bump_schedule_generation();
    }
    result
}

/// Refresh every active feature, coalescing concurrent HTTP callers onto a
/// single in-flight sweep.
pub async fn refresh_all_coalesced(state: &AppState) -> Result<(), AppError> {
    state
        .forge_status
        .full_refresh
        .run((), || async {
            refresh_all(state)
                .await
                .map_err(SharedRefreshError::from_app_error)
        })
        .await
        .map_err(SharedRefreshError::into_app_error)
}

/// Refresh a single feature's repo group on demand (for per-feature HTTP
/// routes), sharing an in-flight full or per-feature refresh when one is
/// already running.
pub async fn refresh_feature_coalesced(
    state: &AppState,
    feature_id: i64,
    stale_ms: i64,
) -> Result<(), AppError> {
    if state
        .forge_status
        .full_refresh
        .wait_if_running(&())
        .await
        .is_some()
        && state.forge_status.is_fresh(feature_id, stale_ms).await
    {
        return Ok(());
    }
    state
        .forge_status
        .feature_refreshes
        .run(feature_id, || async {
            refresh_single_feature(state, feature_id)
                .await
                .map_err(SharedRefreshError::from_app_error)
        })
        .await
        .map_err(SharedRefreshError::into_app_error)
}

async fn refresh_single_feature(state: &AppState, feature_id: i64) -> Result<(), AppError> {
    let active: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM features WHERE id = ? AND status = 'active'")
            .bind(feature_id)
            .fetch_optional(&state.read_pool)
            .await?;
    if active.is_none() {
        return Ok(());
    }
    let target = resolve_feature_target(state, feature_id).await;
    if let Some(snapshot) = target_without_repo_snapshot(&target) {
        publish(state, snapshot).await;
        return Ok(());
    }
    let configs = host_configs()?;
    let group = build_single_group(target, &configs);
    refresh_group(state, &group).await;
    state.forge_status.bump_schedule_generation();
    Ok(())
}

/// Re-poll every repo now, ahead of the next tick. Requests coalesce: those
/// made while a requested poll runs share one follow-up poll, which resolves
/// the branches after them.
pub fn request_refresh(state: &AppState) {
    if !state.forge_status.forced.request() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        let worker = ForcedWorker(&state);
        while state.forge_status.forced.take() {
            if let Err(error) = refresh_all(&state).await {
                warn!(%error, "requested forge PR status refresh failed");
            }
        }
        // Drained normally: `take` already let the next request start a new
        // worker, which the guard must not mark stopped.
        std::mem::forget(worker);
    });
}

/// Releases the forced-refresh queue if its worker unwinds.
struct ForcedWorker<'a>(&'a AppState);

impl Drop for ForcedWorker<'_> {
    fn drop(&mut self) {
        if self.0.forge_status.forced.abandon() {
            request_refresh(self.0);
        }
    }
}

async fn refresh(
    state: &AppState,
    force: bool,
    schedule: Option<&mut PollSchedule>,
) -> Result<(), AppError> {
    refresh_with_hooks(
        state,
        force,
        schedule,
        || has_any_configured_auth(state),
        active_feature_targets,
    )
    .await
}

async fn refresh_with_hooks<'a, A, FutA, F, Fut>(
    state: &'a AppState,
    force: bool,
    mut schedule: Option<&mut PollSchedule>,
    has_auth: A,
    load_targets: F,
) -> Result<(), AppError>
where
    A: FnOnce() -> FutA,
    FutA: Future<Output = bool>,
    F: FnOnce(&'a AppState) -> Fut,
    Fut: Future<Output = Result<Vec<FeatureForgeTarget>, AppError>>,
{
    if !force {
        if !state.forge_activity.has_visible_clients().await {
            return Ok(());
        }
        if let Some(sched) = schedule.as_deref_mut() {
            if should_skip_periodic_tick(state, sched, has_auth).await {
                return Ok(());
            }
        }
    }

    // Branches and remotes come from Git, run before taking the poll lock: a
    // repository whose Git hangs must not hold up the polls queued behind it.
    let ticket = state
        .forge_status
        .resolve_tickets
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let targets = load_targets(state).await?;
    let mut newest_published = state.forge_status.refresh_lock.lock().await;
    if !force && ticket < *newest_published {
        return Ok(());
    }
    *newest_published = (*newest_published).max(ticket);

    let active_ids = targets
        .iter()
        .map(|target| target.feature_id)
        .collect::<HashSet<_>>();
    let configs = host_configs()?;
    let groups = group_targets(state, targets, &configs).await;

    let mut due = Vec::new();
    let mut skipped = Vec::new();
    let mut active_keys = HashSet::with_capacity(groups.len());
    for group in groups.into_values() {
        active_keys.insert(group.key.clone());
        let poll_now = match schedule.as_deref() {
            Some(sched) if !force => should_poll(state, &group, false, &sched.last_polled).await,
            _ => true,
        };
        if poll_now {
            if let Some(sched) = schedule.as_deref_mut() {
                sched.last_polled.insert(group.key.clone(), Instant::now());
            }
            due.push(group);
        } else {
            skipped.push(group);
        }
    }
    if let Some(sched) = schedule.as_deref_mut() {
        sched.last_polled.retain(|key, _| active_keys.contains(key));
    }

    let polled_groups = stream::iter(due)
        .map(|group| async move {
            refresh_group(state, &group).await;
            group
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;

    state.forge_status.retain_features(&active_ids).await;
    if let Some(sched) = schedule {
        sched.next_due_at = compute_next_due(
            state,
            polled_groups.iter().chain(skipped.iter()),
            &sched.last_polled,
        )
        .await;
        sched.seen_generation = state.forge_status.schedule_generation();
        sched.has_swept = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use std::time::Duration;

    use super::schedule::POLL_INTERVAL;
    use super::*;
    use crate::domain::git::forge::ForgeAuthStore;

    async fn test_state_with_auth(token: Option<&str>) -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE features (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO features (id, status) VALUES (1, 'active')")
            .execute(&pool)
            .await
            .unwrap();
        let mut state = AppState::with_pool(pool);
        let store = ForgeAuthStore::new(dir.path().join("forge/tokens.json"));
        if let Some(token) = token {
            store.save("other.example", token, None).await.unwrap();
        }
        state.forge_auth = Arc::new(store);
        state.forge_activity.register("client-1".into(), true).await;
        (dir, state)
    }

    fn unconfigured_target(feature_id: i64, host: GitHost) -> FeatureForgeTarget {
        FeatureForgeTarget {
            feature_id,
            branch: Some("feature/x".into()),
            tracked: vec![TrackedBranch {
                name: "feature/x".into(),
                linked: true,
                stored_pr: None,
            }],
            remote: Some(RemoteInfo {
                host,
                hostname: "git.example.test".into(),
                web_base: "https://git.example.test/acme/demo".into(),
                owner: "acme".into(),
                repo: "demo".into(),
            }),
            error: None,
        }
    }

    #[tokio::test]
    async fn non_forced_tick_skips_active_feature_targets_when_no_repo_is_due() {
        let (_dir, state) = test_state_with_auth(Some("dummy-token")).await;
        let mut schedule = PollSchedule::default();
        let loads = Arc::new(AtomicUsize::new(0));

        refresh_with_hooks(&state, false, Some(&mut schedule), || async { true }, {
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(vec![unconfigured_target(1, GitHost::Other)])
            }
        })
        .await
        .unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(schedule.has_swept);
        assert!(schedule.next_due_at.is_some());

        // Fast-path skips before calling `has_auth` or `load_targets`.
        let auth_checks = Arc::new(AtomicUsize::new(0));
        refresh_with_hooks(
            &state,
            false,
            Some(&mut schedule),
            {
                let auth_checks = Arc::clone(&auth_checks);
                move || async move {
                    auth_checks.fetch_add(1, Ordering::SeqCst);
                    true
                }
            },
            {
                let loads = Arc::clone(&loads);
                move |_| async move {
                    loads.fetch_add(1, Ordering::SeqCst);
                    Ok(vec![unconfigured_target(1, GitHost::Other)])
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert_eq!(
            auth_checks.load(Ordering::SeqCst),
            0,
            "next_due_at must short-circuit before has_any_configured_auth"
        );

        // Forced refresh invalidates the periodic schedule's next_due_at via generation.
        refresh_with_hooks(&state, true, None, || async { true }, {
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(vec![unconfigured_target(1, GitHost::Other)])
            }
        })
        .await
        .unwrap();
        state.forge_status.bump_schedule_generation();
        assert_eq!(loads.load(Ordering::SeqCst), 2);

        refresh_with_hooks(&state, false, Some(&mut schedule), || async { true }, {
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(vec![unconfigured_target(1, GitHost::Other)])
            }
        })
        .await
        .unwrap();
        assert_eq!(
            loads.load(Ordering::SeqCst),
            3,
            "forced refresh must clear periodic next_due_at so the next tick re-evaluates"
        );
    }

    #[tokio::test]
    async fn unauthenticated_ticks_skip_when_unchanged_and_sweep_on_feature_changes() {
        let (_dir, state) = test_state_with_auth(None).await;
        let mut schedule = PollSchedule::default();
        let loads = Arc::new(AtomicUsize::new(0));

        refresh_with_hooks(&state, false, Some(&mut schedule), || async { false }, {
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(vec![unconfigured_target(1, GitHost::Other)])
            }
        })
        .await
        .unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 1);

        // Unchanged active feature set skips full target resolution and pushes next_due_at out.
        schedule.next_due_at = Some(Instant::now() - Duration::from_secs(5));
        refresh_with_hooks(&state, false, Some(&mut schedule), || async { false }, {
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(vec![unconfigured_target(1, GitHost::Other)])
            }
        })
        .await
        .unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(
            schedule.next_due_at.unwrap() > Instant::now() + Duration::from_secs(30),
            "unauthenticated skip must defer the next check by POLL_INTERVAL"
        );

        // Creating a new active feature triggers a sweep so it receives setup_required.
        sqlx::query("INSERT INTO features (id, status) VALUES (2, 'active')")
            .execute(&state.read_pool)
            .await
            .unwrap();
        schedule.next_due_at = Some(Instant::now() - Duration::from_secs(5));
        refresh_with_hooks(&state, false, Some(&mut schedule), || async { false }, {
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(vec![
                    unconfigured_target(1, GitHost::Other),
                    unconfigured_target(2, GitHost::Other),
                ])
            }
        })
        .await
        .unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 2);
        assert!(state.forge_status.get(2).await.is_some());

        // Archiving a feature triggers a sweep so its stale snapshot is pruned.
        sqlx::query("UPDATE features SET status = 'archived' WHERE id = 2")
            .execute(&state.read_pool)
            .await
            .unwrap();
        schedule.next_due_at = Some(Instant::now() - Duration::from_secs(5));
        refresh_with_hooks(&state, false, Some(&mut schedule), || async { false }, {
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(vec![unconfigured_target(1, GitHost::Other)])
            }
        })
        .await
        .unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 3);
        assert!(state.forge_status.get(2).await.is_none());
    }

    #[tokio::test]
    async fn bitbucket_only_schedule_caps_next_due_at_poll_interval() {
        let (_dir, state) = test_state_with_auth(Some("dummy-token")).await;
        let mut schedule = PollSchedule::default();

        refresh_with_hooks(
            &state,
            false,
            Some(&mut schedule),
            || async { true },
            |_| async { Ok(vec![unconfigured_target(1, GitHost::Bitbucket)]) },
        )
        .await
        .unwrap();

        let remaining = schedule
            .next_due_at
            .expect("next_due_at set")
            .saturating_duration_since(Instant::now());
        assert!(
            remaining <= POLL_INTERVAL,
            "next_due_at must be capped at POLL_INTERVAL (60s), got {remaining:?}"
        );
    }
}
