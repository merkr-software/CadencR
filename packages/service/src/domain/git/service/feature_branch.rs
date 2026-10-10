//! Resolution of "the branch this feature is bound to".
//!
//! Three provisioning modes record their branch differently, and every git
//! surface that answers "what branch is this conversation working on?" has to
//! agree on the order:
//!
//! 1. `worktree_branch` — written when a worktree is provisioned. It survives
//!    the worktree being removed (only `worktree_path` is deleted), which is
//!    deliberate: a deleted worktree whose branch still exists must keep
//!    reporting its own pull request, not the project checkout's.
//! 2. `feature_branch` — written by the worktree-free "From branch" flow. The
//!    branch is checked out in the project directory itself, so as soon as the
//!    user (or another feature) moves that checkout, the live HEAD stops being
//!    this conversation's branch.
//! 3. The resolved path's current branch — the "On branch" mode, where the
//!    feature genuinely follows whatever the project has checked out.
//!
//! Without step 2 the forge poller matched pull requests against the project
//! checkout's HEAD — usually `main` — for every "From branch" feature.

use std::path::Path;

use sqlx::SqlitePool;

use super::{SETTING_FEATURE_BRANCH, SETTING_WORKTREE_BRANCH};
use crate::domain::git::refs::normalize_branch_identity;
use crate::domain::git::{commands, repository, workflow_service};
use crate::error::AppError;

pub const HEAD_REVISION: &str = "HEAD";

/// A branch identity we are willing to hand out, or `None` for anything that
/// isn't one: blank settings, a bare `refs/heads/` prefix, the literal `HEAD`
/// that `git rev-parse --abbrev-ref` reports for a detached checkout, and any
/// value git would read as a flag (these reach `git log` as positionals).
fn branch_identity(value: &str) -> Option<String> {
    let branch = normalize_branch_identity(value);
    if branch.is_empty() || branch == HEAD_REVISION || branch.starts_with('-') {
        return None;
    }
    Some(branch.to_string())
}

/// The branch recorded for `feature_id` by whichever flow provisioned it, with
/// no fallback to the live checkout.
///
/// An unusable recorded value falls through to the next key rather than
/// resolving to nothing — a corrupt `worktree_branch` shouldn't blind a
/// feature that also recorded a `feature_branch`.
pub(super) async fn recorded_feature_branch(
    read_pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    for key in [SETTING_WORKTREE_BRANCH, SETTING_FEATURE_BRANCH] {
        let recorded = repository::get_feature_setting(read_pool, feature_id, key).await?;
        if let Some(branch) = recorded.as_deref().and_then(branch_identity) {
            return Ok(Some(branch));
        }
    }
    Ok(None)
}

/// The branch bound to `feature_id`, or `None` when nothing usable is recorded
/// and `path` has no branch checked out (detached HEAD, fresh repo).
pub async fn resolve_feature_branch(
    read_pool: &SqlitePool,
    feature_id: i64,
    path: &Path,
) -> Result<Option<String>, AppError> {
    if let Some(branch) = recorded_feature_branch(read_pool, feature_id).await? {
        return Ok(Some(branch));
    }
    checked_out_branch(path).await
}

async fn checked_out_branch(path: &Path) -> Result<Option<String>, AppError> {
    Ok(commands::get_current_branch(path)
        .await?
        .as_deref()
        .and_then(branch_identity))
}

/// The branch a feature is bound to plus the revision its history views must
/// read — resolved together because the two answers share the settings lookup
/// and the `git rev-parse` of the live checkout.
pub struct FeatureScope {
    /// The branch this conversation works on, for labels and comparisons.
    pub branch: Option<String>,
    /// What to hand `git log` / `git rev-list` for this feature.
    pub revision: String,
}

