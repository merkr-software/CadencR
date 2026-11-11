use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use futures::{stream, StreamExt};
use tracing::{info, warn};

mod assemble;
mod matching;
mod targets;
mod unresolved_threads;

use self::assemble::{feature_snapshot, persist_prs, PolledPrs};
use self::matching::{matched_prs, restore_known_prs};
use self::targets::target_without_repo_snapshot;
use self::unresolved_threads::unresolved_thread_counts;
use super::auth::{host_configs, resolve_credentials};
use super::provider::{
    CiRollup, ForgeContext, ForgeError, ForgeHostConfig, PrState, PrStatusSnapshot,
};
use super::repository::{active_feature_targets, TrackedBranch};
use super::{api_base_url, effective_kind, provider_for};
use crate::app_state::AppState;
use crate::domain::git::host::{GitHost, RemoteInfo};
use crate::error::AppError;

const POLL_INTERVAL: Duration = Duration::from_secs(60);
const RUNNING_CI_POLL_INTERVAL: Duration = Duration::from_secs(30);
const BITBUCKET_POLL_INTERVAL: Duration = Duration::from_secs(120);
/// How many per-PR forge lookups a single repo group runs at once.
const PR_FANOUT: usize = 4;

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
        let mut last_polled = HashMap::new();
        loop {
            ticker.tick().await;
            if let Err(error) = refresh(&state, false, &mut last_polled).await {
                warn!(%error, "forge PR status refresh failed");
            }
        }
    });
}

pub async fn refresh_all(state: &AppState) -> Result<(), AppError> {
    let mut last_polled = HashMap::new();
    refresh(state, true, &mut last_polled).await
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
    last_polled: &mut HashMap<RepoKey, Instant>,
) -> Result<(), AppError> {
    if !force && !state.forge_activity.has_visible_clients().await {
        return Ok(());
    }
    // Branches and remotes come from Git, run before taking the poll lock: a
    // repository whose Git hangs must not hold up the polls queued behind it.
    let ticket = state
        .forge_status
        .resolve_tickets
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let targets = active_feature_targets(state).await?;
    let mut newest_published = state.forge_status.refresh_lock.lock().await;
    // A forced poll covers every repo; a periodic one only those due, so only
    // a periodic poll whose branches are older than the last published view
    // is dropped (the next tick polls again).
    if !force && ticket < *newest_published {
        return Ok(());
    }
    *newest_published = (*newest_published).max(ticket);
    let active_ids = targets
        .iter()
        .map(|target| target.feature_id)
        .collect::<HashSet<_>>();
    let configs = host_configs()?;
    let mut groups = HashMap::<RepoKey, RepoGroup>::new();

    for target in targets {
        if let Some(snapshot) = target_without_repo_snapshot(&target) {
            publish(state, snapshot).await;
            continue;
        }
        let remote = target.remote.expect("target checked above");
        let config = configs.get(&remote.hostname).cloned();
        let kind = effective_kind(remote.host, config.as_ref());
        let api = api_base_url(&remote.hostname, kind, config.as_ref())
            .ok()
            .flatten()
            .unwrap_or_default();
        let key = RepoKey {
            hostname: remote.hostname.clone(),
            api_base_url: api,
            owner: remote.owner.clone(),
            repo: remote.repo.clone(),
            kind,
        };
        groups
            .entry(key.clone())
            .or_insert_with(|| RepoGroup {
                key,
                remote,
                kind,
                config,
                features: Vec::new(),
            })
            .features
            .push(GroupFeature {
                feature_id: target.feature_id,
                tracked: target.tracked,
            });
    }

    let mut due = Vec::new();
    for group in groups.into_values() {
        if !should_poll(state, &group, force, last_polled).await {
            continue;
        }
        last_polled.insert(group.key.clone(), Instant::now());
        due.push(group);
    }
    stream::iter(due)
        .for_each_concurrent(4, |group| refresh_group(state, group))
        .await;
    state.forge_status.retain_features(&active_ids).await;
    Ok(())
}

async fn should_poll(
    state: &AppState,
    group: &RepoGroup,
    force: bool,
    last_polled: &HashMap<RepoKey, Instant>,
) -> bool {
    if force {
        return true;
    }
    let interval = poll_interval(state, group).await;
    last_polled
        .get(&group.key)
        .is_none_or(|last| last.elapsed() >= interval)
}

