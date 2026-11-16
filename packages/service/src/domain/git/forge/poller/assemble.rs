//! Turn one repo poll into per-conversation snapshots, and remember each
//! linked branch's proposal.

use std::collections::HashMap;

use tracing::warn;

use super::super::provider::{BranchPr, CiRollup, ForgeError, PrStatusSnapshot, PrSummary};
use super::matching::BranchKey;
use super::{GroupFeature, RepoGroup};
use crate::app_state::AppState;
use crate::domain::git::linked_branches::{self, BranchOrigin, BranchRef};

/// Everything one repo poll learned, shared by every conversation in it.
pub(super) struct PolledPrs<'a> {
    pub matches: &'a HashMap<BranchKey, Option<PrSummary>>,
    pub ci_by_pr: &'a HashMap<u64, Result<CiRollup, ForgeError>>,
    pub unresolved_by_pr: &'a HashMap<u64, Result<u32, ForgeError>>,
    pub fetched_at: i64,
}

impl PolledPrs<'_> {
    fn pr(&self, feature_id: i64, branch: &str) -> Option<PrSummary> {
        self.matches
            .get(&(feature_id, branch.to_string()))
            .cloned()
            .flatten()
    }

    /// The thread count is an enrichment, not part of the PR's health, so a
    /// failed lookup stays out of `error`: that field is the top branch of
    /// the frontend's tone picker, and a rate-limited count would paint a
    /// green PR red. `None` already means "unknown" and falls back to the
    /// check-driven tone. The user still sees the real failure the moment
    /// they open the PR pane, which fetches threads itself.
    /// Another branch's checks. A failed lookup reads as "no checks" rather
    /// than an error, for the same reason as the thread count.
    fn other_ci(&self, feature_id: i64, pr: &PrSummary) -> Option<CiRollup> {
        match self.ci_by_pr.get(&pr.number)? {
            Ok(ci) => Some(ci.clone()),
            Err(error) => {
                warn!(
                    "checks lookup failed for feature {feature_id}, #{}: {error}",
                    pr.number
                );
                None
            }
        }
    }

    fn unresolved(&self, feature_id: i64, pr: &PrSummary) -> Option<u32> {
        match self.unresolved_by_pr.get(&pr.number)? {
            Ok(count) => Some(*count),
            Err(error) => {
                warn!("unresolved thread count failed for feature {feature_id}: {error}");
                None
            }
        }
    }
}

pub(super) fn feature_snapshot(
    feature: &GroupFeature,
    polled: &PolledPrs<'_>,
    detail_error: Option<String>,
) -> PrStatusSnapshot {
    let feature_id = feature.feature_id;
    let pr = feature
        .tracked
        .first()
        .and_then(|current| polled.pr(feature_id, &current.name));
    let (ci, ci_error) = match pr.as_ref().and_then(|pr| polled.ci_by_pr.get(&pr.number)) {
        Some(Ok(ci)) => (Some(ci.clone()), None),
        Some(Err(error)) => (None, Some(error.to_string())),
        None => (None, None),
    };
    let unresolved_threads = pr.as_ref().and_then(|pr| polled.unresolved(feature_id, pr));
    PrStatusSnapshot {
        feature_id,
        pr,
        ci,
        fetched_at: polled.fetched_at,
        error: detail_error.or(ci_error),
        setup_required: false,
        unresolved_threads,
        other_prs: other_prs(feature, polled),
    }
}

/// The other branches' proposals, open ones first, then most recently
/// updated.
fn other_prs(feature: &GroupFeature, polled: &PolledPrs<'_>) -> Vec<BranchPr> {
    let feature_id = feature.feature_id;
    let mut others = feature
        .tracked
        .iter()
        .skip(1)
        .filter_map(|branch| {
            let pr = polled.pr(feature_id, &branch.name)?;
            Some(BranchPr {
                branch: branch.name.clone(),
                ci: polled.other_ci(feature_id, &pr),
                unresolved_threads: polled.unresolved(feature_id, &pr),
                pr,
            })
        })
        .collect::<Vec<_>>();
    others.sort_by(|left, right| {
        left.pr
            .state
            .is_closed()
            .cmp(&right.pr.state.is_closed())
            .then_with(|| right.pr.updated_at.cmp(&left.pr.updated_at))
    });
    others
}

