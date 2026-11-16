//! Maps GitHub's merge-status GraphQL answer onto the neutral status.

use super::model::{PullRequest, Repository};
use crate::domain::git::forge::merging::{
    AutoMergeState, DeleteSourceBranch, MergeAction, MergeMethod, MergeQueueEntry, MergeQueueKind,
    MergeReadiness, PrApprovals, PrMergeStatus, PrReviewer, ReviewerDecision, CONFLICTS_REASON,
    DRAFT_REASON,
};
use crate::domain::git::forge::provider::ForgeUser;

pub(super) fn map_status(number: u64, repository: &Repository, pull: PullRequest) -> PrMergeStatus {
    let required = pull.base_ref.as_ref().and_then(|base| {
        base.ref_update_rule
            .as_ref()
            .and_then(|rule| rule.required_approving_review_count)
            .or_else(|| {
                base.branch_protection_rule
                    .as_ref()
                    .and_then(|rule| rule.required_approving_review_count)
            })
            // Zero with a review still required means a code-owner or
            // ruleset requirement the count does not describe.
            .filter(|count| *count > 0)
    });
    let satisfied = match pull.review_decision.as_deref() {
        Some("APPROVED") => Some(true),
        Some("REVIEW_REQUIRED" | "CHANGES_REQUESTED") => Some(false),
        _ => None,
    };
    let approvals = PrApprovals::from_reviewers(reviewers(&pull), required, satisfied);
    let readiness = readiness(&pull);
    let checks = pull
        .commits
        .nodes
        .iter()
        .flatten()
        .find_map(|node| node.commit.status_check_rollup.as_ref())
        .map(|rollup| rollup.state.as_str());
    let reasons = reasons(readiness, &pull, &approvals, checks);
    // Null when the token may not read it: the forge decides at merge time.
    let can_merge = repository
        .viewer_permission
        .as_deref()
        .map(|permission| matches!(permission, "ADMIN" | "MAINTAIN" | "WRITE"));
    let may_merge = can_merge != Some(false);
    let methods = methods(repository);
    let default_method = repository
        .viewer_default_merge_method
        .as_deref()
        .and_then(method_from_graphql)
        .filter(|method| methods.contains(method));
    let queue = pull
        .is_merge_queue_enabled
        .then_some(MergeQueueKind::MergeQueue);
    let actions = actions(&pull, readiness, may_merge);
    PrMergeStatus {
        pr_number: number,
        head_sha: pull.head_ref_oid,
        approvals,
        readiness,
        reasons,
        can_merge,
        methods,
        default_method,
        queue,
        queue_entry: pull.merge_queue_entry.map(|entry| MergeQueueEntry {
            // GitHub counts the head of the queue as position 0.
            ahead: entry.position,
            enqueued_by: entry.enqueuer.and_then(|actor| actor.into_user()),
        }),
        cancellable: (pull.auto_merge_request.is_some() && pull.viewer_can_disable_auto_merge)
            || (pull.is_in_merge_queue && may_merge),
        auto_merge: pull.auto_merge_request.map(|request| AutoMergeState {
            enabled_by: request.enabled_by.and_then(|actor| actor.into_user()),
            method: request
                .merge_method
                .as_deref()
                .and_then(method_from_graphql),
        }),
        actions,
        delete_source_branch: DeleteSourceBranch {
            default: repository.delete_branch_on_merge,
            configurable: !repository.delete_branch_on_merge && !pull.is_cross_repository,
            // Cadencr deletes it after an immediate merge; nothing runs when
            // auto-merge or the queue lands it later.
            deferred: false,
        },
        fetched_at: chrono::Utc::now().timestamp_millis(),
    }
}

fn reviewers(pull: &PullRequest) -> Vec<PrReviewer> {
    let mut reviewers = pull
        .latest_opinionated_reviews
        .nodes
        .iter()
        .flatten()
        .filter_map(|review| {
            let decision = match review.state.as_str() {
                "APPROVED" => ReviewerDecision::Approved,
                "CHANGES_REQUESTED" => ReviewerDecision::ChangesRequested,
                "COMMENTED" => ReviewerDecision::Commented,
                _ => return None,
            };
            let author = review.author.as_ref()?;
            Some(PrReviewer {
                user: ForgeUser {
                    username: author.login.clone()?,
                    display_name: author.name.clone(),
                    avatar_url: author.avatar_url.clone(),
                },
                decision,
            })
        })
        .collect::<Vec<_>>();
    for request in pull.review_requests.nodes.iter().flatten() {
        let Some(actor) = request.requested_reviewer.as_ref() else {
            continue;
        };
        let Some(username) = actor.login.clone().or_else(|| actor.slug.clone()) else {
            continue;
        };
        // Re-requesting a review does not dismiss an approval or a change
        // request — GitHub still counts it — so only a bare comment yields to
        // the newer request.
        if reviewers.iter().any(|reviewer| {
            reviewer.user.username == username && reviewer.decision != ReviewerDecision::Commented
        }) {
            continue;
        }
        reviewers.retain(|reviewer| reviewer.user.username != username);
        reviewers.push(PrReviewer {
            user: ForgeUser {
                username,
                display_name: actor.name.clone(),
                avatar_url: actor.avatar_url.clone(),
            },
            decision: ReviewerDecision::Pending,
        });
    }
    reviewers
}

