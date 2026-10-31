use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::http::ForgeHttp;
use super::merging::{MergeCommand, PrMergeResponse, PrMergeStatus};
pub use super::snapshot::{BranchPr, PrStatusSnapshot};
use crate::domain::git::host::{GitHost, RemoteInfo};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

impl PrState {
    /// Merged or closed: nothing will change it again.
    pub fn is_closed(self) -> bool {
        matches!(self, Self::Merged | Self::Closed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    Pending,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ForgeUser {
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub body_markdown: String,
    pub state: PrState,
    pub url: String,
    pub source_branch: String,
    pub target_branch: String,
    pub head_sha: String,
    pub review_state: ReviewState,
    pub author: ForgeUser,
    pub updated_at: String,
    /// Provider-neutral display noun. Values are currently `Pull request` and
    /// `Merge request` — spelled out, because the abbreviations read as jargon
    /// in the UI surfaces that show them (Git sub-tab, sidebar menu, header).
    pub pr_label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CiState {
    None,
    Running,
    Passing,
    Failing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CiCheck {
    pub name: String,
    pub state: CiState,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CiRollup {
    pub state: CiState,
    pub checks: Vec<CiCheck>,
}

impl CiRollup {
    pub fn from_checks(checks: Vec<CiCheck>) -> Self {
        let state = if checks.is_empty() {
            CiState::None
        } else if checks.iter().any(|check| check.state == CiState::Failing) {
            CiState::Failing
        } else if checks.iter().any(|check| check.state == CiState::Running) {
            CiState::Running
        } else {
            CiState::Passing
        };
        Self { state, checks }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PrComment {
    pub author: ForgeUser,
    pub body_markdown: String,
    pub created_at: String,
    pub url: Option<String>,
}

/// Which side of a diff a review thread's `line` counts on. Mirrors GitHub's
/// `LEFT`/`RIGHT`, GitLab's `old_line`/`new_line`, and Bitbucket's
/// `inline.from`/`inline.to`, so the desktop diff can anchor a remote thread to
/// the same row the forge shows it on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadSide {
    Old,
    New,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CommentThread {
    pub id: String,
    /// `None` when the forge has no notion of resolution for this thread (a
    /// top-level PR comment, or a GitLab note nobody marked resolvable). Only
    /// `Some(false)` means "the forge says this is still open".
    pub resolved: Option<bool>,
    /// The thread is pinned to a revision that has since been rewritten, so its
    /// file/line no longer point at the current diff.
    pub outdated: bool,
    pub file: Option<String>,
    pub line: Option<u64>,
    pub side: Option<ThreadSide>,
    pub comments: Vec<PrComment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PrCommentsResponse {
    pub feature_id: i64,
    pub threads: Vec<CommentThread>,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ForgeAuthSource {
    Stored,
    Cli,
}

#[derive(Debug, Clone)]
pub struct ForgeCredentials {
    pub token: String,
    pub username: Option<String>,
    pub source: ForgeAuthSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ForgeHostConfig {
    pub kind: GitHost,
    pub api_base_url: Option<String>,
    #[serde(default)]
    pub use_cli_auth: bool,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ForgeAuthStatus {
    pub hostname: String,
    pub kind: GitHost,
    pub api_base_url: Option<String>,
    /// Whether an explicit token is persisted in the owner-only forge secret file.
    pub token_present: bool,
    pub source: Option<ForgeAuthSource>,
    pub validated_user: Option<ForgeUser>,
    pub error: Option<String>,
    pub use_cli_auth: bool,
    /// Whether this host kind supports opt-in token reuse from an installed CLI.
    pub cli_auth_available: bool,
    /// Whether manual API-token authentication also requires a username.
    pub username_required: bool,
    pub username: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ForgeTokenRequest {
    pub hostname: String,
    pub kind: GitHost,
    pub api_base_url: Option<String>,
    /// Manual API token. Omit when opting into `gh` / `glab` CLI reuse.
    pub token: Option<String>,
    /// Bitbucket Cloud API-token username (normally the Atlassian account email).
    pub username: Option<String>,
    #[serde(default)]
    pub use_cli_auth: bool,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ForgeTokenDeleteParams {
    pub hostname: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ForgeTokenDeleteResponse {
    pub deleted: bool,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct FeaturePrParams {
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct PrCommentsParams {
    pub feature_id: i64,
    /// One of the conversation's proposals (the current branch's or another
    /// branch's); the current branch's when absent.
    #[serde(default)]
    pub pr_number: Option<u64>,
}

#[derive(Clone)]
pub struct ForgeContext {
    pub remote: RemoteInfo,
    pub api_base_url: String,
    pub credentials: ForgeCredentials,
    pub http: Arc<ForgeHttp>,
}

#[derive(Clone)]
pub struct ForgeAuthContext {
    pub api_base_url: String,
    pub credentials: ForgeCredentials,
    pub http: Arc<ForgeHttp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeError {
    Authentication(String),
    Configuration(String),
    Http(String),
    RateLimited(String),
    Response(String),
    /// The forge understood a write and declined it — not mergeable, head
    /// moved, branch protected. Carries the forge's own explanation.
    Refused(String),
}

impl ForgeError {
    /// Whether the user has to change something in Settings before this call
    /// can ever succeed — an expired token, an unsupported CLI, a remote whose
    /// provider was never chosen.
    ///
    /// Same partition as [`forge_to_app_error`](super::auth::forge_to_app_error):
    /// the two variants that answer a request with 4xx are exactly the ones a
    /// retry will not fix.
    pub fn is_setup_failure(&self) -> bool {
        matches!(self, Self::Authentication(_) | Self::Configuration(_))
    }
}

impl fmt::Display for ForgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Authentication(message)
            | Self::Configuration(message)
            | Self::Http(message)
            | Self::RateLimited(message)
            | Self::Response(message)
            | Self::Refused(message) => message,
        };
        f.write_str(message)
    }
}

impl std::error::Error for ForgeError {}

#[async_trait]
pub trait ForgeProvider: Send + Sync {
    async fn list_open_prs(&self, ctx: &ForgeContext) -> Result<Vec<PrSummary>, ForgeError>;
    async fn get_pr(&self, ctx: &ForgeContext, pr_number: u64) -> Result<PrSummary, ForgeError>;
    async fn ci_rollup(&self, ctx: &ForgeContext, pr: &PrSummary) -> Result<CiRollup, ForgeError>;
    async fn comments(
        &self,
        ctx: &ForgeContext,
        pr_number: u64,
    ) -> Result<Vec<CommentThread>, ForgeError>;
    async fn validate_token(&self, ctx: &ForgeAuthContext) -> Result<ForgeUser, ForgeError>;
    /// Approvals, mergeability, and what the viewer can do to land `pr`.
    async fn merge_status(
        &self,
        ctx: &ForgeContext,
        pr: &PrSummary,
    ) -> Result<PrMergeStatus, ForgeError>;
    /// Carries out a command already checked against `status`.
    async fn merge(
        &self,
        ctx: &ForgeContext,
        pr: &PrSummary,
        command: &MergeCommand,
        status: &PrMergeStatus,
    ) -> Result<PrMergeResponse, ForgeError>;
    /// Takes `pr` off auto-merge or out of the merge queue / train.
    async fn cancel_merge(&self, ctx: &ForgeContext, pr: &PrSummary) -> Result<(), ForgeError>;
}

pub fn proposal_noun(host: GitHost) -> &'static str {
    match host {
        GitHost::GitLab => "Merge request",
        GitHost::GitHub | GitHost::Bitbucket | GitHost::Other => "Pull request",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_poll_of_unchanged_state_is_not_worth_broadcasting() {
        let first = PrStatusSnapshot::unpolled(7, None, false);
        let second = PrStatusSnapshot::unpolled(7, None, false);

        // `fetched_at` advances on every poll and must not count, or the
        // sidebar would re-render once a minute forever.
        assert_ne!(first.fetched_at, 0);
        assert!(first.semantic_eq(&second));
    }

    #[test]
    fn only_failures_the_user_can_fix_in_settings_ask_them_to_connect() {
        // Drives the PR pane's choice between an onboarding prompt and a plain
        // error, so a misfiled variant would tell the user to reconnect a forge
        // that is merely rate-limited.
        assert!(ForgeError::Authentication("token expired".into()).is_setup_failure());
        assert!(ForgeError::Configuration("choose a provider".into()).is_setup_failure());
        assert!(!ForgeError::RateLimited("slow down".into()).is_setup_failure());
        assert!(!ForgeError::Http("connection reset".into()).is_setup_failure());
        assert!(!ForgeError::Response("unexpected body".into()).is_setup_failure());
    }

    #[test]
    fn a_setup_prompt_and_a_transient_error_are_different_snapshots() {
        // Both have no PR and an error string; only `setup_required` separates
        // "connect your forge" from "the forge is having a bad day", so it has
        // to reach the sidebar rather than being collapsed as unchanged.
        let needs_setup = PrStatusSnapshot::unpolled(7, Some("add a token".into()), true);
        let transient = PrStatusSnapshot::unpolled(7, Some("add a token".into()), false);

        assert!(!needs_setup.semantic_eq(&transient));
    }

    #[test]
    fn a_thread_count_change_alone_still_reaches_the_sidebar() {
        // The count is the only thing that moves when a reviewer resolves the
        // last thread on an already-green PR. If `semantic_eq` ignored it the
        // chip would keep saying "unresolved" until something else changed.
        let resolved = PrStatusSnapshot {
            unresolved_threads: Some(0),
            ..PrStatusSnapshot::unpolled(7, None, false)
        };
        let outstanding = PrStatusSnapshot {
            unresolved_threads: Some(2),
            ..PrStatusSnapshot::unpolled(7, None, false)
        };

        assert!(!resolved.semantic_eq(&outstanding));
        assert!(!resolved.semantic_eq(&PrStatusSnapshot::unpolled(7, None, false)));
    }
}
