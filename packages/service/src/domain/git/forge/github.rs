use async_trait::async_trait;
use reqwest::header::ACCEPT;
use serde::Deserialize;

use super::github_repository::resolve_pull_repo;
use super::merging::{MergeCommand, PrMergeResponse, PrMergeStatus};
use super::provider::{
    proposal_noun, CiCheck, CiRollup, CiState, CommentThread, ForgeAuthContext, ForgeContext,
    ForgeError, ForgeProvider, ForgeUser, PrState, PrSummary, ReviewState,
};

mod comments;
mod merge;
mod review_threads;

pub struct GitHubProvider;

#[async_trait]
impl ForgeProvider for GitHubProvider {
    async fn list_open_prs(&self, ctx: &ForgeContext) -> Result<Vec<PrSummary>, ForgeError> {
        let repo = resolve_pull_repo(ctx).await?;
        let url = format!(
            "{}/repos/{}/pulls?state=open&per_page=100",
            ctx.api_base_url, repo.api_full_name
        );
        let response: Vec<GitHubPull> = ctx.http.request_json(github_get(ctx, &url)).await?;
        Ok(response
            .into_iter()
            .filter(|pull| {
                repo.head_full_name.as_deref().is_none_or(|head| {
                    pull.head.repo.as_ref().map(|repo| repo.full_name.as_str()) == Some(head)
                })
            })
            .map(|pull| map_pull(pull, ctx.remote.host))
            .collect())
    }

    async fn get_pr(&self, ctx: &ForgeContext, pr_number: u64) -> Result<PrSummary, ForgeError> {
        let repo = resolve_pull_repo(ctx).await?;
        let url = format!(
            "{}/repos/{}/pulls/{pr_number}",
            ctx.api_base_url, repo.api_full_name
        );
        let pull: GitHubPull = ctx.http.request_json(github_get(ctx, &url)).await?;
        Ok(map_pull(pull, ctx.remote.host))
    }

    async fn ci_rollup(&self, ctx: &ForgeContext, pr: &PrSummary) -> Result<CiRollup, ForgeError> {
        let repo = resolve_pull_repo(ctx).await?;
        let checks_url = format!(
            "{}/repos/{}/commits/{}/check-runs?per_page=100",
            ctx.api_base_url, repo.api_full_name, pr.head_sha
        );
        let status_url = format!(
            "{}/repos/{}/commits/{}/status",
            ctx.api_base_url, repo.api_full_name, pr.head_sha
        );
        let (checks, statuses): (GitHubCheckRuns, GitHubCombinedStatus) = tokio::try_join!(
            ctx.http.request_json(github_get(ctx, &checks_url)),
            ctx.http.request_json(github_get(ctx, &status_url)),
        )?;
        let mut mapped = checks
            .check_runs
            .into_iter()
            .map(|check| CiCheck {
                name: check.name,
                state: github_check_state(&check.status, check.conclusion.as_deref()),
                url: check.html_url,
            })
            .collect::<Vec<_>>();
        mapped.extend(statuses.statuses.into_iter().map(|status| CiCheck {
            name: status.context,
            state: github_status_state(&status.state),
            url: status.target_url,
        }));
        Ok(CiRollup::from_checks(mapped))
    }

    async fn comments(
        &self,
        ctx: &ForgeContext,
        pr_number: u64,
    ) -> Result<Vec<CommentThread>, ForgeError> {
        let repo = resolve_pull_repo(ctx).await?;
        comments::fetch(ctx, &repo.api_full_name, pr_number).await
    }

    async fn validate_token(&self, ctx: &ForgeAuthContext) -> Result<ForgeUser, ForgeError> {
        let url = format!("{}/user", ctx.api_base_url);
        let request = ctx
            .http
            .get(&url)
            .bearer_auth(&ctx.credentials.token)
            .header(ACCEPT, "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28");
        let user: GitHubUser = ctx.http.request_json(request).await?;
        Ok(map_user(user))
    }

    async fn merge_status(
        &self,
        ctx: &ForgeContext,
        pr: &PrSummary,
    ) -> Result<PrMergeStatus, ForgeError> {
        merge::merge_status(ctx, pr).await
    }

    async fn merge(
        &self,
        ctx: &ForgeContext,
        pr: &PrSummary,
        command: &MergeCommand,
        _status: &PrMergeStatus,
    ) -> Result<PrMergeResponse, ForgeError> {
        merge::merge(ctx, pr, command).await
    }

    async fn cancel_merge(&self, ctx: &ForgeContext, pr: &PrSummary) -> Result<(), ForgeError> {
        merge::cancel(ctx, pr).await
    }
}

pub(super) fn github_get(ctx: &ForgeContext, url: &str) -> reqwest::RequestBuilder {
    github_auth(ctx, ctx.http.get(url))
}

/// The token and REST API version every GitHub request carries.
pub(super) fn github_auth(
    ctx: &ForgeContext,
    builder: reqwest::RequestBuilder,
) -> reqwest::RequestBuilder {
    builder
        .bearer_auth(&ctx.credentials.token)
        .header(ACCEPT, "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28")
}

fn map_pull(pull: GitHubPull, host: crate::domain::git::host::GitHost) -> PrSummary {
    let review_state = if pull.requested_reviewers.is_empty() {
        ReviewState::None
    } else {
        ReviewState::Pending
    };
    PrSummary {
        number: pull.number,
        title: pull.title,
        body_markdown: pull.body.unwrap_or_default(),
        state: github_pr_state(&pull.state, pull.draft, pull.merged_at.is_some()),
        url: pull.html_url,
        source_branch: pull.head.reference,
        target_branch: pull.base.reference,
        head_sha: pull.head.sha,
        review_state,
        author: map_user(pull.user),
        updated_at: pull.updated_at,
        pr_label: proposal_noun(host).into(),
    }
}