async fn poll_interval(state: &AppState, group: &RepoGroup) -> Duration {
    if group.kind == GitHost::Bitbucket {
        return BITBUCKET_POLL_INTERVAL;
    }
    let running =
        |ci: Option<&CiRollup>| ci.is_some_and(|ci| ci.state == super::provider::CiState::Running);
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

async fn refresh_group(state: &AppState, group: RepoGroup) {
    let hostname = &group.remote.hostname;
    let Some(provider) = provider_for(group.kind) else {
        publish_group_error(
            state,
            &group,
            &ForgeError::Configuration(format!(
                "Choose which provider {hostname} runs so Cadencr knows which API to call."
            )),
        )
        .await;
        return;
    };
    let api_base_url = match api_base_url(hostname, group.kind, group.config.as_ref()) {
        Ok(Some(url)) => url,
        Ok(None) => {
            publish_group_error(
                state,
                &group,
                &ForgeError::Configuration(format!(
                    "Set an API base URL for {hostname} before Cadencr can reach its API."
                )),
            )
            .await;
            return;
        }
        Err(error) => {
            publish_group_error(state, &group, &error).await;
            return;
        }
    };
    let credentials = match resolve_credentials(
        &state.forge_auth,
        hostname,
        group.kind,
        group.config.as_ref(),
    )
    .await
    {
        Ok(Some(credentials)) => credentials,
        Ok(None) => {
            publish_group_error(
                state,
                &group,
                &ForgeError::Authentication(format!(
                    "Add an API token for {hostname} to load pull requests, checks, and comments."
                )),
            )
            .await;
            return;
        }
        Err(error) => {
            publish_group_error(state, &group, &error).await;
            return;
        }
    };
    let context = ForgeContext {
        remote: group.remote.clone(),
        api_base_url,
        credentials,
        http: state.forge_http.clone(),
    };
    let prs = match provider.list_open_prs(&context).await {
        Ok(prs) => prs,
        Err(error) => {
            // The first real call is where an expired or wrongly-scoped token
            // surfaces, so this arm carries onboarding failures too.
            publish_group_error(state, &group, &error).await;
            return;
        }
    };
    let mut matches = matched_prs(&group, &prs);
    let detail_errors = restore_known_prs(state, &group, provider, &context, &mut matches).await;
    let unique_prs = matches
        .values()
        .flatten()
        .filter(|pr| matches!(pr.state, PrState::Open | PrState::Draft))
        .map(|pr| (pr.number, pr.clone()))
        .collect::<HashMap<_, _>>();
    let ci_by_pr = stream::iter(unique_prs.values().cloned())
        .map(|pr| {
            let context = &context;
            async move {
                let number = pr.number;
                (number, provider.ci_rollup(context, &pr).await)
            }
        })
        .buffer_unordered(PR_FANOUT)
        .collect::<HashMap<u64, Result<CiRollup, ForgeError>>>()
        .await;
    let unresolved_by_pr =
        unresolved_thread_counts(provider, &context, &unique_prs, &ci_by_pr).await;
    persist_prs(state, &group, &matches).await;
    let polled = PolledPrs {
        matches: &matches,
        ci_by_pr: &ci_by_pr,
        unresolved_by_pr: &unresolved_by_pr,
        fetched_at: chrono::Utc::now().timestamp_millis(),
    };
    for feature in &group.features {
        let error = detail_errors.get(&feature.feature_id).cloned();
        let current = feature.tracked.first().map(|branch| branch.name.as_str());
        state
            .forge_status
            .set_current_branch(feature.feature_id, current)
            .await;
        publish(state, feature_snapshot(feature, &polled, error)).await;
    }
}

/// Report one group-wide failure against every feature in the group.
///
/// Takes the `ForgeError` rather than a message plus a flag: whether the user
/// can fix this in Settings is a property of the error, and asking it here keeps
/// the answer from drifting between call sites.
async fn publish_group_error(state: &AppState, group: &RepoGroup, error: &ForgeError) {
    let setup_required = error.is_setup_failure();
    let detail = error.to_string();
    for feature in &group.features {
        publish(
            state,
            PrStatusSnapshot::unpolled(feature.feature_id, Some(detail.clone()), setup_required),
        )
        .await;
    }
}

async fn publish(state: &AppState, snapshot: PrStatusSnapshot) {
    if state.forge_status.upsert(snapshot.clone()).await {
        let _ = state.forge_events_tx.send(snapshot);
    }
}
