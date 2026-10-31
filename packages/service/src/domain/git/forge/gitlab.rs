use async_trait::async_trait;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;

use super::merging::{MergeCommand, PrMergeResponse, PrMergeStatus};
use super::provider::{
    proposal_noun, CiCheck, CiRollup, CiState, CommentThread, ForgeAuthContext, ForgeContext,
    ForgeError, ForgeProvider, ForgeUser, PrComment, PrState, PrSummary, ReviewState, ThreadSide,
};

mod merge;

pub struct GitLabProvider;

#[async_trait]
impl ForgeProvider for GitLabProvider {
    async fn list_open_prs(&self, ctx: &ForgeContext) -> Result<Vec<PrSummary>, ForgeError> {
        let project = encoded_project(ctx);
        let url = format!(
            "{}/projects/{project}/merge_requests?state=opened&per_page=100",
            ctx.api_base_url
        );
        let response: Vec<GitLabMergeRequest> =
            ctx.http.request_json(gitlab_get(ctx, &url)).await?;
        Ok(response
            .into_iter()
            .map(|request| map_merge_request(request, ctx.remote.host))
            .collect())
    }

    async fn get_pr(&self, ctx: &ForgeContext, pr_number: u64) -> Result<PrSummary, ForgeError> {
        let project = encoded_project(ctx);
        let url = format!(
            "{}/projects/{project}/merge_requests/{pr_number}",
            ctx.api_base_url
        );
        let request: GitLabMergeRequest = ctx.http.request_json(gitlab_get(ctx, &url)).await?;
        Ok(map_merge_request(request, ctx.remote.host))
    }

    async fn ci_rollup(&self, ctx: &ForgeContext, pr: &PrSummary) -> Result<CiRollup, ForgeError> {
        let project = encoded_project(ctx);
        let pipelines_url = format!(
            "{}/projects/{project}/merge_requests/{}/pipelines?per_page=1",
            ctx.api_base_url, pr.number
        );
        let pipelines: Vec<GitLabPipeline> = ctx
            .http
            .request_json(gitlab_get(ctx, &pipelines_url))
            .await?;
        let Some(pipeline) = pipelines.into_iter().next() else {
            return Ok(CiRollup::from_checks(Vec::new()));
        };
        let jobs_url = format!(
            "{}/projects/{project}/pipelines/{}/jobs?per_page=100",
            ctx.api_base_url, pipeline.id
        );
        let jobs: Vec<GitLabJob> = ctx.http.request_json(gitlab_get(ctx, &jobs_url)).await?;
        let mut checks = jobs
            .into_iter()
            .map(|job| CiCheck {
                name: job.name,
                state: gitlab_ci_state(&job.status),
                url: job.web_url,
            })
            .collect::<Vec<_>>();
        if checks.is_empty() {
            checks.push(CiCheck {
                name: "Pipeline".into(),
                state: gitlab_ci_state(&pipeline.status),
                url: pipeline.web_url,
            });
        }
        Ok(CiRollup::from_checks(checks))
    }

    async fn comments(
        &self,
        ctx: &ForgeContext,
        pr_number: u64,
    ) -> Result<Vec<CommentThread>, ForgeError> {
        let project = encoded_project(ctx);
        let url = format!(
            "{}/projects/{project}/merge_requests/{pr_number}/discussions?per_page=100",
            ctx.api_base_url
        );
        let discussions: Vec<GitLabDiscussion> =
            ctx.http.request_json(gitlab_get(ctx, &url)).await?;
        let mut threads = discussions
            .into_iter()
            .filter_map(|discussion| map_discussion(ctx, pr_number, discussion))
            .collect::<Vec<_>>();
        threads.sort_by(|left, right| {
            left.comments
                .first()
                .map(|comment| &comment.created_at)
                .cmp(&right.comments.first().map(|comment| &comment.created_at))
        });
        Ok(threads)
    }

    async fn validate_token(&self, ctx: &ForgeAuthContext) -> Result<ForgeUser, ForgeError> {
        let url = format!("{}/user", ctx.api_base_url);
        let request = ctx
            .http
            .get(&url)
            .header("PRIVATE-TOKEN", &ctx.credentials.token);
        let user: GitLabUser = ctx.http.request_json(request).await?;
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
        status: &PrMergeStatus,
    ) -> Result<PrMergeResponse, ForgeError> {
        merge::merge(ctx, pr, command, status).await
    }

    async fn cancel_merge(&self, ctx: &ForgeContext, pr: &PrSummary) -> Result<(), ForgeError> {
        merge::cancel(ctx, pr).await
    }
}

fn gitlab_get(ctx: &ForgeContext, url: &str) -> reqwest::RequestBuilder {
    gitlab_auth(ctx, ctx.http.get(url))
}

fn gitlab_auth(ctx: &ForgeContext, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    builder.header("PRIVATE-TOKEN", &ctx.credentials.token)
}

fn encoded_project(ctx: &ForgeContext) -> String {
    let path = format!("{}/{}", ctx.remote.owner, ctx.remote.repo);
    utf8_percent_encode(&path, NON_ALPHANUMERIC).to_string()
}

fn map_merge_request(
    request: GitLabMergeRequest,
    host: crate::domain::git::host::GitHost,
) -> PrSummary {
    let review_state = if request.reviewers.is_empty() {
        ReviewState::None
    } else {
        ReviewState::Pending
    };
    PrSummary {
        number: request.iid,
        title: request.title,
        body_markdown: request.description.unwrap_or_default(),
        state: gitlab_pr_state(&request.state, request.draft || request.work_in_progress),
        url: request.web_url,
        source_branch: request.source_branch,
        target_branch: request.target_branch,
        head_sha: request.sha.unwrap_or_default(),
        review_state,
        author: map_user(request.author),
        updated_at: request.updated_at,
        pr_label: proposal_noun(host).into(),
    }
}