fn github_pr_state(state: &str, draft: bool, merged: bool) -> PrState {
    if merged {
        PrState::Merged
    } else if state == "closed" {
        PrState::Closed
    } else if draft {
        PrState::Draft
    } else {
        PrState::Open
    }
}

pub(super) fn map_user(user: GitHubUser) -> ForgeUser {
    ForgeUser {
        username: user.login,
        display_name: user.name,
        avatar_url: user.avatar_url,
    }
}

fn github_check_state(status: &str, conclusion: Option<&str>) -> CiState {
    if status != "completed" {
        return CiState::Running;
    }
    match conclusion.unwrap_or_default() {
        "success" | "neutral" | "skipped" => CiState::Passing,
        "failure" | "timed_out" | "cancelled" | "action_required" | "startup_failure" => {
            CiState::Failing
        }
        _ => CiState::Running,
    }
}

fn github_status_state(state: &str) -> CiState {
    match state {
        "success" => CiState::Passing,
        "failure" | "error" => CiState::Failing,
        _ => CiState::Running,
    }
}

#[derive(Deserialize)]
struct GitHubPull {
    number: u64,
    title: String,
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default = "default_open_state")]
    state: String,
    merged_at: Option<String>,
    html_url: String,
    head: GitHubPullRef,
    base: GitHubPullRef,
    user: GitHubUser,
    #[serde(default)]
    requested_reviewers: Vec<GitHubUser>,
    updated_at: String,
}

fn default_open_state() -> String {
    "open".into()
}

#[derive(Deserialize)]
struct GitHubPullRef {
    #[serde(rename = "ref")]
    reference: String,
    sha: String,
    repo: Option<GitHubPullRepo>,
}

#[derive(Deserialize)]
struct GitHubPullRepo {
    full_name: String,
}

#[derive(Deserialize)]
pub(super) struct GitHubUser {
    login: String,
    name: Option<String>,
    #[serde(alias = "avatarUrl")]
    avatar_url: Option<String>,
}

#[derive(Default, Deserialize)]
struct GitHubCheckRuns {
    #[serde(default)]
    check_runs: Vec<GitHubCheckRun>,
}

#[derive(Deserialize)]
struct GitHubCheckRun {
    name: String,
    status: String,
    conclusion: Option<String>,
    html_url: Option<String>,
}

#[derive(Default, Deserialize)]
struct GitHubCombinedStatus {
    #[serde(default)]
    statuses: Vec<GitHubStatus>,
}

#[derive(Deserialize)]
struct GitHubStatus {
    context: String,
    state: String,
    target_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::domain::git::forge::provider::ThreadSide;
    use crate::domain::git::forge::test_support::{context, fixture, json_fixture_server};
    use crate::domain::git::host::GitHost;

    #[test]
    fn unknown_check_conclusions_stay_running() {
        assert_eq!(
            github_check_state("completed", Some("new_value")),
            CiState::Running
        );
        assert_eq!(github_check_state("queued", None), CiState::Running);
    }

    #[test]
    fn maps_terminal_pull_states() {
        assert_eq!(github_pr_state("closed", false, true), PrState::Merged);
        assert_eq!(github_pr_state("closed", false, false), PrState::Closed);
    }

    #[tokio::test]
    async fn list_open_prs_maps_recorded_fixture() {
        let mut routes = HashMap::new();
        routes.insert(
            "/repos/acme/repo".into(),
            serde_json::json!({ "full_name": "acme/repo", "fork": false, "parent": null }),
        );
        routes.insert("/repos/acme/repo/pulls".into(), fixture("github_pulls"));
        let context = context(json_fixture_server(routes).await, GitHost::GitHub);

        let pulls = GitHubProvider
            .list_open_prs(&context)
            .await
            .expect("GitHub fixture maps");

        assert_eq!(pulls.len(), 1);
        assert_eq!(pulls[0].number, 17);
        assert_eq!(pulls[0].source_branch, "feature/forge");
        assert_eq!(pulls[0].pr_label, "Pull request");
    }

    #[tokio::test]
    async fn comments_carry_graphql_resolution_and_diff_anchors() {
        let mut routes = HashMap::new();
        routes.insert(
            "/repos/acme/repo".into(),
            serde_json::json!({ "full_name": "acme/repo", "fork": false, "parent": null }),
        );
        routes.insert(
            "/repos/acme/repo/issues/17/comments".into(),
            serde_json::json!([]),
        );
        routes.insert(
            "/repos/acme/repo/pulls/17/reviews".into(),
            serde_json::json!([]),
        );
        routes.insert("/graphql".into(), fixture("github_review_threads"));
        let context = context(json_fixture_server(routes).await, GitHost::GitHub);

        let threads = GitHubProvider
            .comments(&context, 17)
            .await
            .expect("GitHub review threads map");

        assert_eq!(threads.len(), 2);
        let open = threads
            .iter()
            .find(|thread| thread.resolved == Some(false))
            .expect("an unresolved thread survives");
        assert_eq!(open.file.as_deref(), Some("packages/service/src/main.rs"));
        assert_eq!(open.line, Some(42));
        assert_eq!(open.side, Some(ThreadSide::New));
        assert_eq!(open.comments.len(), 2);
        assert_eq!(open.comments[0].author.username, "reviewer-one");
        assert_eq!(
            open.comments[0].author.display_name.as_deref(),
            Some("Reviewer One")
        );
        // REST reports no resolution at all, so a resolved thread only becomes
        // filterable because the GraphQL path replaced it.
        assert!(threads.iter().any(|thread| thread.resolved == Some(true)));
    }
}
