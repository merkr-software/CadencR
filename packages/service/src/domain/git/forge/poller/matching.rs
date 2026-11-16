//! Which proposal belongs to which conversation branch.
//!
//! Open proposals come from one list call per repo. A branch whose proposal
//! is no longer in that list (merged, closed) keeps the one it had: from the
//! in-memory snapshot when the service has been up, else from the number
//! stored on the branch, re-read once from the forge.

use std::collections::HashMap;

use futures::{stream, StreamExt};

use super::super::provider::{ForgeContext, ForgeProvider, PrSummary};
use super::{GroupFeature, RepoGroup};
use crate::app_state::AppState;
use crate::domain::git::refs::normalize_branch_identity;

/// `(feature_id, branch)`.
pub(super) type BranchKey = (i64, String);

pub(super) fn matched_prs(
    group: &RepoGroup,
    prs: &[PrSummary],
) -> HashMap<BranchKey, Option<PrSummary>> {
    group
        .features
        .iter()
        .flat_map(|feature| {
            feature.tracked.iter().map(|branch| {
                let name = normalize_branch_identity(&branch.name);
                let matched = prs
                    .iter()
                    .filter(|pr| normalize_branch_identity(&pr.source_branch) == name)
                    .max_by(|left, right| left.updated_at.cmp(&right.updated_at))
                    .cloned();
                ((feature.feature_id, branch.name.clone()), matched)
            })
        })
        .collect()
}

struct KnownPr {
    number: u64,
    previous: Option<PrSummary>,
    /// Branch keys that had this proposal, and whether each is its
    /// conversation's current branch.
    keys: Vec<(BranchKey, bool)>,
}

/// Fill in the branches without an open proposal. Returns per-feature errors
/// for current branches whose proposal could not be re-read — a failure on
/// another branch stays out of the snapshot's `error`, which would paint the
/// current proposal red.
pub(super) async fn restore_known_prs(
    state: &AppState,
    group: &RepoGroup,
    provider: &dyn ForgeProvider,
    context: &ForgeContext,
    matches: &mut HashMap<BranchKey, Option<PrSummary>>,
) -> HashMap<i64, String> {
    let mut candidates = HashMap::<u64, KnownPr>::new();
    for feature in &group.features {
        let cached = cached_prs(state, feature).await;
        for (index, branch) in feature.tracked.iter().enumerate() {
            let key = (feature.feature_id, branch.name.clone());
            if matches.get(&key).is_some_and(Option::is_some) {
                continue;
            }
            let previous = cached.get(normalize_branch_identity(&branch.name)).cloned();
            if let Some(previous) = previous.as_ref().filter(|pr| pr.state.is_closed()) {
                matches.insert(key, Some(previous.clone()));
                continue;
            }
            let Some(number) = previous
                .as_ref()
                .map(|pr| pr.number)
                .or(branch.stored_pr.as_ref().map(|(number, _)| *number))
            else {
                continue;
            };
            candidates
                .entry(number)
                .or_insert_with(|| KnownPr {
                    number,
                    previous: previous.clone(),
                    keys: Vec::new(),
                })
                .keys
                .push((key, index == 0));
        }
    }

    let results = stream::iter(candidates.into_values())
        .map(|candidate| async move {
            let result = provider.get_pr(context, candidate.number).await;
            (candidate, result)
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    let mut errors = HashMap::new();
    for (candidate, result) in results {
        for ((feature_id, branch), is_current) in candidate.keys {
            let restored = match &result {
                // A stored number could have been reused by the forge for
                // another branch's proposal; only keep it if it still is ours.
                Ok(pr) => (normalize_branch_identity(&pr.source_branch)
                    == normalize_branch_identity(&branch))
                .then(|| pr.clone()),
                Err(error) => {
                    if is_current {
                        errors.insert(feature_id, error.to_string());
                    }
                    candidate.previous.clone()
                }
            };
            matches.insert((feature_id, branch), restored);
        }
    }
    errors
}

/// The proposals the last published snapshot knew for this conversation,
/// keyed by normalized source branch.
async fn cached_prs(state: &AppState, feature: &GroupFeature) -> HashMap<String, PrSummary> {
    let Some(snapshot) = state.forge_status.get(feature.feature_id).await else {
        return HashMap::new();
    };
    snapshot
        .pr
        .into_iter()
        .chain(snapshot.other_prs.into_iter().map(|other| other.pr))
        .map(|pr| (normalize_branch_identity(&pr.source_branch).to_string(), pr))
        .collect()
}