/// Store the proposal of every linked branch whose number or state moved, so
/// a merged one is still listed after a restart.
pub(super) async fn persist_prs(
    state: &AppState,
    group: &RepoGroup,
    matches: &HashMap<BranchKey, Option<PrSummary>>,
) {
    for feature in &group.features {
        for branch in feature.tracked.iter().filter(|branch| branch.linked) {
            let Some(Some(pr)) = matches.get(&(feature.feature_id, branch.name.clone())) else {
                continue;
            };
            let state_label = linked_branches::pr_state_to_db(pr.state);
            if branch
                .stored_pr
                .as_ref()
                .is_some_and(|(number, stored)| *number == pr.number && stored == state_label)
            {
                continue;
            }
            let key = BranchRef {
                feature_id: feature.feature_id,
                branch: &branch.name,
            };
            let Ok(number) = i64::try_from(pr.number) else {
                continue;
            };
            // A linked branch without a row is the provisioned one; for the
            // others the existing row keeps its origin.
            let saved = linked_branches::repository::save_pr(
                &state.write_pool,
                key,
                BranchOrigin::Provisioned,
                number,
                pr.state,
            )
            .await;
            if let Err(error) = saved {
                warn!(
                    feature_id = feature.feature_id,
                    branch = %branch.name,
                    %error,
                    "remembering the branch's proposal failed"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::provider::{CiState, ForgeUser, PrState, ReviewState};
    use super::super::matching::matched_prs;
    use super::super::{GroupFeature, RepoGroup, RepoKey};
    use super::*;
    use crate::domain::git::forge::repository::TrackedBranch;
    use crate::domain::git::host::{GitHost, RemoteInfo};

    fn pr(number: u64, branch: &str, state: PrState, updated_at: &str) -> PrSummary {
        PrSummary {
            number,
            title: format!("PR {number}"),
            body_markdown: String::new(),
            state,
            url: format!("https://example.com/pr/{number}"),
            source_branch: branch.to_string(),
            target_branch: "main".into(),
            head_sha: "abc".into(),
            review_state: ReviewState::None,
            author: ForgeUser {
                username: "me".into(),
                display_name: None,
                avatar_url: None,
            },
            updated_at: updated_at.into(),
            pr_label: "Pull request".into(),
        }
    }

    fn tracked(name: &str) -> TrackedBranch {
        TrackedBranch {
            name: name.into(),
            linked: true,
            stored_pr: None,
        }
    }

    fn group(tracked: Vec<TrackedBranch>) -> RepoGroup {
        let remote = RemoteInfo {
            host: GitHost::GitHub,
            hostname: "github.com".into(),
            web_base: "https://github.com/o/r".into(),
            owner: "o".into(),
            repo: "r".into(),
        };
        RepoGroup {
            key: RepoKey {
                hostname: remote.hostname.clone(),
                api_base_url: String::new(),
                owner: "o".into(),
                repo: "r".into(),
                kind: GitHost::GitHub,
            },
            remote,
            kind: GitHost::GitHub,
            config: None,
            features: vec![GroupFeature {
                feature_id: 1,
                tracked,
            }],
        }
    }

    #[test]
    fn publishes_the_current_branch_pr_and_every_other_branch_pr() {
        let group = group(vec![
            tracked("feature/a"),
            tracked("fix/old"),
            tracked("fix/b"),
            tracked("no-pr"),
        ]);
        let prs = vec![
            pr(10, "feature/a", PrState::Open, "2026-10-16T10:00:00Z"),
            pr(11, "fix/b", PrState::Draft, "2026-10-16T09:00:00Z"),
            pr(12, "elsewhere", PrState::Open, "2026-10-16T11:00:00Z"),
        ];
        let mut matches = matched_prs(&group, &prs);
        // Merged: no longer in the open list, restored from what was known.
        matches.insert(
            (1, "fix/old".into()),
            Some(pr(9, "fix/old", PrState::Merged, "2026-10-16T12:00:00Z")),
        );
        let ci_by_pr = HashMap::from([(
            11,
            Ok(CiRollup {
                state: CiState::Failing,
                checks: Vec::new(),
            }),
        )]);
        let unresolved_by_pr = HashMap::new();
        let polled = PolledPrs {
            matches: &matches,
            ci_by_pr: &ci_by_pr,
            unresolved_by_pr: &unresolved_by_pr,
            fetched_at: 1,
        };
        let snapshot = feature_snapshot(&group.features[0], &polled, None);
        assert_eq!(snapshot.pr.map(|pr| pr.number), Some(10));
        let others = snapshot
            .other_prs
            .iter()
            .map(|other| (other.branch.as_str(), other.pr.number))
            .collect::<Vec<_>>();
        // Open proposals first, even when a closed one moved more recently.
        assert_eq!(others, vec![("fix/b", 11), ("fix/old", 9)]);
        assert_eq!(
            snapshot.other_prs[0].ci.as_ref().map(|ci| ci.state),
            Some(CiState::Failing)
        );
        assert_eq!(snapshot.error, None);
    }
}
