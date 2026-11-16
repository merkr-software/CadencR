//! GitLab approvals and merging, including auto-merge ("merge when checks
//! pass") and merge trains.

mod model;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::json;

use self::model::{Approvals, MergeRequestDetail, MergeTrainEntry, Project, ReviewerState};
use super::{encoded_project, gitlab_auth, gitlab_get, map_user};
use crate::domain::git::forge::merging::{
    AutoMergeState, DeleteSourceBranch, MergeAction, MergeCommand, MergeMethod, MergeOutcome,
    MergeQueueEntry, MergeQueueKind, MergeReadiness, PrApprovals, PrMergeResponse, PrMergeStatus,
    PrReviewer, ReviewerDecision, CONFLICTS_REASON, DRAFT_REASON,
};
use crate::domain::git::forge::provider::{ForgeContext, ForgeError, PrSummary};

pub(super) async fn merge_status(
    ctx: &ForgeContext,
    pr: &PrSummary,
) -> Result<PrMergeStatus, ForgeError> {
    let base = mr_url(ctx, pr.number);
    let project_url = format!("{}/projects/{}", ctx.api_base_url, encoded_project(ctx));
    let approvals_url = format!("{base}/approvals");
    let reviewers_url = format!("{base}/reviewers");
    // Reviewer states arrived in GitLab 16.x; older servers 404 and the
    // reviewers fall back to "asked, not answered".
    let (detail, project, approvals, states): (MergeRequestDetail, Project, Approvals, _) = tokio::try_join!(
        ctx.http.request_json(gitlab_get(ctx, &base)),
        ctx.http.request_json(gitlab_get(ctx, &project_url)),
        ctx.http.request_json(gitlab_get(ctx, &approvals_url)),
        ctx.http
            .request_optional_json::<Vec<ReviewerState>>(gitlab_get(ctx, &reviewers_url)),
    )?;
    let train = if project.merge_trains_enabled.unwrap_or(false) {
        train_entry(ctx, &detail).await?
    } else {
        None
    };
    Ok(map_status(
        pr.number, detail, &project, approvals, states, train,
    ))
}

pub(super) async fn merge(
    ctx: &ForgeContext,
    pr: &PrSummary,
    command: &MergeCommand,
    status: &PrMergeStatus,
) -> Result<PrMergeResponse, ForgeError> {
    let squash = command
        .method
        .or(status.default_method)
        .is_some_and(MergeMethod::squashes);
    let base = mr_url(ctx, pr.number);
    let waits = matches!(
        command.action,
        MergeAction::AutoMerge | MergeAction::EnqueueWhenReady
    );
    let outcome = match command.action {
        MergeAction::Merge | MergeAction::AutoMerge => {
            let request = gitlab_auth(ctx, ctx.http.put(&format!("{base}/merge"))).json(&json!({
                "sha": command.expected_head_sha,
                "squash": squash,
                "should_remove_source_branch": command.delete_source_branch,
                "auto_merge": waits,
                // Pre-17.x servers only know the old name.
                "merge_when_pipeline_succeeds": waits,
            }));
            let response = ctx.http.request_mutation(request).await?;
            let state = response.body.get("state").and_then(|value| value.as_str());
            let auto = response
                .body
                .get("merge_when_pipeline_succeeds")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            match (state, auto) {
                (Some("merged"), _) => MergeOutcome::Merged,
                (_, true) => MergeOutcome::AutoMergeEnabled,
                _ => MergeOutcome::Merging,
            }
        }
        MergeAction::Enqueue | MergeAction::EnqueueWhenReady => {
            if status.delete_source_branch.configurable {
                // The train has no such parameter; it reads the MR's own flag,
                // which may be unset even where the project defaults to "on".
                let update = gitlab_auth(ctx, ctx.http.put(&base))
                    .json(&json!({ "remove_source_branch": command.delete_source_branch }));
                ctx.http.request_mutation(update).await?;
            }
            let url = format!(
                "{}/projects/{}/merge_trains/merge_requests/{}",
                ctx.api_base_url,
                encoded_project(ctx),
                pr.number
            );
            let request = gitlab_auth(ctx, ctx.http.post(&url)).json(&json!({
                "sha": command.expected_head_sha,
                "squash": squash,
                "auto_merge": waits,
                "when_pipeline_succeeds": waits,
            }));
            ctx.http.request_mutation(request).await?;
            if waits {
                MergeOutcome::AutoMergeEnabled
            } else {
                MergeOutcome::Queued
            }
        }
    };
    Ok(PrMergeResponse {
        outcome,
        warning: None,
    })
}

