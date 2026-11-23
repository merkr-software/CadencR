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

use self::group::{
    build_single_group, group_targets, poll_group, publish_all, Publication, PR_FANOUT,
};
use self::schedule::{
    compute_next_due, has_any_configured_auth, should_poll, should_skip_periodic_tick,
    PollSchedule, RUNNING_CI_POLL_INTERVAL,
};
use self::targets::target_without_repo_snapshot;
use super::auth::host_configs;
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
        .run((), || refresh_all(state))
        .await
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
        .run(feature_id, || {
            refresh_single_feature(state, feature_id, stale_ms)
        })
        .await
}

/// Draw the ticket that orders this target resolution against the others.
fn resolve_ticket(state: &AppState) -> u64 {
    state
        .forge_status
        .resolve_tickets
        .fetch_add(1, Ordering::Relaxed)
        + 1
}

/// Poll one feature without waiting for a running sweep, then publish in
/// order with full polls: a periodic poll that resolved its branches earlier
/// cannot publish over it, and it does not publish over a poll that resolved
/// later and covered it.
async fn refresh_single_feature(
    state: &AppState,
    feature_id: i64,
    stale_ms: i64,
) -> Result<(), AppError> {
    let active: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM features WHERE id = ? AND status = 'active'")
            .bind(feature_id)
            .fetch_optional(&state.read_pool)
            .await?;
    if active.is_none() {
        return Ok(());
    }
    let ticket = resolve_ticket(state);
    let target = resolve_feature_target(state, feature_id).await;
    let publications = match target_without_repo_snapshot(&target) {
        Some(snapshot) => vec![Publication::unpolled(snapshot)],
        None => poll_group(state, &build_single_group(target, &host_configs()?)).await,
    };
    let mut order = state.forge_status.publish_order.lock().await;
    let fresh = state.forge_status.is_fresh(feature_id, stale_ms).await;
    if !order.admit_feature(feature_id, ticket, fresh) {
        return Ok(());
    }
    publish_all(state, publications).await;
    drop(order);
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
    FutA: Future<Output = Result<bool, AppError>>,
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

    // Stamped before resolving targets: a slow Git resolution must not push
    // the next poll of a running CI past the following tick.
    let started = Instant::now();
    // Branches and remotes come from Git, run before taking the poll lock: a
    // repository whose Git hangs must not hold up the polls queued behind it.
    let ticket = resolve_ticket(state);
    let targets = load_targets(state).await?;
    let _sweep = state.forge_status.sweep_lock.lock().await;
    if !state
        .forge_status
        .publish_order
        .lock()
        .await
        .admit_sweep(ticket, force)
    {
        return Ok(());
    }
    let active_ids = targets
        .iter()
        .map(|target| target.feature_id)
        .collect::<HashSet<_>>();
    let (groups, mut publications) = group_targets(targets, &host_configs()?);

    let mut due = Vec::new();
    let mut skipped = Vec::new();
    let mut active_keys = HashSet::with_capacity(groups.len());
    for group in groups.into_values() {
        active_keys.insert(group.key.clone());
        let poll_now = match schedule.as_deref() {
            Some(sched) if !force => should_poll(state, &group, &sched.last_polled).await,
            _ => true,
        };
        if poll_now {
            if let Some(sched) = schedule.as_deref_mut() {
                sched.last_polled.insert(group.key.clone(), started);
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
            let polled = poll_group(state, &group).await;
            (group, polled)
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    let polled_groups = polled_groups
        .into_iter()
        .map(|(group, polled)| {
            publications.extend(polled);
            group
        })
        .collect::<Vec<_>>();
    publish_sweep(state, ticket, publications, active_ids).await;

    if let Some(sched) = schedule {
        sched.next_due_at = compute_next_due(
            state,
            polled_groups.iter().chain(skipped.iter()),
            &sched.last_polled,
        )
        .await;
        sched.finish_sweep(started, state.forge_status.schedule_generation());
    }
    Ok(())
}

/// Publish a full poll's snapshots, except for features a per-feature
/// refresh resolved after this poll and already published, and prune the
/// features that are gone. Those newer features stay: this poll listed the
/// active features before they were refreshed.
async fn publish_sweep(
    state: &AppState,
    ticket: u64,
    mut publications: Vec<Publication>,
    mut active_ids: HashSet<i64>,
) {
    let mut order = state.forge_status.publish_order.lock().await;
    let newer = order.newer_features(ticket);
    publications.retain(|publication| !newer.contains(&publication.snapshot.feature_id));
    publish_all(state, publications).await;
    active_ids.extend(newer);
    state.forge_status.retain_features(&active_ids).await;
    order.finish_sweep(ticket);
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use std::time::Duration;

    use super::schedule::POLL_INTERVAL;
    use super::*;
    use crate::domain::git::forge::provider::PrStatusSnapshot;
    use crate::domain::git::forge::repository::failed_target;
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

        tick(
            &state,
            &mut schedule,
            true,
            &loads,
            vec![unconfigured_target(1, GitHost::Other)],
        )
        .await;
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(schedule.last_sweep_at.is_some());
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
                    Ok(true)
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
        refresh_with_hooks(&state, true, None, || async { Ok(true) }, {
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

        tick(
            &state,
            &mut schedule,
            true,
            &loads,
            vec![unconfigured_target(1, GitHost::Other)],
        )
        .await;
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

        tick(
            &state,
            &mut schedule,
            false,
            &loads,
            vec![unconfigured_target(1, GitHost::Other)],
        )
        .await;
        assert_eq!(loads.load(Ordering::SeqCst), 1);

        // Unchanged active feature set skips full target resolution and pushes next_due_at out.
        schedule.next_due_at = Some(Instant::now() - Duration::from_secs(5));
        tick(
            &state,
            &mut schedule,
            false,
            &loads,
            vec![unconfigured_target(1, GitHost::Other)],
        )
        .await;
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
        tick(
            &state,
            &mut schedule,
            false,
            &loads,
            vec![
                unconfigured_target(1, GitHost::Other),
                unconfigured_target(2, GitHost::Other),
            ],
        )
        .await;
        assert_eq!(loads.load(Ordering::SeqCst), 2);
        assert!(state.forge_status.get(2).await.is_some());

        // Archiving a feature triggers a sweep so its stale snapshot is pruned.
        sqlx::query("UPDATE features SET status = 'archived' WHERE id = 2")
            .execute(&state.read_pool)
            .await
            .unwrap();
        schedule.next_due_at = Some(Instant::now() - Duration::from_secs(5));
        tick(
            &state,
            &mut schedule,
            false,
            &loads,
            vec![unconfigured_target(1, GitHost::Other)],
        )
        .await;
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
            || async { Ok(true) },
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

    async fn tick(
        state: &AppState,
        schedule: &mut PollSchedule,
        auth: bool,
        loads: &Arc<AtomicUsize>,
        targets: Vec<FeatureForgeTarget>,
    ) {
        let loads = Arc::clone(loads);
        refresh_with_hooks(
            state,
            false,
            Some(schedule),
            move || async move { Ok(auth) },
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(targets)
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn losing_the_last_credential_republishes_snapshots_instead_of_freezing_them() {
        let (_dir, state) = test_state_with_auth(Some("dummy-token")).await;
        let mut schedule = PollSchedule::default();
        let loads = Arc::new(AtomicUsize::new(0));
        let targets = || vec![unconfigured_target(1, GitHost::Other)];

        tick(&state, &mut schedule, true, &loads, targets()).await;
        assert_eq!(loads.load(Ordering::SeqCst), 1);

        // The token is deleted: the snapshots polled with it must be replaced.
        schedule.next_due_at = Some(Instant::now() - Duration::from_secs(5));
        tick(&state, &mut schedule, false, &loads, targets()).await;
        assert_eq!(
            loads.load(Ordering::SeqCst),
            2,
            "first unauthenticated tick after an authenticated sweep must sweep"
        );

        // Settled: nothing new to say without credentials.
        schedule.next_due_at = Some(Instant::now() - Duration::from_secs(5));
        tick(&state, &mut schedule, false, &loads, targets()).await;
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn auth_read_failures_sweep_instead_of_skipping() {
        let (_dir, state) = test_state_with_auth(None).await;
        let mut schedule = PollSchedule::default();
        let loads = Arc::new(AtomicUsize::new(0));
        tick(&state, &mut schedule, false, &loads, vec![]).await;
        tick(
            &state,
            &mut schedule,
            false,
            &loads,
            vec![unconfigured_target(1, GitHost::Other)],
        )
        .await;
        assert_eq!(loads.load(Ordering::SeqCst), 2);

        schedule.next_due_at = Some(Instant::now() - Duration::from_secs(5));
        let loads_in_hook = Arc::clone(&loads);
        refresh_with_hooks(
            &state,
            false,
            Some(&mut schedule),
            || async { Err(AppError::internal("tokens.json unreadable")) },
            move |_| async move {
                loads_in_hook.fetch_add(1, Ordering::SeqCst);
                Ok(vec![unconfigured_target(1, GitHost::Other)])
            },
        )
        .await
        .unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_new_feature_is_swept_on_the_next_tick_even_before_any_repo_is_due() {
        let (_dir, state) = test_state_with_auth(Some("dummy-token")).await;
        let mut schedule = PollSchedule::default();
        let loads = Arc::new(AtomicUsize::new(0));
        tick(
            &state,
            &mut schedule,
            true,
            &loads,
            vec![unconfigured_target(1, GitHost::Other)],
        )
        .await;
        assert!(schedule.next_due_at.unwrap() > Instant::now() + Duration::from_secs(30));

        sqlx::query("INSERT INTO features (id, status) VALUES (2, 'active')")
            .execute(&state.read_pool)
            .await
            .unwrap();
        tick(
            &state,
            &mut schedule,
            true,
            &loads,
            vec![
                unconfigured_target(1, GitHost::Other),
                unconfigured_target(2, GitHost::Other),
            ],
        )
        .await;
        assert_eq!(loads.load(Ordering::SeqCst), 2);
        assert!(state.forge_status.contains(2).await);
    }

    #[tokio::test]
    async fn repo_groups_are_stamped_when_the_tick_starts_not_after_resolution() {
        let (_dir, state) = test_state_with_auth(Some("dummy-token")).await;
        let mut schedule = PollSchedule::default();
        let before = Instant::now();
        refresh_with_hooks(
            &state,
            false,
            Some(&mut schedule),
            || async { Ok(true) },
            |_| async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                Ok(vec![unconfigured_target(1, GitHost::GitHub)])
            },
        )
        .await
        .unwrap();
        let stamped = *schedule.last_polled.values().next().expect("group polled");
        assert!(
            stamped < before + Duration::from_millis(250),
            "slow target resolution must not delay the group's next due time"
        );
    }

    #[tokio::test]
    async fn a_periodic_poll_cannot_publish_over_a_newer_feature_refresh() {
        let (_dir, state) = test_state_with_auth(Some("dummy-token")).await;
        let mut schedule = PollSchedule::default();
        let newer = PrStatusSnapshot::unpolled(1, Some("from branch B".into()), false);
        let published = newer.clone();
        refresh_with_hooks(
            &state,
            false,
            Some(&mut schedule),
            || async { Ok(true) },
            |state: &AppState| async move {
                // A per-feature refresh resolves after this poll drew its
                // ticket and publishes first.
                let ticket = resolve_ticket(state);
                let mut order = state.forge_status.publish_order.lock().await;
                assert!(order.admit_feature(1, ticket, false));
                publish_all(state, vec![Publication::unpolled(published)]).await;
                drop(order);
                Ok(vec![failed_target(1, "from branch A")])
            },
        )
        .await
        .unwrap();
        let current = state.forge_status.get(1).await.unwrap();
        assert!(
            current.semantic_eq(&newer),
            "older poll overwrote a newer view"
        );
    }

    #[tokio::test]
    async fn an_older_sweep_keeps_a_feature_refreshed_after_it() {
        let (_dir, state) = test_state_with_auth(Some("dummy-token")).await;
        refresh_with_hooks(
            &state,
            true,
            None,
            || async { Ok(true) },
            |state: &AppState| async move {
                // Feature 2 is created and refreshed after this poll listed
                // the active features.
                let ticket = resolve_ticket(state);
                let mut order = state.forge_status.publish_order.lock().await;
                assert!(order.admit_feature(2, ticket, false));
                let snapshot = PrStatusSnapshot::unpolled(2, None, false);
                publish_all(state, vec![Publication::unpolled(snapshot)]).await;
                drop(order);
                Ok(vec![failed_target(1, "listed")])
            },
        )
        .await
        .unwrap();
        assert!(state.forge_status.contains(1).await);
        assert!(
            state.forge_status.contains(2).await,
            "the poll pruned a feature it never saw"
        );
    }

    #[tokio::test]
    async fn a_feature_refresh_does_not_wait_for_a_running_sweep() {
        let (_dir, state) = test_state_with_auth(Some("dummy-token")).await;
        // A sweep is busy with slow forges.
        let _sweep = state.forge_status.sweep_lock.lock().await;
        tokio::time::timeout(
            Duration::from_secs(5),
            refresh_single_feature(&state, 1, 60_000),
        )
        .await
        .expect("per-feature refresh must not queue behind the sweep")
        .unwrap();
        assert!(state.forge_status.contains(1).await);
    }

    #[tokio::test]
    async fn losing_credentials_makes_every_repo_due_not_just_the_due_ones() {
        let (_dir, state) = test_state_with_auth(Some("dummy-token")).await;
        let mut schedule = PollSchedule::default();
        let loads = Arc::new(AtomicUsize::new(0));
        let mut other_repo = unconfigured_target(2, GitHost::Other);
        if let Some(remote) = other_repo.remote.as_mut() {
            remote.repo = "other".into();
        }
        let targets = || vec![unconfigured_target(1, GitHost::Other), other_repo.clone()];
        sqlx::query("INSERT INTO features (id, status) VALUES (2, 'active')")
            .execute(&state.read_pool)
            .await
            .unwrap();
        tick(&state, &mut schedule, true, &loads, targets()).await;
        assert_eq!(schedule.last_polled.len(), 2);

        // Only one of the two groups has come due when the token goes away.
        let stale = Instant::now() - POLL_INTERVAL - Duration::from_secs(1);
        let first = schedule.last_polled.keys().next().unwrap().clone();
        schedule.last_polled.insert(first, stale);
        schedule.next_due_at = Some(stale);
        let before = Instant::now();
        tick(&state, &mut schedule, false, &loads, targets()).await;

        assert_eq!(loads.load(Ordering::SeqCst), 2);
        assert!(
            schedule
                .last_polled
                .values()
                .all(|polled| *polled >= before),
            "a group polled with the old credentials kept its snapshot"
        );
    }
}
