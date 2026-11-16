//! Bitbucket Cloud approvals and merging. Bitbucket has no auto-merge or
//! merge queue in its API, so the only action is a merge.

use serde::Deserialize;
use serde_json::json;

use super::{authorize, bitbucket_get, map_user, BitbucketPage, BitbucketUser};
use crate::domain::git::forge::merging::{
    DeleteSourceBranch, MergeAction, MergeCommand, MergeMethod, MergeOutcome, MergeReadiness,
    PrApprovals, PrMergeResponse, PrMergeStatus, PrReviewer, ReviewerDecision, CONFLICTS_REASON,
    DRAFT_REASON,
};
use crate::domain::git::forge::provider::{ForgeContext, ForgeError, PrSummary};

/// The strategies Bitbucket offers when the branch does not list its own.
const DEFAULT_STRATEGIES: [&str; 3] = ["merge_commit", "squash", "fast_forward"];

pub(super) async fn merge_status(
    ctx: &ForgeContext,
    pr: &PrSummary,
) -> Result<PrMergeStatus, ForgeError> {
    let base = repo_url(ctx);
    let pull_url = format!("{base}/pullrequests/{}", pr.number);
    let diffstat_url = format!("{pull_url}/diffstat?pagelen=500&fields=values.status");
    let full_name = format!("{}/{}", ctx.remote.owner, ctx.remote.repo);
    let permission_url = format!(
        "{}/user/permissions/repositories?q=repository.full_name%3D%22{}%22",
        ctx.api_base_url,
        full_name.replace('/', "%2F")
    );
    let restrictions_url =
        format!("{base}/branch-restrictions?kind=require_approvals_to_merge&pagelen=100");
    let (pull, diffstat, permission, restrictions) = tokio::join!(
        ctx.http
            .request_json::<PullDetail>(bitbucket_get(ctx, &pull_url)?),
        ctx.http
            .request_json::<BitbucketPage<DiffStat>>(bitbucket_get(ctx, &diffstat_url)?),
        ctx.http
            .request_json::<BitbucketPage<Permission>>(bitbucket_get(ctx, &permission_url)?),
        ctx.http
            .request_json::<BitbucketPage<Restriction>>(bitbucket_get(ctx, &restrictions_url)?),
    );
    let pull = pull?;
    // The diffstat is read with the pull request's own scope; without it a
    // conflict would pass for "ready".
    let conflicts = diffstat?.values.iter().any(|entry| {
        matches!(
            entry.status.as_deref(),
            Some("merge conflict" | "local deleted" | "remote deleted")
        )
    });
    // These two are enrichments the token may not be allowed to read
    // (permissions need an account scope, branch restrictions need admin).
    // Unknown is an honest answer; failing the whole status is not.
    let can_merge = permission.ok().and_then(|page| {
        page.values
            .first()
            .map(|entry| matches!(entry.permission.as_str(), "write" | "admin"))
    });
    let required = restrictions.ok().and_then(|page| {
        page.values
            .iter()
            .filter(|rule| rule.applies_to(&pr.target_branch))
            .filter_map(|rule| rule.value)
            .max()
    });
    Ok(map_status(pr.number, pull, conflicts, can_merge, required))
}

pub(super) async fn merge(
    ctx: &ForgeContext,
    pr: &PrSummary,
    command: &MergeCommand,
) -> Result<PrMergeResponse, ForgeError> {
    let strategy = strategy_name(command.method.unwrap_or(MergeMethod::Merge));
    let url = format!("{}/pullrequests/{}/merge", repo_url(ctx), pr.number);
    let request = authorize(ctx, ctx.http.post(&url))?.json(&json!({
        "type": "pullrequest_merge_parameters",
        "merge_strategy": strategy,
        "close_source_branch": command.delete_source_branch,
    }));
    let response = ctx.http.request_mutation(request).await?;
    // Large merges come back `202 Accepted` with a task to poll; the status
    // poller notices the merged state on its own.
    let merged = response.body.get("state").and_then(|value| value.as_str()) == Some("MERGED");
    Ok(PrMergeResponse {
        outcome: if merged {
            MergeOutcome::Merged
        } else {
            MergeOutcome::Merging
        },
        warning: None,
    })
}

fn repo_url(ctx: &ForgeContext) -> String {
    format!(
        "{}/repositories/{}/{}",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repo
    )
}

