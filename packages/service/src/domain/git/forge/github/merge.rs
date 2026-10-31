//! GitHub approvals and merging: one GraphQL read for the whole picture, REST
//! for the merge itself, GraphQL mutations for auto-merge and the merge queue.

mod model;
mod status;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::json;

use self::model::{GraphQlEnvelope, StatusData, MERGE_STATUS_QUERY};
use self::status::map_status;
use super::github_auth;
use super::review_threads::{graphql_url, split_full_name};
use crate::domain::git::forge::github_repository::resolve_pull_repo;
use crate::domain::git::forge::merging::{
    MergeAction, MergeCommand, MergeMethod, MergeOutcome, PrMergeResponse, PrMergeStatus,
};
use crate::domain::git::forge::provider::{ForgeContext, ForgeError, PrSummary};

/// Everything a merge call needs that the neutral status does not carry.
struct Fetched {
    repo_full_name: String,
    status: PrMergeStatus,
    node_id: String,
    head_branch: String,
    in_queue: bool,
    auto_merge_on: bool,
    deletes_on_merge: bool,
}

pub(super) async fn merge_status(
    ctx: &ForgeContext,
    pr: &PrSummary,
) -> Result<PrMergeStatus, ForgeError> {
    Ok(fetch(ctx, pr.number).await?.status)
}

pub(super) async fn merge(
    ctx: &ForgeContext,
    pr: &PrSummary,
    command: &MergeCommand,
) -> Result<PrMergeResponse, ForgeError> {
    let fetched = fetch(ctx, pr.number).await?;
    let outcome = match command.action {
        MergeAction::Merge => {
            let method = command.method.map_or("merge", rest_method);
            let url = format!(
                "{}/repos/{}/pulls/{}/merge",
                ctx.api_base_url, fetched.repo_full_name, pr.number
            );
            let request = github_auth(ctx, ctx.http.put(&url))
                .json(&json!({ "merge_method": method, "sha": command.expected_head_sha }));
            ctx.http.request_mutation(request).await?;
            MergeOutcome::Merged
        }
        MergeAction::AutoMerge | MergeAction::EnqueueWhenReady => {
            let mut input = json!({
                "pullRequestId": fetched.node_id,
                "expectedHeadOid": command.expected_head_sha,
            });
            // A merge queue applies its own method; naming one is an error there.
            if command.action == MergeAction::AutoMerge {
                if let Some(method) = command.method {
                    input["mergeMethod"] = json!(graphql_method(method));
                }
            }
            mutate(
                ctx,
                "enablePullRequestAutoMerge(input: $input) { clientMutationId }",
                input,
                "EnablePullRequestAutoMergeInput",
            )
            .await?;
            // Armed, not yet queued: it joins the queue once checks pass.
            MergeOutcome::AutoMergeEnabled
        }
        MergeAction::Enqueue => {
            let input = json!({
                "pullRequestId": fetched.node_id,
                "expectedHeadOid": command.expected_head_sha,
            });
            mutate(
                ctx,
                "enqueuePullRequest(input: $input) { clientMutationId }",
                input,
                "EnqueuePullRequestInput",
            )
            .await?;
            MergeOutcome::Queued
        }
    };
    let warning = if outcome == MergeOutcome::Merged
        && command.delete_source_branch
        && !fetched.deletes_on_merge
    {
        delete_branch(ctx, &fetched)
            .await
            .err()
            .map(|error| format!("Merged, but the source branch could not be deleted: {error}"))
    } else {
        None
    };
    Ok(PrMergeResponse { outcome, warning })
}

pub(super) async fn cancel(ctx: &ForgeContext, pr: &PrSummary) -> Result<(), ForgeError> {
    let fetched = fetch(ctx, pr.number).await?;
    if fetched.in_queue {
        let input = json!({ "id": fetched.node_id });
        mutate(
            ctx,
            "dequeuePullRequest(input: $input) { clientMutationId }",
            input,
            "DequeuePullRequestInput",
        )
        .await
    } else if fetched.auto_merge_on {
        let input = json!({ "pullRequestId": fetched.node_id });
        mutate(
            ctx,
            "disablePullRequestAutoMerge(input: $input) { clientMutationId }",
            input,
            "DisablePullRequestAutoMergeInput",
        )
        .await
    } else {
        Err(ForgeError::Refused(
            "This pull request is neither queued nor set to auto-merge".into(),
        ))
    }
}

