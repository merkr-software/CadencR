//! Wire types for the merge-status GraphQL query and the merge mutations.

use serde::Deserialize;

use crate::domain::git::forge::provider::{ForgeError, ForgeUser};

pub(super) const MERGE_STATUS_QUERY: &str = "
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    deleteBranchOnMerge
    viewerDefaultMergeMethod
    pullRequest(number: $number) {
      id
      state
      isDraft
      isCrossRepository
      headRefName
      headRefOid
      mergeable
      mergeStateStatus
      reviewDecision
      isMergeQueueEnabled
      isInMergeQueue
      viewerCanEnableAutoMerge
      viewerCanDisableAutoMerge
      mergeQueueEntry { position enqueuer { login avatarUrl ... on User { name } } }
      autoMergeRequest { mergeMethod enabledBy { login avatarUrl ... on User { name } } }
      baseRef {
        refUpdateRule { requiredApprovingReviewCount }
        branchProtectionRule { requiredApprovingReviewCount }
      }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      latestOpinionatedReviews(first: 50, writersOnly: true) {
        nodes { state author { login avatarUrl ... on User { name } } }
      }
      reviewRequests(first: 50) {
        nodes {
          requestedReviewer {
            ... on User { login name avatarUrl }
            ... on Bot { login avatarUrl }
            ... on Team { slug name avatarUrl }
          }
        }
      }
    }
  }
}
";

#[derive(Deserialize)]
pub(super) struct GraphQlEnvelope<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphQlMessage>,
}

#[derive(Deserialize)]
struct GraphQlMessage {
    message: String,
}

impl<T> GraphQlEnvelope<T> {
    /// GraphQL answers `200 OK` for failures. A read keeps whatever data came
    /// back: a field the token may not see (a team reviewer without
    /// `read:org`, say) is nulled with an error beside it, and the status
    /// degrades to "unknown" there rather than disappearing. The first error
    /// rides along for when the nulled field was one the caller needs.
    pub(super) fn into_read(self) -> Result<(T, Option<String>), ForgeError> {
        let error = self.errors.into_iter().next().map(|error| error.message);
        match (self.data, error) {
            (Some(data), error) => Ok((data, error)),
            (None, Some(error)) => Err(ForgeError::Response(format!(
                "GitHub could not read merge status: {error}"
            ))),
            (None, None) => Err(ForgeError::Response("GitHub returned no data".into())),
        }
    }

    /// A mutation's errors are the forge declining the write.
    pub(super) fn into_write(self) -> Result<Option<T>, ForgeError> {
        match self.errors.into_iter().next() {
            Some(error) => Err(ForgeError::Refused(error.message)),
            None => Ok(self.data),
        }
    }
}

#[derive(Deserialize)]
pub(super) struct StatusData {
    pub repository: Option<Repository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Repository {
    pub viewer_permission: Option<String>,
    pub merge_commit_allowed: bool,
    pub squash_merge_allowed: bool,
    pub rebase_merge_allowed: bool,
    pub delete_branch_on_merge: bool,
    pub viewer_default_merge_method: Option<String>,
    pub pull_request: Option<PullRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PullRequest {
    pub id: String,
    pub state: String,
    pub is_draft: bool,
    pub is_cross_repository: bool,
    pub head_ref_name: String,
    pub head_ref_oid: String,
    pub mergeable: String,
    pub merge_state_status: String,
    pub review_decision: Option<String>,
    pub is_merge_queue_enabled: bool,
    pub is_in_merge_queue: bool,
    pub viewer_can_enable_auto_merge: bool,
    pub viewer_can_disable_auto_merge: bool,
    pub merge_queue_entry: Option<QueueEntry>,
    pub auto_merge_request: Option<AutoMergeRequest>,
    pub base_ref: Option<BaseRef>,
    pub commits: Connection<CommitNode>,
    pub latest_opinionated_reviews: Connection<Review>,
    pub review_requests: Connection<ReviewRequest>,
}

#[derive(Deserialize)]
pub(super) struct Connection<T> {
    #[serde(default = "Vec::new")]
    pub nodes: Vec<Option<T>>,
}

#[derive(Deserialize)]
pub(super) struct QueueEntry {
    pub position: Option<u32>,
    pub enqueuer: Option<Actor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AutoMergeRequest {
    pub merge_method: Option<String>,
    pub enabled_by: Option<Actor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BaseRef {
    pub ref_update_rule: Option<ApprovalRule>,
    pub branch_protection_rule: Option<ApprovalRule>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApprovalRule {
    pub required_approving_review_count: Option<u32>,
}

#[derive(Deserialize)]
pub(super) struct CommitNode {
    pub commit: Commit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Commit {
    pub status_check_rollup: Option<StatusRollup>,
}

#[derive(Deserialize)]
pub(super) struct StatusRollup {
    pub state: String,
}

#[derive(Deserialize)]
pub(super) struct Review {
    pub state: String,
    pub author: Option<Actor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReviewRequest {
    pub requested_reviewer: Option<Actor>,
}

/// A user, bot, or team. Teams have a `slug` where the others have a `login`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Actor {
    pub login: Option<String>,
    pub slug: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

impl Actor {
    pub(super) fn into_user(self) -> Option<ForgeUser> {
        Some(ForgeUser {
            username: self.login.or(self.slug)?,
            display_name: self.name,
            avatar_url: self.avatar_url,
        })
    }
}