fn map_status(
    number: u64,
    pull: PullDetail,
    conflicts: bool,
    can_merge: Option<bool>,
    required: Option<u32>,
) -> PrMergeStatus {
    let reviewers = pull
        .participants
        .into_iter()
        .filter_map(|participant| {
            let decision = if participant.approved {
                ReviewerDecision::Approved
            } else if participant.state.as_deref() == Some("changes_requested") {
                ReviewerDecision::ChangesRequested
            } else if participant.role.as_deref() == Some("REVIEWER") {
                ReviewerDecision::Pending
            } else {
                // A participant who only commented has no position to show.
                return None;
            };
            Some(PrReviewer {
                user: map_user(participant.user),
                decision,
            })
        })
        .collect();
    let approvals = PrApprovals::from_reviewers(reviewers, required.filter(|n| *n > 0), None);
    let (readiness, reasons) = if pull.state != "OPEN" {
        (MergeReadiness::Closed, Vec::new())
    } else if pull.draft {
        (MergeReadiness::Draft, vec![DRAFT_REASON.to_string()])
    } else if conflicts {
        (
            MergeReadiness::Conflicts,
            vec![CONFLICTS_REASON.to_string()],
        )
    } else if approvals.satisfied == Some(false) {
        (MergeReadiness::Blocked, vec![approvals.missing_reason()])
    } else {
        (MergeReadiness::Ready, Vec::new())
    };
    let branch = pull.destination.branch;
    let strategies = branch
        .merge_strategies
        .unwrap_or_else(|| DEFAULT_STRATEGIES.map(String::from).to_vec());
    let methods = strategies
        .iter()
        .filter_map(|name| method_from_strategy(name))
        .collect::<Vec<_>>();
    let default_method = branch
        .default_merge_strategy
        .as_deref()
        .and_then(method_from_strategy)
        .filter(|method| methods.contains(method));
    let same_repo = pull.source.repository.as_ref().map(|repo| &repo.full_name)
        == pull
            .destination
            .repository
            .as_ref()
            .map(|repo| &repo.full_name);
    PrMergeStatus {
        pr_number: number,
        head_sha: pull.source.commit.hash,
        approvals,
        actions: if readiness == MergeReadiness::Ready && can_merge != Some(false) {
            vec![MergeAction::Merge]
        } else {
            Vec::new()
        },
        readiness,
        reasons,
        can_merge,
        methods,
        default_method,
        queue: None,
        queue_entry: None,
        auto_merge: None,
        cancellable: false,
        delete_source_branch: DeleteSourceBranch {
            default: pull.close_source_branch,
            configurable: same_repo,
            // Bitbucket has no deferred merge to carry it.
            deferred: false,
        },
        fetched_at: chrono::Utc::now().timestamp_millis(),
    }
}

fn method_from_strategy(name: &str) -> Option<MergeMethod> {
    match name {
        "merge_commit" => Some(MergeMethod::Merge),
        "squash" => Some(MergeMethod::Squash),
        "fast_forward" => Some(MergeMethod::FastForward),
        "squash_fast_forward" => Some(MergeMethod::SquashFastForward),
        "rebase_fast_forward" => Some(MergeMethod::Rebase),
        "rebase_merge" => Some(MergeMethod::RebaseMerge),
        _ => None,
    }
}

fn strategy_name(method: MergeMethod) -> &'static str {
    match method {
        MergeMethod::Merge => "merge_commit",
        MergeMethod::Squash => "squash",
        MergeMethod::FastForward => "fast_forward",
        MergeMethod::SquashFastForward => "squash_fast_forward",
        MergeMethod::Rebase => "rebase_fast_forward",
        MergeMethod::RebaseMerge => "rebase_merge",
    }
}