/// Cancels auto-merge; GitLab's auto-merge service also takes a merge request
/// off its merge train, which has no endpoint of its own.
pub(super) async fn cancel(ctx: &ForgeContext, pr: &PrSummary) -> Result<(), ForgeError> {
    let url = format!(
        "{}/cancel_merge_when_pipeline_succeeds",
        mr_url(ctx, pr.number)
    );
    ctx.http
        .request_mutation(gitlab_auth(ctx, ctx.http.post(&url)))
        .await
        .map(|_| ())
}

fn mr_url(ctx: &ForgeContext, number: u64) -> String {
    format!(
        "{}/projects/{}/merge_requests/{number}",
        ctx.api_base_url,
        encoded_project(ctx)
    )
}

async fn train_entry(
    ctx: &ForgeContext,
    detail: &MergeRequestDetail,
) -> Result<Option<MergeQueueEntry>, ForgeError> {
    let trains = format!(
        "{}/projects/{}/merge_trains",
        ctx.api_base_url,
        encoded_project(ctx)
    );
    let url = format!("{trains}/merge_requests/{}", detail.iid);
    let Some(entry) = ctx
        .http
        .request_optional_json::<MergeTrainEntry>(gitlab_get(ctx, &url))
        .await?
    else {
        return Ok(None);
    };
    if !matches!(entry.status.as_str(), "idle" | "fresh" | "stale") {
        return Ok(None);
    }
    // The train for this target only, oldest car first.
    let list_url = format!(
        "{trains}/{}?scope=active&sort=asc&per_page=100",
        utf8_percent_encode(&detail.target_branch, NON_ALPHANUMERIC)
    );
    let cars = ctx
        .http
        .request_json::<Vec<MergeTrainEntry>>(gitlab_get(ctx, &list_url))
        .await?;
    let ahead = cars
        .iter()
        .position(|car| car.merge_request.as_ref().map(|mr| mr.iid) == Some(detail.iid))
        .and_then(|index| u32::try_from(index).ok());
    Ok(Some(MergeQueueEntry {
        ahead,
        enqueued_by: entry.user.map(map_user),
    }))
}

fn map_status(
    number: u64,
    detail: MergeRequestDetail,
    project: &Project,
    approvals: Approvals,
    states: Option<Vec<ReviewerState>>,
    train: Option<MergeQueueEntry>,
) -> PrMergeStatus {
    let required = approvals.approvals_required.filter(|count| *count > 0);
    let satisfied = required.map(|_| approvals.approvals_left == Some(0));
    let reviewers = reviewers(&detail, approvals, states);
    let approvals = PrApprovals::from_reviewers(reviewers, required, satisfied);
    let (readiness, reason) = readiness(&detail);
    let can_merge = detail.user.as_ref().is_some_and(|user| user.can_merge);
    let trains = project.merge_trains_enabled.unwrap_or(false);
    let auto_merging = detail.merge_when_pipeline_succeeds;
    let (methods, default_method) = methods(project);
    let actions = actions(&detail, readiness, can_merge, trains, train.is_some());
    PrMergeStatus {
        pr_number: number,
        head_sha: detail.sha.clone().unwrap_or_default(),
        approvals,
        readiness,
        reasons: reason.into_iter().collect(),
        can_merge: Some(can_merge),
        methods,
        default_method,
        queue: trains.then_some(MergeQueueKind::MergeTrain),
        cancellable: can_merge && (auto_merging || train.is_some()),
        auto_merge: (auto_merging && train.is_none()).then(|| AutoMergeState {
            enabled_by: detail.merge_user.clone().map(map_user),
            method: None,
        }),
        queue_entry: train,
        actions,
        delete_source_branch: DeleteSourceBranch {
            default: detail
                .force_remove_source_branch
                .or(project.remove_source_branch_after_merge)
                .unwrap_or(false),
            configurable: detail.source_project_id == detail.target_project_id,
            // Auto-merge and trains read the merge request's own flag.
            deferred: true,
        },
        fetched_at: chrono::Utc::now().timestamp_millis(),
    }
}

fn reviewers(
    detail: &MergeRequestDetail,
    approvals: Approvals,
    states: Option<Vec<ReviewerState>>,
) -> Vec<PrReviewer> {
    let mut reviewers = match states {
        Some(states) => states
            .into_iter()
            .map(|state| PrReviewer {
                decision: match state.state.as_str() {
                    "approved" => ReviewerDecision::Approved,
                    "requested_changes" => ReviewerDecision::ChangesRequested,
                    "reviewed" => ReviewerDecision::Commented,
                    _ => ReviewerDecision::Pending,
                },
                user: map_user(state.user),
            })
            .collect::<Vec<_>>(),
        None => detail
            .reviewers
            .iter()
            .cloned()
            .map(|user| PrReviewer {
                user: map_user(user),
                decision: ReviewerDecision::Pending,
            })
            .collect(),
    };
    // Anyone eligible can approve, reviewer or not, and an approval is what
    // the rules count.
    for approval in approvals.approved_by {
        let user = map_user(approval.user);
        reviewers.retain(|reviewer| reviewer.user.username != user.username);
        reviewers.push(PrReviewer {
            user,
            decision: ReviewerDecision::Approved,
        });
    }
    reviewers
}

