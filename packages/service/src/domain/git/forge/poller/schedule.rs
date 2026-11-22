//! Periodic forge poll scheduling, interval selection, and fast-path skip
//! checks.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::{Duration, Instant};

use super::super::auth::host_configs;
use super::super::provider::{CiRollup, CiState};
use super::{RepoGroup, RepoKey};
use crate::app_state::AppState;
use crate::domain::git::host::GitHost;

pub(super) const POLL_INTERVAL: Duration = Duration::from_secs(60);
pub(super) const RUNNING_CI_POLL_INTERVAL: Duration = Duration::from_secs(30);
const BITBUCKET_POLL_INTERVAL: Duration = Duration::from_secs(120);
/// Tolerance so a periodic tick firing slightly ahead of the computed due
/// instant (timer jitter) still polls instead of waiting another 30s tick.
const SCHEDULE_LEEWAY: Duration = Duration::from_secs(1);

#[derive(Default)]
pub(super) struct PollSchedule {
    pub(super) last_polled: HashMap<RepoKey, Instant>,
    /// Earliest instant at which any known repo group becomes due for a
    /// periodic poll.
    pub(super) next_due_at: Option<Instant>,
    /// Last `ForgeStatusCache::schedule_generation` observed by the periodic
    /// poller; a change invalidates `next_due_at`.
    pub(super) seen_generation: u64,
    /// True once at least one sweep has run (so initial unauthenticated setup
    /// snapshots are always published on startup).
    pub(super) has_swept: bool,
}

pub(super) async fn has_any_configured_auth(state: &AppState) -> bool {
    if state
        .forge_auth
        .has_any_stored_tokens()
        .await
        .unwrap_or(true)
    {
        return true;
    }
    host_configs().map_or(true, |configs| {
        configs.values().any(|config| config.use_cli_auth)
    })
}

async fn active_feature_ids_match_cache(state: &AppState) -> bool {
    let Ok(ids) = sqlx::query_scalar::<_, i64>("SELECT id FROM features WHERE status = 'active'")
        .fetch_all(&state.read_pool)
        .await
    else {
        return false;
    };
    let active: HashSet<i64> = ids.into_iter().collect();
    state.forge_status.matches_feature_ids(&active).await
}

pub(super) async fn should_skip_periodic_tick<A, FutA>(
    state: &AppState,
    schedule: &mut PollSchedule,
    has_auth: A,
) -> bool
where
    A: FnOnce() -> FutA,
    FutA: Future<Output = bool>,
{
    let current_generation = state.forge_status.schedule_generation();
    if schedule.seen_generation != current_generation {
        schedule.next_due_at = None;
        schedule.seen_generation = current_generation;
    }
    if !schedule.has_swept {
        return false;
    }
    if schedule
        .next_due_at
        .is_some_and(|due| due.saturating_duration_since(Instant::now()) > SCHEDULE_LEEWAY)
    {
        return true;
    }
    if !has_auth().await && active_feature_ids_match_cache(state).await {
        schedule.next_due_at = Some(Instant::now() + POLL_INTERVAL);
        return true;
    }
    false
}

pub(super) async fn compute_next_due<'a>(
    state: &AppState,
    groups: impl Iterator<Item = &'a RepoGroup>,
    last_polled: &HashMap<RepoKey, Instant>,
) -> Option<Instant> {
    let mut earliest: Option<Instant> = None;
    let now = Instant::now();
    let cap = now + POLL_INTERVAL;
    for group in groups {
        let interval = poll_interval(state, group).await;
        let last = last_polled.get(&group.key).copied().unwrap_or(now);
        let due = last + interval;
        earliest = Some(match earliest {
            Some(current) => current.min(due),
            None => due,
        });
    }
    Some(earliest.map_or(cap, |due| due.min(cap)))
}

pub(super) async fn should_poll(
    state: &AppState,
    group: &RepoGroup,
    force: bool,
    last_polled: &HashMap<RepoKey, Instant>,
) -> bool {
    if force {
        return true;
    }
    for feature in &group.features {
        if state.forge_status.get(feature.feature_id).await.is_none() {
            return true;
        }
    }
    let interval = poll_interval(state, group).await;
    last_polled
        .get(&group.key)
        .is_none_or(|last| last.elapsed() + SCHEDULE_LEEWAY >= interval)
}

async fn poll_interval(state: &AppState, group: &RepoGroup) -> Duration {
    if group.kind == GitHost::Bitbucket {
        return BITBUCKET_POLL_INTERVAL;
    }
    let running = |ci: Option<&CiRollup>| ci.is_some_and(|ci| ci.state == CiState::Running);
    for feature in &group.features {
        let Some(snapshot) = state.forge_status.get(feature.feature_id).await else {
            continue;
        };
        if running(snapshot.ci.as_ref())
            || snapshot
                .other_prs
                .iter()
                .any(|other| running(other.ci.as_ref()))
        {
            return RUNNING_CI_POLL_INTERVAL;
        }
    }
    POLL_INTERVAL
}
