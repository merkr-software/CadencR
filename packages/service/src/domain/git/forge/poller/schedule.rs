//! Periodic forge poll scheduling, interval selection, and fast-path skip
//! checks.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::{Duration, Instant};

use tracing::warn;

use super::super::auth::{forge_to_app_error, host_configs};
use super::{RepoGroup, RepoKey};
use crate::app_state::AppState;
use crate::domain::git::host::GitHost;
use crate::error::AppError;

pub(super) const POLL_INTERVAL: Duration = Duration::from_secs(60);
pub(super) const RUNNING_CI_POLL_INTERVAL: Duration = Duration::from_secs(30);
const BITBUCKET_POLL_INTERVAL: Duration = Duration::from_secs(120);
/// Without any credentials there is nothing to fetch, so unchanged features
/// are re-resolved this rarely: often enough that a remote added meanwhile
/// still gets its "connect your forge" prompt.
const UNAUTHENTICATED_SWEEP_INTERVAL: Duration = Duration::from_secs(300);
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
    /// Whether any forge credentials were configured for the last completed
    /// sweep (`None` when that could not be read). Snapshots published with
    /// credentials must be replaced once they are gone, so only a sweep that
    /// itself ran without them lets later ticks skip.
    pub(super) swept_with_auth: Option<bool>,
    /// The credential state seen by the tick that started the running sweep.
    pub(super) pending_auth: Option<bool>,
    /// When the last periodic sweep started; `None` until one has run, so
    /// the initial unauthenticated setup snapshots are always published.
    pub(super) last_sweep_at: Option<Instant>,
}

impl PollSchedule {
    /// Record a completed sweep that started at `started`.
    pub(super) fn finish_sweep(&mut self, started: Instant, generation: u64) {
        self.seen_generation = generation;
        self.swept_with_auth = self.pending_auth.take();
        self.last_sweep_at = Some(started);
    }
}

pub(super) async fn has_any_configured_auth(state: &AppState) -> Result<bool, AppError> {
    if state
        .forge_auth
        .has_any_stored_tokens()
        .await
        .map_err(forge_to_app_error)?
    {
        return Ok(true);
    }
    Ok(host_configs()?.values().any(|config| config.use_cli_auth))
}

async fn active_feature_ids_match_cache(state: &AppState) -> Result<bool, AppError> {
    let ids = sqlx::query_scalar::<_, i64>("SELECT id FROM features WHERE status = 'active'")
        .fetch_all(&state.read_pool)
        .await?;
    let active: HashSet<i64> = ids.into_iter().collect();
    Ok(state.forge_status.matches_feature_ids(&active).await)
}

/// Whether the published snapshots still cover exactly the active features.
/// A read failure counts as "changed": the sweep it triggers resolves the
/// features again and reports the failure from there.
async fn feature_set_unchanged(state: &AppState) -> bool {
    match active_feature_ids_match_cache(state).await {
        Ok(unchanged) => unchanged,
        Err(error) => {
            warn!(%error, "could not compare active features with forge snapshots; sweeping");
            false
        }
    }
}

pub(super) async fn should_skip_periodic_tick<A, FutA>(
    state: &AppState,
    schedule: &mut PollSchedule,
    has_auth: A,
) -> bool
where
    A: FnOnce() -> FutA,
    FutA: Future<Output = Result<bool, AppError>>,
{
    let current_generation = state.forge_status.schedule_generation();
    if schedule.seen_generation != current_generation {
        schedule.next_due_at = None;
        schedule.seen_generation = current_generation;
    }
    if schedule.last_sweep_at.is_none() {
        schedule.pending_auth = read_auth(has_auth).await;
        return false;
    }
    let not_due = schedule
        .next_due_at
        .is_some_and(|due| due.saturating_duration_since(Instant::now()) > SCHEDULE_LEEWAY);
    // A created or archived feature is news on the next tick, not when the
    // slowest repo group comes due.
    let mut unchanged = None;
    if not_due {
        let same = feature_set_unchanged(state).await;
        if same {
            return true;
        }
        unchanged = Some(same);
    }
    let auth = read_auth(has_auth).await;
    schedule.pending_auth = auth;
    if auth != schedule.swept_with_auth {
        // Credentials appeared or went away: every snapshot published under
        // the previous state is due, not just the groups whose interval ran.
        schedule.last_polled.clear();
    }
    let unauthenticated_and_settled = auth == Some(false)
        && schedule.swept_with_auth == Some(false)
        && schedule
            .last_sweep_at
            .is_some_and(|last| last.elapsed() < UNAUTHENTICATED_SWEEP_INTERVAL);
    if !unauthenticated_and_settled {
        return false;
    }
    let unchanged = match unchanged {
        Some(unchanged) => unchanged,
        None => feature_set_unchanged(state).await,
    };
    if unchanged {
        schedule.next_due_at = Some(Instant::now() + POLL_INTERVAL);
    }
    unchanged
}

/// `None` when the credential state could not be read; the sweep then runs
/// and reports the failure on each feature's snapshot.
async fn read_auth<A, FutA>(has_auth: A) -> Option<bool>
where
    A: FnOnce() -> FutA,
    FutA: Future<Output = Result<bool, AppError>>,
{
    match has_auth().await {
        Ok(auth) => Some(auth),
        Err(error) => {
            warn!(%error, "could not read forge credentials; sweeping");
            None
        }
    }
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
    last_polled: &HashMap<RepoKey, Instant>,
) -> bool {
    for feature in &group.features {
        if !state.forge_status.contains(feature.feature_id).await {
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
    for feature in &group.features {
        if state.forge_status.has_running_ci(feature.feature_id).await {
            return RUNNING_CI_POLL_INTERVAL;
        }
    }
    POLL_INTERVAL
}