fn gitlab_pr_state(state: &str, draft: bool) -> PrState {
    match state {
        "merged" => PrState::Merged,
        "closed" => PrState::Closed,
        _ if draft => PrState::Draft,
        _ => PrState::Open,
    }
}

fn map_discussion(
    ctx: &ForgeContext,
    pr_number: u64,
    discussion: GitLabDiscussion,
) -> Option<CommentThread> {
    let notes = discussion
        .notes
        .into_iter()
        .filter(|note| !note.system)
        .collect::<Vec<_>>();
    if notes.is_empty() {
        return None;
    }
    let first_position = notes.iter().find_map(|note| note.position.as_ref());
    let resolved_values = notes
        .iter()
        .filter(|note| note.resolvable)
        .filter_map(|note| note.resolved)
        .collect::<Vec<_>>();
    let resolved =
        (!resolved_values.is_empty()).then(|| resolved_values.iter().all(|value| *value));
    let file = first_position.and_then(|position| {
        position
            .new_path
            .clone()
            .or_else(|| position.old_path.clone())
    });
    // GitLab reports both sides on a single position; whichever line it filled
    // in is the row it draws the discussion on.
    let (line, side) = first_position.map_or((None, None), |position| match position.new_line {
        Some(new_line) => (Some(new_line), Some(ThreadSide::New)),
        None => (
            position.old_line,
            position.old_line.map(|_| ThreadSide::Old),
        ),
    });
    let comments = notes
        .into_iter()
        .map(|note| PrComment {
            author: map_user(note.author),
            body_markdown: note.body,
            created_at: note.created_at,
            url: Some(format!(
                "{}/-/merge_requests/{pr_number}#note_{}",
                ctx.remote.web_base, note.id
            )),
        })
        .collect();
    Some(CommentThread {
        id: discussion.id,
        resolved,
        // GitLab drops `position` from notes whose diff was rewritten, so a
        // thread that still carries one is by definition still current.
        outdated: false,
        file,
        line,
        side,
        comments,
    })
}

fn map_user(user: GitLabUser) -> ForgeUser {
    ForgeUser {
        username: user.username,
        display_name: user.name,
        avatar_url: user.avatar_url,
    }
}

fn gitlab_ci_state(status: &str) -> CiState {
    match status {
        "success" | "skipped" | "manual" => CiState::Passing,
        "failed" | "canceled" => CiState::Failing,
        "created" | "waiting_for_resource" | "preparing" | "pending" | "running" | "scheduled" => {
            CiState::Running
        }
        _ => CiState::Running,
    }
}

#[derive(Deserialize)]
struct GitLabMergeRequest {
    iid: u64,
    title: String,
    description: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    #[serde(default = "default_opened_state")]
    state: String,
    web_url: String,
    source_branch: String,
    target_branch: String,
    sha: Option<String>,
    author: GitLabUser,
    #[serde(default)]
    reviewers: Vec<GitLabUser>,
    updated_at: String,
}

fn default_opened_state() -> String {
    "opened".into()
}

#[derive(Clone, Deserialize)]
struct GitLabUser {
    username: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GitLabPipeline {
    id: u64,
    status: String,
    web_url: Option<String>,
}

#[derive(Deserialize)]
struct GitLabJob {
    name: String,
    status: String,
    web_url: Option<String>,
}

#[derive(Deserialize)]
struct GitLabDiscussion {
    id: String,
    #[serde(default)]
    notes: Vec<GitLabNote>,
}

#[derive(Deserialize)]
struct GitLabNote {
    id: u64,
    body: String,
    author: GitLabUser,
    created_at: String,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    resolvable: bool,
    resolved: Option<bool>,
    position: Option<GitLabPosition>,
}

#[derive(Deserialize)]
struct GitLabPosition {
    new_path: Option<String>,
    old_path: Option<String>,
    new_line: Option<u64>,
    old_line: Option<u64>,
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::domain::git::forge::test_support::{context, fixture, json_fixture_server};
    use crate::domain::git::host::GitHost;

    #[test]
    fn unknown_pipeline_status_is_non_terminal() {
        assert_eq!(gitlab_ci_state("new_future_status"), CiState::Running);
        assert_eq!(gitlab_ci_state("failed"), CiState::Failing);
        assert_eq!(gitlab_ci_state("success"), CiState::Passing);
    }

    #[test]
    fn maps_terminal_merge_request_states() {
        assert_eq!(gitlab_pr_state("merged", false), PrState::Merged);
        assert_eq!(gitlab_pr_state("closed", false), PrState::Closed);
    }

    #[tokio::test]
    async fn list_open_prs_uses_iid_and_maps_recorded_fixture() {
        let mut routes = HashMap::new();
        routes.insert(
            "/projects/acme%2Frepo/merge_requests".into(),
            fixture("gitlab_merge_requests"),
        );
        let context = context(json_fixture_server(routes).await, GitHost::GitLab);

        let pulls = GitLabProvider
            .list_open_prs(&context)
            .await
            .expect("GitLab fixture maps");

        assert_eq!(pulls.len(), 1);
        assert_eq!(pulls[0].number, 23);
        assert_eq!(pulls[0].state, PrState::Draft);
        assert_eq!(pulls[0].pr_label, "Merge request");
    }
}
