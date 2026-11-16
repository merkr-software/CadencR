use async_trait::async_trait;
use serde::Deserialize;

use super::merging::{MergeCommand, PrMergeResponse, PrMergeStatus};
use super::provider::{
    proposal_noun, CiCheck, CiRollup, CiState, CommentThread, ForgeAuthContext, ForgeContext,
    ForgeError, ForgeProvider, ForgeUser, PrState, PrSummary, ReviewState,
};

mod comments;
mod merge;

pub struct BitbucketProvider;

#[async_trait]
impl ForgeProvider for BitbucketProvider {
    async fn list_open_prs(&self, ctx: &ForgeContext) -> Result<Vec<PrSummary>, ForgeError> {
        let url = format!(
            "{}/repositories/{}/{}/pullrequests?q=state%3D%22OPEN%22&pagelen=50&fields=values.id,values.title,values.description,values.state,values.draft,values.links,values.source,values.destination,values.author,values.participants,values.updated_on",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repo
        );
        let response: BitbucketPage<BitbucketPull> =
            ctx.http.request_json(bitbucket_get(ctx, &url)?).await?;
        Ok(response
            .values
            .into_iter()
            .map(|pull| map_pull(pull, ctx.remote.host))
            .collect())
    }

    async fn get_pr(&self, ctx: &ForgeContext, pr_number: u64) -> Result<PrSummary, ForgeError> {
        let url = format!(
            "{}/repositories/{}/{}/pullrequests/{pr_number}",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repo
        );
        let pull: BitbucketPull = ctx.http.request_json(bitbucket_get(ctx, &url)?).await?;
        Ok(map_pull(pull, ctx.remote.host))
    }

    async fn ci_rollup(&self, ctx: &ForgeContext, pr: &PrSummary) -> Result<CiRollup, ForgeError> {
        let url = format!(
            "{}/repositories/{}/{}/commit/{}/statuses?pagelen=100",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repo, pr.head_sha
        );
        let response: BitbucketPage<BitbucketBuildStatus> =
            ctx.http.request_json(bitbucket_get(ctx, &url)?).await?;
        let checks = response
            .values
            .into_iter()
            .map(|status| CiCheck {
                name: status
                    .name
                    .or(status.key)
                    .unwrap_or_else(|| "Pipeline".into()),
                state: bitbucket_ci_state(&status.state),
                url: status.url,
            })
            .collect();
        Ok(CiRollup::from_checks(checks))
    }

    async fn comments(
        &self,
        ctx: &ForgeContext,
        pr_number: u64,
    ) -> Result<Vec<CommentThread>, ForgeError> {
        comments::fetch(ctx, pr_number).await
    }

    async fn validate_token(&self, ctx: &ForgeAuthContext) -> Result<ForgeUser, ForgeError> {
        let url = format!("{}/user", ctx.api_base_url);
        let username = ctx
            .credentials
            .username
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ForgeError::Configuration(
                    "Bitbucket API tokens require the Atlassian account email as username".into(),
                )
            })?;
        let request = ctx
            .http
            .get(&url)
            .basic_auth(username, Some(&ctx.credentials.token));
        let user: BitbucketUser = ctx.http.request_json(request).await?;
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

    async fn cancel_merge(&self, _ctx: &ForgeContext, _pr: &PrSummary) -> Result<(), ForgeError> {
        Err(ForgeError::Refused(
            "Bitbucket has no auto-merge or merge queue to cancel".into(),
        ))
    }
}

pub(super) fn bitbucket_get(
    ctx: &ForgeContext,
    url: &str,
) -> Result<reqwest::RequestBuilder, ForgeError> {
    authorize(ctx, ctx.http.get(url))
}

/// Bitbucket API tokens authenticate as HTTP basic with the account email.
fn authorize(
    ctx: &ForgeContext,
    builder: reqwest::RequestBuilder,
) -> Result<reqwest::RequestBuilder, ForgeError> {
    let username = ctx
        .credentials
        .username
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ForgeError::Configuration(
                "Bitbucket API tokens require the Atlassian account email as username".into(),
            )
        })?;
    Ok(builder.basic_auth(username, Some(&ctx.credentials.token)))
}