/// Resolve [`FeatureScope`] with one settings pass and one `git rev-parse`.
///
/// `HEAD` is only the right revision while the bound branch is the one checked
/// out at `path`. A feature whose worktree was removed, or a worktree-free
/// "From branch" feature whose project checkout has since moved on, is bound to
/// a branch that still exists as a ref but is no longer `HEAD` — reading `HEAD`
/// there silently reports another branch's commits as this conversation's.
///
/// Falls back to `HEAD` when the bound branch no longer exists locally (the
/// user deleted it), since a missing ref would fail every git call instead.
pub async fn resolve_feature_scope(
    read_pool: &SqlitePool,
    feature_id: i64,
    path: &Path,
) -> Result<FeatureScope, AppError> {
    let recorded = recorded_feature_branch(read_pool, feature_id).await?;
    let checked_out = checked_out_branch(path).await?;
    let branch = recorded.or_else(|| checked_out.clone());
    let head_scope = FeatureScope {
        branch: branch.clone(),
        revision: HEAD_REVISION.to_string(),
    };
    let Some(bound) = branch else {
        return Ok(head_scope);
    };
    if checked_out.as_deref() == Some(bound.as_str())
        || !workflow_service::local_branch_exists(path, &bound).await
    {
        return Ok(head_scope);
    }
    Ok(FeatureScope {
        revision: bound.clone(),
        branch: Some(bound),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::service::test_support::setup_diff_refs_schema;

    async fn run_git(dir: &Path, args: &[&str]) {
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .await
            .unwrap();
    }

    async fn init_repo(dir: &Path) {
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["commit", "--allow-empty", "-q", "-m", "init"],
        ] {
            run_git(dir, &args).await;
        }
    }

    #[tokio::test]
    async fn prefers_the_worktree_branch_over_the_checked_out_branch() {
        // The worktree-removed case: `worktree_path` is gone so callers resolve
        // the project directory, but the recorded branch must still win.
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "feature/removed-wt")
            .await
            .unwrap();

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("feature/removed-wt"));
    }

    #[tokio::test]
    async fn falls_back_to_the_project_branch_recorded_by_the_from_branch_flow() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(
            &pool,
            1,
            SETTING_FEATURE_BRANCH,
            "refs/heads/feature/forked",
        )
        .await
        .unwrap();

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("feature/forked"));
    }

    #[tokio::test]
    async fn falls_back_to_the_live_branch_when_nothing_is_recorded() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn falls_through_a_recorded_value_that_normalizes_to_nothing() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "refs/heads/")
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, SETTING_FEATURE_BRANCH, "feature/real")
            .await
            .unwrap();

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("feature/real"));
    }

    #[tokio::test]
    async fn reports_no_branch_for_a_detached_head() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        run_git(repo.path(), &["checkout", "-q", "--detach"]).await;

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        // `rev-parse --abbrev-ref` says "HEAD" here, which is not a branch.
        assert_eq!(branch, None);
    }

    #[tokio::test]
    async fn reads_head_while_the_bound_branch_is_the_one_checked_out() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "main")
            .await
            .unwrap();

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(scope.branch.as_deref(), Some("main"));
        assert_eq!(scope.revision, HEAD_REVISION);
    }

    #[tokio::test]
    async fn reads_the_bound_branch_once_the_checkout_moves_away() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        run_git(repo.path(), &["branch", "feature/left-behind"]).await;
        repository::set_feature_setting(&pool, 1, SETTING_FEATURE_BRANCH, "feature/left-behind")
            .await
            .unwrap();

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(scope.branch.as_deref(), Some("feature/left-behind"));
        assert_eq!(scope.revision, "feature/left-behind");
    }

    #[tokio::test]
    async fn falls_back_to_head_when_the_bound_branch_was_deleted() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "feature/gone")
            .await
            .unwrap();

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        // Reading a ref that no longer exists would fail every git call, but the
        // label still belongs to the branch the feature was provisioned with.
        assert_eq!(scope.branch.as_deref(), Some("feature/gone"));
        assert_eq!(scope.revision, HEAD_REVISION);
    }

    #[tokio::test]
    async fn refuses_a_recorded_branch_git_would_read_as_a_flag() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "--all")
            .await
            .unwrap();

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        // It reaches `git log` as a positional; falling through to the live
        // branch is the only safe reading.
        assert_eq!(scope.branch.as_deref(), Some("main"));
        assert_eq!(scope.revision, HEAD_REVISION);
    }

    #[tokio::test]
    async fn reports_no_branch_and_head_for_a_detached_checkout_with_nothing_recorded() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        run_git(repo.path(), &["checkout", "-q", "--detach"]).await;

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(scope.branch, None);
        assert_eq!(scope.revision, HEAD_REVISION);
    }

    #[tokio::test]
    async fn ignores_a_blank_recorded_branch() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "   ")
            .await
            .unwrap();

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("main"));
    }
}