/// `detailed_merge_status` is GitLab's single answer to "can this merge, and if
/// not, why"; unknown future values read as blocked with their raw name.
fn readiness(detail: &MergeRequestDetail) -> (MergeReadiness, Option<String>) {
    if detail.state != "opened" {
        return (MergeReadiness::Closed, None);
    }
    let status = detail
        .detailed_merge_status
        .as_deref()
        .unwrap_or("unchecked");
    let blocked = |reason: &str| (MergeReadiness::Blocked, Some(reason.to_string()));
    match status {
        "mergeable" => (MergeReadiness::Ready, None),
        "checking" | "unchecked" | "preparing" | "approvals_syncing" => (
            MergeReadiness::Checking,
            Some("GitLab is still checking whether this can merge".into()),
        ),
        "conflict" => (MergeReadiness::Conflicts, Some(CONFLICTS_REASON.into())),
        "need_rebase" => (
            MergeReadiness::Behind,
            Some("The source branch must be rebased onto the target".into()),
        ),
        "draft_status" => (MergeReadiness::Draft, Some(DRAFT_REASON.into())),
        "not_open" => (MergeReadiness::Closed, None),
        "ci_must_pass" => blocked("The pipeline must succeed"),
        "ci_still_running" => blocked("The pipeline is still running"),
        "not_approved" => blocked("Approvals are still required"),
        "discussions_not_resolved" => blocked("All threads must be resolved"),
        "requested_changes" => blocked("Changes were requested"),
        "blocked_status" | "merge_request_blocked" => blocked("Blocked by another merge request"),
        "external_status_checks" => blocked("External status checks must pass"),
        "jira_association_missing" => {
            blocked("The title or description must reference a Jira issue")
        }
        "merge_time" => blocked("The scheduled merge time has not been reached"),
        "security_policy_violations" | "security_policy_pipeline_check" => {
            blocked("Security policy violations must be resolved")
        }
        "locked_paths" | "locked_lfs_files" => blocked("Locked files must be unlocked"),
        "commits_status" => blocked("The source branch is missing or its commits are invalid"),
        "title_regex" => blocked("The title does not match the project's required pattern"),
        other => blocked(&crate::domain::git::forge::merging::humanize_status(other)),
    }
}

fn actions(
    detail: &MergeRequestDetail,
    readiness: MergeReadiness,
    can_merge: bool,
    trains: bool,
    in_train: bool,
) -> Vec<MergeAction> {
    if !can_merge || detail.merge_when_pipeline_succeeds || in_train {
        return Vec::new();
    }
    // What auto-merge can wait out: GitLab merges once these clear on their own.
    let waitable = matches!(
        detail.detailed_merge_status.as_deref(),
        Some(
            "ci_must_pass"
                | "ci_still_running"
                | "not_approved"
                | "discussions_not_resolved"
                | "external_status_checks"
                | "approvals_syncing"
        )
    );
    match (trains, readiness) {
        (true, MergeReadiness::Ready) => vec![MergeAction::Enqueue],
        (false, MergeReadiness::Ready) => vec![MergeAction::Merge],
        (true, _) if waitable => vec![MergeAction::EnqueueWhenReady],
        (false, _) if waitable => vec![MergeAction::AutoMerge],
        _ => Vec::new(),
    }
}