fn readiness(pull: &PullRequest) -> MergeReadiness {
    if pull.state != "OPEN" {
        return MergeReadiness::Closed;
    }
    if pull.is_draft {
        return MergeReadiness::Draft;
    }
    match pull.merge_state_status.as_str() {
        // UNSTABLE: only checks the branch does not require are failing.
        "CLEAN" | "HAS_HOOKS" | "UNSTABLE" => MergeReadiness::Ready,
        "BLOCKED" => MergeReadiness::Blocked,
        "BEHIND" => MergeReadiness::Behind,
        "DIRTY" => MergeReadiness::Conflicts,
        "DRAFT" => MergeReadiness::Draft,
        _ if pull.mergeable == "CONFLICTING" => MergeReadiness::Conflicts,
        _ => MergeReadiness::Checking,
    }
}

fn reasons(
    readiness: MergeReadiness,
    pull: &PullRequest,
    approvals: &PrApprovals,
    checks: Option<&str>,
) -> Vec<String> {
    match readiness {
        MergeReadiness::Ready | MergeReadiness::Closed => Vec::new(),
        MergeReadiness::Draft => vec![DRAFT_REASON.into()],
        MergeReadiness::Conflicts => vec![CONFLICTS_REASON.into()],
        MergeReadiness::Behind => vec!["The branch is out of date with the target branch".into()],
        MergeReadiness::Checking => vec!["GitHub is still checking whether this can merge".into()],
        MergeReadiness::Blocked => {
            let mut reasons = Vec::new();
            match pull.review_decision.as_deref() {
                Some("CHANGES_REQUESTED") => reasons.push("Changes were requested".into()),
                Some("REVIEW_REQUIRED") => reasons.push(approvals.missing_reason()),
                _ => {}
            }
            match checks {
                Some("PENDING" | "EXPECTED") => {
                    reasons.push("Required checks are still running".into());
                }
                Some("FAILURE" | "ERROR") => reasons.push("Required checks are failing".into()),
                _ => {}
            }
            if reasons.is_empty() {
                reasons.push("The target branch's rules are not satisfied yet".into());
            }
            reasons
        }
    }
}

fn actions(pull: &PullRequest, readiness: MergeReadiness, may_merge: bool) -> Vec<MergeAction> {
    let waiting = matches!(
        readiness,
        MergeReadiness::Blocked | MergeReadiness::Checking | MergeReadiness::Behind
    );
    if !may_merge || pull.auto_merge_request.is_some() || pull.is_in_merge_queue {
        return Vec::new();
    }
    match (pull.is_merge_queue_enabled, readiness) {
        (true, MergeReadiness::Ready) => vec![MergeAction::Enqueue],
        (true, _) if waiting && pull.viewer_can_enable_auto_merge => {
            vec![MergeAction::EnqueueWhenReady]
        }
        (false, MergeReadiness::Ready) => vec![MergeAction::Merge],
        (false, _) if waiting && pull.viewer_can_enable_auto_merge => vec![MergeAction::AutoMerge],
        _ => Vec::new(),
    }
}

fn methods(repository: &Repository) -> Vec<MergeMethod> {
    [
        (repository.squash_merge_allowed, MergeMethod::Squash),
        (repository.merge_commit_allowed, MergeMethod::Merge),
        (repository.rebase_merge_allowed, MergeMethod::Rebase),
    ]
    .into_iter()
    .filter_map(|(allowed, method)| allowed.then_some(method))
    .collect()
}

pub(super) fn method_from_graphql(value: &str) -> Option<MergeMethod> {
    match value {
        "MERGE" => Some(MergeMethod::Merge),
        "SQUASH" => Some(MergeMethod::Squash),
        "REBASE" => Some(MergeMethod::Rebase),
        _ => None,
    }
}