async fn fetch(ctx: &ForgeContext, number: u64) -> Result<Fetched, ForgeError> {
    let repo = resolve_pull_repo(ctx).await?;
    let (owner, name) = split_full_name(&repo.api_full_name)?;
    let body = json!({
        "query": MERGE_STATUS_QUERY,
        "variables": { "owner": owner, "name": name, "number": number },
    });
    let request = github_auth(ctx, ctx.http.post(&graphql_url(&ctx.api_base_url))).json(&body);
    let envelope: GraphQlEnvelope<StatusData> = ctx.http.request_json(request).await?;
    let (data, error) = envelope.into_read()?;
    let missing = |what: String| {
        ForgeError::Response(match &error {
            Some(error) => format!("GitHub did not return {what}: {error}"),
            None => format!("GitHub did not return {what}"),
        })
    };
    let mut repository = data
        .repository
        .ok_or_else(|| missing("the repository".into()))?;
    let pull = repository
        .pull_request
        .take()
        .ok_or_else(|| missing(format!("#{number}")))?;
    Ok(Fetched {
        repo_full_name: repo.api_full_name,
        node_id: pull.id.clone(),
        head_branch: pull.head_ref_name.clone(),
        in_queue: pull.is_in_merge_queue,
        auto_merge_on: pull.auto_merge_request.is_some(),
        deletes_on_merge: repository.delete_branch_on_merge,
        status: map_status(number, &repository, pull),
    })
}

fn graphql_method(method: MergeMethod) -> &'static str {
    match method {
        MergeMethod::Squash | MergeMethod::SquashFastForward => "SQUASH",
        MergeMethod::Rebase | MergeMethod::FastForward => "REBASE",
        MergeMethod::Merge | MergeMethod::RebaseMerge => "MERGE",
    }
}

fn rest_method(method: MergeMethod) -> &'static str {
    match method {
        MergeMethod::Squash | MergeMethod::SquashFastForward => "squash",
        MergeMethod::Rebase | MergeMethod::FastForward => "rebase",
        MergeMethod::Merge | MergeMethod::RebaseMerge => "merge",
    }
}

async fn mutate(
    ctx: &ForgeContext,
    field: &str,
    input: serde_json::Value,
    input_type: &str,
) -> Result<(), ForgeError> {
    let body = json!({
        "query": format!("mutation($input: {input_type}!) {{ {field} }}"),
        "variables": { "input": input },
    });
    let request = github_auth(ctx, ctx.http.post(&graphql_url(&ctx.api_base_url))).json(&body);
    let response = ctx.http.request_mutation(request).await?;
    let envelope: GraphQlEnvelope<serde_json::Value> = serde_json::from_value(response.body)
        .map_err(|error| ForgeError::Response(format!("invalid GitHub response: {error}")))?;
    envelope.into_write().map(|_| ())
}

async fn delete_branch(ctx: &ForgeContext, fetched: &Fetched) -> Result<(), ForgeError> {
    let url = format!(
        "{}/repos/{}/git/refs/heads/{}",
        ctx.api_base_url,
        fetched.repo_full_name,
        branch_path(&fetched.head_branch)
    );
    ctx.http
        .request_mutation(github_auth(ctx, ctx.http.delete(&url)))
        .await
        .map(|_| ())
}