/// GitLab fixes the merge method per project; the only per-merge choice is
/// whether to squash, and the project can force that either way.
fn methods(project: &Project) -> (Vec<MergeMethod>, Option<MergeMethod>) {
    let base = match project.merge_method.as_deref() {
        Some("ff") => MergeMethod::FastForward,
        Some("rebase_merge") => MergeMethod::RebaseMerge,
        _ => MergeMethod::Merge,
    };
    let squashed = if base == MergeMethod::FastForward {
        MergeMethod::SquashFastForward
    } else {
        MergeMethod::Squash
    };
    match project.squash_option.as_deref() {
        Some("always") => (vec![squashed], Some(squashed)),
        Some("never") => (vec![base], Some(base)),
        Some("default_on") => (vec![squashed, base], Some(squashed)),
        _ => (vec![base, squashed], Some(base)),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::domain::git::forge::test_support::{context, json_fixture_server};
    use crate::domain::git::host::GitHost;

    fn summary(number: u64) -> PrSummary {
        PrSummary {
            number,
            title: "MR".into(),
            body_markdown: String::new(),
            state: crate::domain::git::forge::provider::PrState::Open,
            url: String::new(),
            source_branch: "feature/forge".into(),
            target_branch: "main".into(),
            head_sha: "c".repeat(40),
            review_state: crate::domain::git::forge::provider::ReviewState::None,
            author: crate::domain::git::forge::provider::ForgeUser {
                username: "me".into(),
                display_name: None,
                avatar_url: None,
            },
            updated_at: String::new(),
            pr_label: "Merge request".into(),
        }
    }

    fn user(name: &str) -> serde_json::Value {
        json!({ "username": name, "name": name, "avatar_url": null })
    }

    async fn status_for(detailed: &str, trains: bool, in_train: bool) -> PrMergeStatus {
        let mr = "/projects/acme%2Frepo/merge_requests/23";
        let mut routes = HashMap::new();
        routes.insert(
            mr.into(),
            json!({
                "iid": 23, "state": "opened", "sha": "c".repeat(40), "target_branch": "main",
                "detailed_merge_status": detailed, "merge_when_pipeline_succeeds": in_train,
                "merge_user": user("carol"), "force_remove_source_branch": true,
                "user": { "can_merge": true }, "source_project_id": 1, "target_project_id": 1,
                "reviewers": [user("dave")]
            }),
        );
        routes.insert(
            "/projects/acme%2Frepo".into(),
            json!({ "merge_method": "ff", "squash_option": "default_on",
                    "merge_trains_enabled": trains }),
        );
        routes.insert(
            format!("{mr}/approvals"),
            json!({ "approvals_required": 2, "approvals_left": 1,
                    "approved_by": [{ "user": user("erin") }] }),
        );
        routes.insert(
            format!("{mr}/reviewers"),
            json!([{ "user": user("dave"), "state": "requested_changes" }]),
        );
        if !in_train {
            routes.insert(
                "/projects/acme%2Frepo/merge_trains/merge_requests/23".into(),
                serde_json::Value::Null,
            );
        } else {
            routes.insert(
                "/projects/acme%2Frepo/merge_trains/merge_requests/23".into(),
                json!({ "status": "fresh", "user": user("carol"),
                        "merge_request": { "iid": 23 } }),
            );
            routes.insert(
                "/projects/acme%2Frepo/merge_trains/main".into(),
                json!([
                    { "status": "fresh", "merge_request": { "iid": 9 } },
                    { "status": "fresh", "merge_request": { "iid": 23 } }
                ]),
            );
        }
        let ctx = context(json_fixture_server(routes).await, GitHost::GitLab);
        merge_status(&ctx, &summary(23))
            .await
            .expect("GitLab merge status maps")
    }

    #[tokio::test]
    async fn approvals_combine_reviewer_states_and_approvers() {
        let status = status_for("not_approved", false, false).await;
        assert_eq!(status.approvals.approved_count, 1);
        assert_eq!(status.approvals.required, Some(2));
        assert_eq!(status.approvals.satisfied, Some(false));
        assert_eq!(
            status.approvals.reviewers[1].decision,
            ReviewerDecision::ChangesRequested
        );
        assert_eq!(status.readiness, MergeReadiness::Blocked);
        assert_eq!(status.actions, vec![MergeAction::AutoMerge]);
        assert_eq!(
            status.methods,
            vec![MergeMethod::SquashFastForward, MergeMethod::FastForward]
        );
        assert!(status.delete_source_branch.default);
    }

    #[tokio::test]
    async fn merge_trains_replace_the_merge_button() {
        let ready = status_for("mergeable", true, false).await;
        assert_eq!(ready.queue, Some(MergeQueueKind::MergeTrain));
        assert_eq!(ready.actions, vec![MergeAction::Enqueue]);

        let running = status_for("ci_still_running", true, false).await;
        assert_eq!(running.actions, vec![MergeAction::EnqueueWhenReady]);

        let riding = status_for("mergeable", true, true).await;
        assert!(riding.actions.is_empty());
        assert!(riding.cancellable);
        assert!(riding.auto_merge.is_none());
        let entry = riding.queue_entry.expect("on the train");
        assert_eq!(entry.ahead, Some(1));
        assert_eq!(
            entry.enqueued_by.map(|user| user.username).as_deref(),
            Some("carol")
        );
    }

    #[tokio::test]
    async fn conflicts_offer_nothing() {
        let status = status_for("conflict", false, false).await;
        assert_eq!(status.readiness, MergeReadiness::Conflicts);
        assert!(status.actions.is_empty());
    }
}
