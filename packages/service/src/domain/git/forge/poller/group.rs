//! Single repo-group polling and snapshot publication.
//!
//! Polling only computes [`Publication`]s; the caller publishes them while it
//! holds the publish-order lock, so forge network calls never run under it.

use std::collections::{BTreeMap, HashMap};

use futures::{stream, StreamExt};

use super::assemble::{feature_snapshot, persist_prs, PolledPrs};
use super::matching::{matched_prs, restore_known_prs};
use super::targets::target_without_repo_snapshot;
use super::unresolved_threads::unresolved_thread_counts;
use super::{GroupFeature, RepoGroup, RepoKey};
use crate::app_state::AppState;
use crate::domain::git::forge::auth::{invalidate_cli_token, resolve_credentials};
use crate::domain::git::forge::provider::{
    CiRollup, ForgeAuthSource, ForgeContext, ForgeError, ForgeHostConfig, ForgeProvider, PrState,
    PrStatusSnapshot,
};
use crate::domain::git::forge::repository::FeatureForgeTarget;
use crate::domain::git::forge::{api_base_url, effective_kind, provider_for};
use crate::shared::discard::IgnoreClosed;

/// How many per-PR forge lookups a single repo group runs at once.
pub(super) const PR_FANOUT: usize = 4;

/// A snapshot to publish, and the branch it describes as the feature's
/// current one when it comes from a poll.
pub(super) struct Publication {
    pub(super) snapshot: PrStatusSnapshot,
    current_branch: Option<Option<String>>,
}

impl Publication {
    /// A snapshot that did not come from polling the forge (no remote, a
    /// setup or transient error): the noted current branch stays as it is.
    pub(super) fn unpolled(snapshot: PrStatusSnapshot) -> Self {
        Self {
            snapshot,
            current_branch: None,
        }
    }
}

/// Group pollable targets by repository; the others already have their
/// snapshot.
pub(super) fn group_targets(
    targets: Vec<FeatureForgeTarget>,
    configs: &BTreeMap<String, ForgeHostConfig>,
) -> (HashMap<RepoKey, RepoGroup>, Vec<Publication>) {
    let mut groups = HashMap::<RepoKey, RepoGroup>::new();
    let mut unpolled = Vec::new();
    for target in targets {
        if let Some(snapshot) = target_without_repo_snapshot(&target) {
            unpolled.push(Publication::unpolled(snapshot));
            continue;
        }
        let single = build_single_group(target, configs);
        groups
            .entry(single.key.clone())
            .or_insert_with(|| RepoGroup {
                features: Vec::new(),
                ..single
            })
            .features
            .extend(single.features);
    }
    (groups, unpolled)
}

pub(super) fn build_single_group(
    target: FeatureForgeTarget,
    configs: &BTreeMap<String, ForgeHostConfig>,
) -> RepoGroup {
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
    RepoGroup {
        key,
        remote,
        kind,
        config,
        features: vec![GroupFeature {
            feature_id: target.feature_id,
            tracked: target.tracked,
        }],
    }
}

async fn resolve_group_context(
    state: &AppState,
    group: &RepoGroup,
) -> Result<(&'static dyn ForgeProvider, ForgeContext), ForgeError> {
    let hostname = &group.remote.hostname;
    let provider = provider_for(group.kind).ok_or_else(|| {
        ForgeError::Configuration(format!(
            "Choose which provider {hostname} runs so Cadencr knows which API to call."
        ))
    })?;
    let api_base_url =
        api_base_url(hostname, group.kind, group.config.as_ref())?.ok_or_else(|| {
            ForgeError::Configuration(format!(
                "Set an API base URL for {hostname} before Cadencr can reach its API."
            ))
        })?;
    let credentials = resolve_credentials(
        &state.forge_auth,
        hostname,
        group.kind,
        group.config.as_ref(),
    )
    .await?
    .ok_or_else(|| {
        ForgeError::Authentication(format!(
            "Add an API token for {hostname} to load pull requests, checks, and comments."
        ))
    })?;
    let context = ForgeContext {
        remote: group.remote.clone(),
        api_base_url,
        credentials,
        http: state.forge_http.clone(),
    };
    Ok((provider, context))
}

/// Poll one repo group and return what to publish for each of its features.
pub(super) async fn poll_group(state: &AppState, group: &RepoGroup) -> Vec<Publication> {
    let hostname = &group.remote.hostname;
    let (provider, context) = match resolve_group_context(state, group).await {
        Ok(resolved) => resolved,
        Err(error) => return group_error(group, &error),
    };
    let prs = match provider.list_open_prs(&context).await {
        Ok(prs) => prs,
        Err(error) => {
            if matches!(error, ForgeError::Authentication(_))
                && context.credentials.source == ForgeAuthSource::Cli
            {
                invalidate_cli_token(hostname);
            }
            // The first real call is where an expired or wrongly-scoped token
            // surfaces, so this arm carries onboarding failures too.
            return group_error(group, &error);
        }
    };
    let mut matches = matched_prs(group, &prs);
    let detail_errors = restore_known_prs(state, group, provider, &context, &mut matches).await;
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
    persist_prs(state, group, &matches).await;
    let polled = PolledPrs {
        matches: &matches,
        ci_by_pr: &ci_by_pr,
        unresolved_by_pr: &unresolved_by_pr,
        fetched_at: chrono::Utc::now().timestamp_millis(),
    };
    group
        .features
        .iter()
        .map(|feature| {
            let error = detail_errors.get(&feature.feature_id).cloned();
            Publication {
                snapshot: feature_snapshot(feature, &polled, error),
                current_branch: Some(feature.tracked.first().map(|branch| branch.name.clone())),
            }
        })
        .collect()
}

/// Report one group-wide failure against every feature in the group.
fn group_error(group: &RepoGroup, error: &ForgeError) -> Vec<Publication> {
    let setup_required = error.is_setup_failure();
    let detail = error.to_string();
    group
        .features
        .iter()
        .map(|feature| {
            Publication::unpolled(PrStatusSnapshot::unpolled(
                feature.feature_id,
                Some(detail.clone()),
                setup_required,
            ))
        })
        .collect()
}

/// Publish polled snapshots. Callers hold the publish-order lock.
pub(super) async fn publish_all(state: &AppState, publications: Vec<Publication>) {
    for publication in publications {
        if let Some(current) = publication.current_branch {
            state
                .forge_status
                .set_current_branch(publication.snapshot.feature_id, current.as_deref())
                .await;
        }
        publish(state, publication.snapshot).await;
    }
}

async fn publish(state: &AppState, snapshot: PrStatusSnapshot) {
    if state.forge_status.upsert(snapshot.clone()).await {
        state.forge_events_tx.send(snapshot).ignore_closed();
    }
}