/// Bitbucket branch patterns are globs where `*` matches any run of
/// characters, slashes included.
fn glob_matches(pattern: &str, branch: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = branch.strip_prefix(first) else {
        return false;
    };
    let tail: Vec<&str> = parts.collect();
    let Some((last, middle)) = tail.split_last() else {
        return rest.is_empty();
    };
    for part in middle {
        match rest.find(part) {
            Some(index) => rest = &rest[index + part.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

#[derive(Deserialize)]
struct PullDetail {
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    close_source_branch: bool,
    source: Side,
    destination: Side,
    #[serde(default)]
    participants: Vec<Participant>,
}

#[derive(Deserialize)]
struct Side {
    branch: Branch,
    commit: Commit,
    repository: Option<Repository>,
}

#[derive(Deserialize)]
struct Branch {
    merge_strategies: Option<Vec<String>>,
    default_merge_strategy: Option<String>,
}

#[derive(Deserialize)]
struct Commit {
    hash: String,
}

#[derive(Deserialize)]
struct Repository {
    full_name: String,
}

#[derive(Deserialize)]
struct Participant {
    user: BitbucketUser,
    role: Option<String>,
    #[serde(default)]
    approved: bool,
    state: Option<String>,
}

#[derive(Deserialize)]
struct DiffStat {
    status: Option<String>,
}

#[derive(Deserialize)]
struct Permission {
    permission: String,
}

#[derive(Deserialize)]
struct Restriction {
    value: Option<u32>,
    pattern: Option<String>,
    branch_match_kind: Option<String>,
}

impl Restriction {
    fn applies_to(&self, branch: &str) -> bool {
        self.branch_match_kind.as_deref() == Some("glob")
            && self
                .pattern
                .as_deref()
                .is_some_and(|pattern| glob_matches(pattern, branch))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::domain::git::forge::test_support::{context, json_fixture_server};
    use crate::domain::git::host::GitHost;

    #[test]
    fn globs_match_like_bitbucket_branch_patterns() {
        assert!(glob_matches("main", "main"));
        assert!(!glob_matches("main", "main2"));
        assert!(glob_matches("release/*", "release/1.2"));
        assert!(glob_matches("*", "anything/at/all"));
        assert!(glob_matches("a*b*c", "a-x-b-y-c"));
        assert!(!glob_matches("release/*", "hotfix/1"));
    }

    fn participant(
        name: &str,
        role: &str,
        approved: bool,
        state: Option<&str>,
    ) -> serde_json::Value {
        json!({ "user": { "display_name": name, "nickname": name }, "role": role,
                "approved": approved, "state": state })
    }

    #[tokio::test]
    async fn maps_strategies_approvals_and_conflicts() {
        let mut routes = HashMap::new();
        let pull = "/repositories/acme/repo/pullrequests/9";
        routes.insert(
            pull.into(),
            json!({
                "state": "OPEN", "close_source_branch": true,
                "source": { "branch": { "name": "feature" }, "commit": { "hash": "b".repeat(12) },
                            "repository": { "full_name": "acme/repo" } },
                "destination": { "branch": { "name": "main",
                    "merge_strategies": ["squash", "merge_commit", "rebase_merge"],
                    "default_merge_strategy": "squash" },
                    "commit": { "hash": "a".repeat(12) },
                    "repository": { "full_name": "acme/repo" } },
                "participants": [
                    participant("ann", "REVIEWER", true, Some("approved")),
                    participant("ben", "REVIEWER", false, Some("changes_requested")),
                    participant("cy", "PARTICIPANT", false, None)
                ]
            }),
        );
        routes.insert(
            format!("{pull}/diffstat"),
            json!({ "values": [{ "status": "modified" }] }),
        );
        routes.insert(
            "/user/permissions/repositories".into(),
            json!({ "values": [{ "permission": "write" }] }),
        );
        routes.insert(
            "/repositories/acme/repo/branch-restrictions".into(),
            json!({ "values": [{ "kind": "require_approvals_to_merge", "value": 2,
                                 "pattern": "main", "branch_match_kind": "glob" }] }),
        );
        let ctx = context(json_fixture_server(routes).await, GitHost::Bitbucket);
        let pr = PrSummary {
            number: 9,
            title: String::new(),
            body_markdown: String::new(),
            state: crate::domain::git::forge::provider::PrState::Open,
            url: String::new(),
            source_branch: "feature".into(),
            target_branch: "main".into(),
            head_sha: "b".repeat(12),
            review_state: crate::domain::git::forge::provider::ReviewState::None,
            author: crate::domain::git::forge::provider::ForgeUser {
                username: "me".into(),
                display_name: None,
                avatar_url: None,
            },
            updated_at: String::new(),
            pr_label: "Pull request".into(),
        };
        let status = merge_status(&ctx, &pr).await.expect("maps");

        assert_eq!(status.approvals.reviewers.len(), 2);
        assert_eq!(status.approvals.required, Some(2));
        assert_eq!(status.readiness, MergeReadiness::Blocked);
        assert_eq!(status.reasons, vec!["1 more approval required"]);
        assert!(status.actions.is_empty());
        assert_eq!(status.can_merge, Some(true));
        assert_eq!(
            status.methods,
            vec![
                MergeMethod::Squash,
                MergeMethod::Merge,
                MergeMethod::RebaseMerge
            ]
        );
        assert_eq!(status.default_method, Some(MergeMethod::Squash));
        assert!(status.delete_source_branch.configurable);
    }
}