fn map_pull(pull: BitbucketPull, host: crate::domain::git::host::GitHost) -> PrSummary {
    let state = if pull.draft {
        PrState::Draft
    } else {
        match pull.state.as_str() {
            "MERGED" => PrState::Merged,
            "DECLINED" | "SUPERSEDED" => PrState::Closed,
            _ => PrState::Open,
        }
    };
    let review_state = if pull
        .participants
        .iter()
        .any(|participant| participant.state.as_deref() == Some("changes_requested"))
    {
        ReviewState::ChangesRequested
    } else if pull
        .participants
        .iter()
        .any(|participant| participant.approved)
    {
        ReviewState::Approved
    } else if pull.participants.is_empty() {
        ReviewState::None
    } else {
        ReviewState::Pending
    };
    PrSummary {
        number: pull.id,
        title: pull.title,
        body_markdown: pull.description.unwrap_or_default(),
        state,
        url: pull.links.html.map(|link| link.href).unwrap_or_default(),
        source_branch: pull.source.branch.name,
        target_branch: pull.destination.branch.name,
        head_sha: pull.source.commit.hash,
        review_state,
        author: map_user(pull.author),
        updated_at: pull.updated_on,
        pr_label: proposal_noun(host).into(),
    }
}

pub(super) fn map_user(user: BitbucketUser) -> ForgeUser {
    ForgeUser {
        username: user
            .nickname
            .or(user.username)
            .unwrap_or_else(|| user.display_name.clone()),
        display_name: Some(user.display_name),
        avatar_url: user
            .links
            .and_then(|links| links.avatar)
            .map(|link| link.href),
    }
}

fn bitbucket_ci_state(state: &str) -> CiState {
    match state {
        "SUCCESSFUL" => CiState::Passing,
        "FAILED" | "STOPPED" => CiState::Failing,
        _ => CiState::Running,
    }
}

#[derive(Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
pub(super) struct BitbucketPage<T> {
    #[serde(default)]
    pub(super) values: Vec<T>,
}

#[derive(Deserialize)]
struct BitbucketPull {
    id: u64,
    title: String,
    description: Option<String>,
    state: String,
    #[serde(default)]
    draft: bool,
    links: BitbucketLinks,
    source: BitbucketPullSide,
    destination: BitbucketPullSide,
    author: BitbucketUser,
    #[serde(default)]
    participants: Vec<BitbucketParticipant>,
    updated_on: String,
}

#[derive(Deserialize)]
struct BitbucketParticipant {
    #[serde(default)]
    approved: bool,
    state: Option<String>,
}

#[derive(Deserialize)]
struct BitbucketPullSide {
    branch: BitbucketBranch,
    commit: BitbucketCommit,
}

#[derive(Deserialize)]
struct BitbucketBranch {
    name: String,
}

#[derive(Deserialize)]
struct BitbucketCommit {
    hash: String,
}

#[derive(Deserialize)]
pub(super) struct BitbucketUser {
    display_name: String,
    nickname: Option<String>,
    username: Option<String>,
    links: Option<BitbucketLinks>,
}

#[derive(Deserialize)]
pub(super) struct BitbucketLinks {
    pub(super) html: Option<BitbucketLink>,
    avatar: Option<BitbucketLink>,
}

#[derive(Deserialize)]
pub(super) struct BitbucketLink {
    pub(super) href: String,
}

#[derive(Deserialize)]
struct BitbucketBuildStatus {
    state: String,
    name: Option<String>,
    key: Option<String>,
    url: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::domain::git::forge::test_support::{context, fixture, json_fixture_server};
    use crate::domain::git::host::GitHost;

    #[test]
    fn unknown_bitbucket_status_remains_running() {
        assert_eq!(bitbucket_ci_state("PAUSED"), CiState::Running);
        assert_eq!(bitbucket_ci_state("FAILED"), CiState::Failing);
    }

    #[tokio::test]
    async fn list_open_prs_maps_recorded_fixture_with_api_token_auth() {
        let mut routes = HashMap::new();
        routes.insert(
            "/repositories/acme/repo/pullrequests".into(),
            fixture("bitbucket_pullrequests"),
        );
        let context = context(json_fixture_server(routes).await, GitHost::Bitbucket);

        let pulls = BitbucketProvider
            .list_open_prs(&context)
            .await
            .expect("Bitbucket fixture maps");

        assert_eq!(pulls.len(), 1);
        assert_eq!(pulls[0].number, 9);
        assert_eq!(pulls[0].head_sha, "b".repeat(40));
        assert_eq!(pulls[0].pr_label, "Pull request");
    }
}