/// A branch name as URL path segments. Its slashes stay separators, but a `#`
/// or `%` would otherwise end or rewrite the path — and delete another branch.
fn branch_path(branch: &str) -> String {
    branch
        .split('/')
        .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::domain::git::forge::merging::{MergeQueueKind, MergeReadiness};
    use crate::domain::git::forge::test_support::{context, json_fixture_server};
    use crate::domain::git::host::GitHost;

    fn graphql_fixture(overrides: serde_json::Value) -> serde_json::Value {
        let mut pull = json!({
            "id": "PR_1", "state": "OPEN", "isDraft": false, "isCrossRepository": false,
            "headRefName": "feature/forge", "headRefOid": "a".repeat(40),
            "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED",
            "reviewDecision": "REVIEW_REQUIRED", "isMergeQueueEnabled": false,
            "isInMergeQueue": false, "viewerCanEnableAutoMerge": true,
            "viewerCanDisableAutoMerge": false, "mergeQueueEntry": null, "autoMergeRequest": null,
            "baseRef": { "refUpdateRule": { "requiredApprovingReviewCount": 2 }, "branchProtectionRule": null },
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "PENDING" } } }] },
            "latestOpinionatedReviews": { "nodes": [
                { "state": "APPROVED", "author": { "login": "alice", "name": "Alice", "avatarUrl": null } }
            ] },
            "reviewRequests": { "nodes": [
                { "requestedReviewer": { "slug": "core", "name": "Core team", "avatarUrl": null } }
            ] }
        });
        for (key, value) in overrides.as_object().expect("object overrides") {
            pull[key] = value.clone();
        }
        json!({ "data": { "repository": {
            "viewerPermission": "WRITE", "mergeCommitAllowed": true, "squashMergeAllowed": true,
            "rebaseMergeAllowed": false, "deleteBranchOnMerge": false,
            "viewerDefaultMergeMethod": "SQUASH", "pullRequest": pull
        } } })
    }

    async fn status_for(overrides: serde_json::Value) -> PrMergeStatus {
        let mut routes = HashMap::new();
        routes.insert(
            "/repos/acme/repo".into(),
            json!({ "full_name": "acme/repo", "fork": false, "parent": null }),
        );
        routes.insert("/graphql".into(), graphql_fixture(overrides));
        let ctx = context(json_fixture_server(routes).await, GitHost::GitHub);
        fetch(&ctx, 17).await.expect("merge status maps").status
    }

    #[tokio::test]
    async fn blocked_pull_offers_auto_merge_and_explains_why() {
        let status = status_for(json!({})).await;
        assert_eq!(status.readiness, MergeReadiness::Blocked);
        assert_eq!(status.approvals.approved_count, 1);
        assert_eq!(status.approvals.required, Some(2));
        assert_eq!(status.approvals.satisfied, Some(false));
        assert_eq!(status.approvals.reviewers[1].user.username, "core");
        assert_eq!(
            status.reasons,
            vec![
                "1 more approval required",
                "Required checks are still running"
            ]
        );
        assert_eq!(status.actions, vec![MergeAction::AutoMerge]);
        assert_eq!(
            status.methods,
            vec![MergeMethod::Squash, MergeMethod::Merge]
        );
        assert_eq!(status.default_method, Some(MergeMethod::Squash));
        assert!(status.delete_source_branch.configurable);
    }

    #[tokio::test]
    async fn merge_queue_branches_enqueue_instead_of_merging() {
        let ready = status_for(json!({
            "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED", "isMergeQueueEnabled": true
        }))
        .await;
        assert_eq!(ready.queue, Some(MergeQueueKind::MergeQueue));
        assert_eq!(ready.actions, vec![MergeAction::Enqueue]);

        let waiting = status_for(json!({ "isMergeQueueEnabled": true })).await;
        assert_eq!(waiting.actions, vec![MergeAction::EnqueueWhenReady]);

        let queued = status_for(json!({
            "isMergeQueueEnabled": true, "isInMergeQueue": true,
            "mergeQueueEntry": { "position": 2, "enqueuer": { "login": "bob" } }
        }))
        .await;
        assert!(queued.actions.is_empty());
        assert!(queued.cancellable);
        assert_eq!(queued.queue_entry.and_then(|entry| entry.ahead), Some(2));
    }

    #[tokio::test]
    async fn a_reviewer_the_token_cannot_see_does_not_hide_the_status() {
        let mut routes = HashMap::new();
        routes.insert(
            "/repos/acme/repo".into(),
            json!({ "full_name": "acme/repo", "fork": false, "parent": null }),
        );
        let mut fixture = graphql_fixture(json!({
            "reviewRequests": { "nodes": [{ "requestedReviewer": null }] }
        }));
        fixture["errors"] = json!([{ "message": "Resource not accessible by integration" }]);
        routes.insert("/graphql".into(), fixture);
        let ctx = context(json_fixture_server(routes).await, GitHost::GitHub);
        let status = fetch(&ctx, 17)
            .await
            .expect("partial data still maps")
            .status;
        assert_eq!(status.approvals.approved_count, 1);
        assert_eq!(status.approvals.reviewers.len(), 1);
    }

    #[tokio::test]
    async fn re_requesting_an_approver_keeps_the_approval() {
        let status = status_for(json!({
            "reviewRequests": { "nodes": [
                { "requestedReviewer": { "login": "alice", "name": "Alice", "avatarUrl": null } }
            ] }
        }))
        .await;
        assert_eq!(status.approvals.approved_count, 1);
        assert_eq!(status.approvals.reviewers.len(), 1);
    }

    #[test]
    fn branch_names_are_escaped_segment_by_segment() {
        assert_eq!(branch_path("fix/issue#12"), "fix/issue%2312");
        assert_eq!(branch_path("a%2Fb"), "a%252Fb");
    }

    #[tokio::test]
    async fn readers_without_write_access_get_no_merge_action() {
        let mut routes = HashMap::new();
        routes.insert(
            "/repos/acme/repo".into(),
            json!({ "full_name": "acme/repo", "fork": false, "parent": null }),
        );
        let mut fixture = graphql_fixture(json!({ "mergeStateStatus": "CLEAN" }));
        fixture["data"]["repository"]["viewerPermission"] = json!("READ");
        routes.insert("/graphql".into(), fixture);
        let ctx = context(json_fixture_server(routes).await, GitHost::GitHub);
        let status = fetch(&ctx, 17).await.expect("maps").status;
        assert_eq!(status.can_merge, Some(false));
        assert!(status.actions.is_empty());
    }

    #[tokio::test]
    async fn an_unreadable_permission_leaves_the_decision_to_github() {
        let mut routes = HashMap::new();
        routes.insert(
            "/repos/acme/repo".into(),
            json!({ "full_name": "acme/repo", "fork": false, "parent": null }),
        );
        let mut fixture = graphql_fixture(json!({ "mergeStateStatus": "CLEAN" }));
        fixture["data"]["repository"]["viewerPermission"] = serde_json::Value::Null;
        routes.insert("/graphql".into(), fixture);
        let ctx = context(json_fixture_server(routes).await, GitHost::GitHub);
        let status = fetch(&ctx, 17).await.expect("maps").status;
        assert_eq!(status.can_merge, None);
        assert_eq!(status.actions, vec![MergeAction::Merge]);
    }
}
