//! `POST /api/git/merge` — merge the current feature branch into the
//! configured target branch, always using a local target branch.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::models::MergeResult;
use crate::domain::git::repository;
use crate::domain::git::service::resolve_feature_git_path;
use crate::domain::workspace;
use crate::error::AppError;
use crate::shared::git_cli::run_git_safe_refs;

use super::merge_runner::{
    attach_cleanup_problem, build_failure_result, inspect_failed_merge, invoke_merge,
    read_original_head, restore_original_head, roll_back_failed_merge, MergeOutcome,
};
use super::{
    broadcast_after_write, local_branch_exists, mutation_guard_error, remote_branch_exists,
    resolve_target_branch,
};

const SETTING_GIT_MERGE_MODE: &str = "git_merge_mode";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeMode {
    Default,
    NoFf,
    FfOnly,
    Squash,
}

impl MergeMode {
    /// Visible to sibling modules in `workflow_service` so the merge runner
    /// can reuse the same flag mapping.
    pub(super) fn flags(self) -> &'static [&'static str] {
        match self {
            Self::Default => &["--no-edit"],
            Self::NoFf => &["--no-ff", "--no-edit"],
            Self::FfOnly => &["--ff-only"],
            Self::Squash => &["--squash"],
        }
    }

    fn as_setting(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::NoFf => "no_ff",
            Self::FfOnly => "ff_only",
            Self::Squash => "squash",
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct MergeFeatureBranchBody {
    pub feature_id: i64,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub mode: Option<MergeMode>,
    #[serde(default)]
    pub save_as_default: bool,
}

pub async fn merge_feature_branch(
    state: &AppState,
    body: MergeFeatureBranchBody,
) -> Result<MergeResult, AppError> {
    let feature_id = body.feature_id;
    let mode = body.mode.unwrap_or(MergeMode::NoFf);
    let source_path = resolve_feature_git_path(state, feature_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id} has no git path")))?;
    let source_repo = Path::new(&source_path);

    // Merging consumes the committed branch ref only. Uncommitted files in the
    // source worktree are intentionally allowed and remain unmerged there.
    //
    // See `resolve_feature_branch` for which branch a feature is bound to.
    let source_branch = crate::domain::git::service::resolve_feature_branch(
        &state.read_pool,
        feature_id,
        source_repo,
    )
    .await?
    .ok_or_else(|| AppError::BadRequest("source worktree is in detached HEAD".into()))?;
    let project_id = resolve_project_id(state, feature_id, body.project_id).await?;
    let project_path = repository::get_project_path(&state.read_pool, project_id).await?;
    let project_repo = Path::new(&project_path);
    let configured_target = resolve_target_branch(state, feature_id, source_repo).await?;
    let target_branch = ensure_local_target(project_repo, &configured_target).await?;

    if source_branch == target_branch {
        return Err(AppError::BadRequest(
            "source branch already matches target branch".into(),
        ));
    }

    let merge_repo = target_worktree_or_project(project_repo, &target_branch).await?;
    // The whole checkout → merge → rollback → checkout-back sequence mutates
    // this worktree; no other Cadencr Git mutation may interleave with it.
    let permit = state
        .git_mutations
        .try_acquire(&merge_repo)
        .map_err(mutation_guard_error)?;
    // `git merge` exits 0 with "Already up to date" here, which would report a
    // successful merge that changed nothing.
    if commands::is_branch_merged(&merge_repo, &source_branch, &target_branch).await? {
        return Err(AppError::BadRequest(format!(
            "'{source_branch}' has no commits that aren't already in '{target_branch}' — nothing to merge"
        )));
    }
    let result = run_merge(&merge_repo, &source_branch, &target_branch, mode).await?;
    drop(permit);
    if result.success {
        if body.save_as_default {
            workspace::service::set_setting(
                &state.write_pool,
                SETTING_GIT_MERGE_MODE,
                mode.as_setting(),
            )
            .await?;
        }
        broadcast_after_write(state, feature_id).await;
    }
    Ok(result)
}

async fn resolve_project_id(
    state: &AppState,
    feature_id: i64,
    explicit_project_id: Option<i64>,
) -> Result<i64, AppError> {
    if let Some(id) = explicit_project_id {
        return Ok(id);
    }
    repository::get_feature_type_and_project(&state.read_pool, feature_id)
        .await?
        .map(|(project_id, _)| project_id)
        .ok_or_else(|| AppError::NotFound(format!("feature not found: {feature_id}")))
}

async fn ensure_local_target(repo: &Path, target: &str) -> Result<String, AppError> {
    if target.trim().is_empty() || target.starts_with('-') {
        return Err(AppError::BadRequest("target branch is invalid".into()));
    }
    if local_branch_exists(repo, target).await {
        return Ok(target.to_string());
    }
    if remote_branch_exists(repo, target).await {
        let local = target
            .split_once('/')
            .map(|(_, branch)| branch)
            .filter(|branch| !branch.is_empty())
            .ok_or_else(|| AppError::BadRequest(format!("target branch is invalid: {target}")))?;
        if local_branch_exists(repo, local).await {
            return Ok(local.to_string());
        }
        run_git_safe_refs(&["branch"], &[], &[local, target], repo).await?;
        return Ok(local.to_string());
    }
    Err(AppError::BadRequest(format!(
        "target branch '{target}' does not resolve locally or as a remote-tracking ref"
    )))
}

async fn target_worktree_or_project(
    project_repo: &Path,
    target_branch: &str,
) -> Result<PathBuf, AppError> {
    // A failed listing must not turn into "merge in the project root": that
    // would check out the target branch in the wrong worktree.
    let attached = commands::list_worktree_branches(project_repo).await?;
    Ok(attached
        .get(target_branch)
        .cloned()
        .unwrap_or_else(|| project_repo.to_path_buf()))
}

async fn run_merge(
    repo: &Path,
    source_branch: &str,
    target_branch: &str,
    mode: MergeMode,
) -> Result<MergeResult, AppError> {
    ensure_clean(repo, "target branch worktree").await?;
    let original = read_original_head(repo).await?;
    let switched = !original.is_branch(target_branch);
    if switched {
        run_git_safe_refs(&["checkout"], &[], &[target_branch], repo).await?;
    }

    let mut result = match invoke_merge(repo, source_branch, mode).await {
        Ok(MergeOutcome::Succeeded) => MergeResult {
            success: true,
            error: None,
            conflict_files: None,
            warning: None,
        },
        Ok(MergeOutcome::Failed { stdout, stderr }) => {
            match settle_failed_merge(repo, &stdout, &stderr, source_branch, target_branch).await {
                Ok(failure) => failure,
                // Still mid-merge: switching back would carry the half-applied
                // merge onto the original branch, so leave the worktree as is.
                Err(stuck) => return Ok(stuck),
            }
        }
        Err(err) => MergeResult {
            success: false,
            error: Some(err.to_string()),
            conflict_files: None,
            warning: None,
        },
    };

    if switched {
        if let Err(error) = restore_original_head(repo, &original).await {
            // A failing hook can run after Git already moved HEAD, so report
            // where the worktree actually is rather than assuming.
            let now = match read_original_head(repo).await {
                Ok(head) => format!("It is now on {head}."),
                Err(read_error) => format!("Its current HEAD could not be read: {read_error}."),
            };
            attach_cleanup_problem(
                &mut result,
                format!(
                    "Could not switch '{}' back to {original}: {error}. {now}",
                    repo.display()
                ),
            );
        }
    }
    Ok(result)
}

/// Turn a failed `git merge` into its user-facing result and undo whatever it
/// half-applied. `Err` carries the result when the worktree could not be
/// returned to a clean state.
async fn settle_failed_merge(
    repo: &Path,
    stdout: &str,
    stderr: &str,
    source_branch: &str,
    target_branch: &str,
) -> Result<MergeResult, MergeResult> {
    let stuck = |mut failure: MergeResult, problem: String| {
        attach_cleanup_problem(
            &mut failure,
            format!(
                "{problem}; '{}' may still be mid-merge — clean it up (`git merge --abort`, or `git reset --merge` after a squash) before retrying.",
                repo.display()
            ),
        );
        failure
    };
    let state = match inspect_failed_merge(repo).await {
        Ok(state) => state,
        Err(error) => {
            let failure =
                build_failure_result(vec![], stdout, stderr, source_branch, target_branch);
            return Err(stuck(
                failure,
                format!("Inspecting the merge state also failed ({error})"),
            ));
        }
    };
    let rollback = roll_back_failed_merge(repo, &state).await;
    let failure = build_failure_result(
        state.conflict_files,
        stdout,
        stderr,
        source_branch,
        target_branch,
    );
    match rollback {
        Ok(()) => Ok(failure),
        Err(error) => Err(stuck(
            failure,
            format!("Rolling back the merge also failed ({error})"),
        )),
    }
}

async fn ensure_clean(repo: &Path, label: &str) -> Result<(), AppError> {
    if commands::has_uncommitted_changes(repo).await? {
        return Err(AppError::BadRequest(format!(
            "{label} has uncommitted changes"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli::run_git;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_merge_state(project: &Path, source: &Path) -> AppState {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'repo', ?)")
            .bind(project.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, "worktree_path", &source.to_string_lossy())
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, "target_branch", "main")
            .await
            .unwrap();
        AppState::with_pool(pool)
    }

    async fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "test@example.com"][..],
            &["config", "user.name", "Test"][..],
            &["config", "commit.gpgsign", "false"][..],
            &["config", "tag.gpgsign", "false"][..],
        ] {
            run_git(args, repo).await.unwrap();
        }
        tokio::fs::write(repo.join("seed.txt"), "seed\n")
            .await
            .unwrap();
        run_git(&["add", "seed.txt"], repo).await.unwrap();
        run_git(&["commit", "-q", "-m", "seed"], repo)
            .await
            .unwrap();
        dir
    }

    #[tokio::test]
    async fn remote_tracking_target_creates_local_branch() {
        let dir = init_repo().await;
        let repo = dir.path();
        run_git(&["branch", "-M", "trunk"], repo).await.unwrap();
        let head = run_git(&["rev-parse", "HEAD"], repo).await.unwrap();
        run_git(
            &["update-ref", "refs/remotes/origin/main", head.trim()],
            repo,
        )
        .await
        .unwrap();

        let local = ensure_local_target(repo, "origin/main").await.unwrap();

        assert_eq!(local, "main");
        assert!(local_branch_exists(repo, "main").await);
    }

    #[tokio::test]
    async fn local_target_is_used_verbatim() {
        let dir = init_repo().await;
        let repo = dir.path();
        run_git(&["branch", "release"], repo).await.unwrap();

        let local = ensure_local_target(repo, "release").await.unwrap();

        assert_eq!(local, "release");
    }

    /// A `main` repo plus a worktree on `feature/x`. The second dir owns the
    /// worktree and must outlive the test.
    async fn repo_with_feature_worktree() -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
        let dir = init_repo().await;
        run_git(&["branch", "-M", "main"], dir.path())
            .await
            .unwrap();
        let worktree_parent = tempfile::tempdir().unwrap();
        let source = worktree_parent.path().join("feature-x");
        let source_arg = source.to_string_lossy().to_string();
        let args = [
            "worktree",
            "add",
            "-q",
            "-b",
            "feature/x",
            &source_arg,
            "main",
        ];
        run_git(&args, dir.path()).await.unwrap();
        (dir, worktree_parent, source)
    }

    async fn commit_file(repo: &Path, name: &str) {
        tokio::fs::write(repo.join(name), format!("{name}\n"))
            .await
            .unwrap();
        run_git(&["add", name], repo).await.unwrap();
        run_git(&["commit", "-q", "-m", name], repo).await.unwrap();
    }

    async fn merge_into_main(repo: &Path, branch: &str) {
        run_git(&["merge", "-q", "--no-ff", "--no-edit", branch], repo)
            .await
            .unwrap();
    }

    fn merge_body() -> MergeFeatureBranchBody {
        MergeFeatureBranchBody {
            feature_id: 1,
            project_id: Some(1),
            mode: Some(MergeMode::NoFf),
            save_as_default: false,
        }
    }

    #[tokio::test]
    async fn merge_allows_dirty_source_worktree_and_merges_committed_changes() {
        let (dir, _worktree_parent, source) = repo_with_feature_worktree().await;
        let repo = dir.path();
        commit_file(&source, "committed.txt").await;
        tokio::fs::write(source.join("dirty.txt"), "dirty\n")
            .await
            .unwrap();
        let state = setup_merge_state(repo, &source).await;

        let result = merge_feature_branch(&state, merge_body()).await.unwrap();

        assert!(result.success, "{:?}", result.error);
        assert!(repo.join("committed.txt").exists());
        assert!(!repo.join("dirty.txt").exists());
        assert!(source.join("dirty.txt").exists());
    }

    /// The worktree was provisioned on `feature/x` (already merged), then the
    /// agent switched it to `feature/y`. Merging the recorded branch used to
    /// exit 0 with "Already up to date" and report success.
    #[tokio::test]
    async fn merges_the_branch_the_feature_worktree_has_checked_out() {
        let (dir, _worktree_parent, source) = repo_with_feature_worktree().await;
        let repo = dir.path();
        commit_file(&source, "first.txt").await;
        merge_into_main(repo, "feature/x").await;
        run_git(&["checkout", "-q", "-b", "feature/y"], &source)
            .await
            .unwrap();
        commit_file(&source, "second.txt").await;
        let state = setup_merge_state(repo, &source).await;
        repository::set_feature_setting(&state.write_pool, 1, "worktree_branch", "feature/x")
            .await
            .unwrap();

        let result = merge_feature_branch(&state, merge_body()).await.unwrap();

        assert!(result.success, "{:?}", result.error);
        assert!(repo.join("second.txt").exists());
    }

    #[tokio::test]
    async fn rejects_a_source_branch_already_merged_into_the_target() {
        let (dir, _worktree_parent, source) = repo_with_feature_worktree().await;
        let repo = dir.path();
        commit_file(&source, "first.txt").await;
        merge_into_main(repo, "feature/x").await;
        let state = setup_merge_state(repo, &source).await;
        let main_before = run_git(&["rev-parse", "main"], repo).await.unwrap();

        let err = merge_feature_branch(&state, merge_body())
            .await
            .unwrap_err();

        assert!(err.to_string().contains("nothing to merge"), "{err}");
        assert_eq!(
            run_git(&["rev-parse", "main"], repo).await.unwrap(),
            main_before
        );
    }

    #[tokio::test]
    async fn merge_still_rejects_dirty_target_worktree() {
        let dir = init_repo().await;
        let repo = dir.path();
        run_git(&["branch", "-M", "main"], repo).await.unwrap();
        run_git(&["checkout", "-q", "-b", "feature/x"], repo)
            .await
            .unwrap();
        tokio::fs::write(repo.join("committed.txt"), "committed\n")
            .await
            .unwrap();
        run_git(&["add", "committed.txt"], repo).await.unwrap();
        run_git(&["commit", "-q", "-m", "feature commit"], repo)
            .await
            .unwrap();
        run_git(&["checkout", "-q", "main"], repo).await.unwrap();
        tokio::fs::write(repo.join("dirty-target.txt"), "dirty\n")
            .await
            .unwrap();

        let err = run_merge(repo, "feature/x", "main", MergeMode::NoFf)
            .await
            .unwrap_err();

        assert!(err
            .to_string()
            .contains("target branch worktree has uncommitted changes"));
    }

    /// `main` (checked out in the project root) and `feature/x` (in its own
    /// worktree) diverge with a content and a modify/delete conflict.
    async fn conflicting_feature() -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
        let (dir, worktree_parent, source) = repo_with_feature_worktree().await;
        let repo = dir.path();
        commit_file(repo, "content.txt").await;
        commit_file(repo, "gone.txt").await;
        run_git(&["merge", "-q", "main"], &source).await.unwrap();
        tokio::fs::write(source.join("content.txt"), "feature side\n")
            .await
            .unwrap();
        run_git(&["rm", "-q", "gone.txt"], &source).await.unwrap();
        run_git(&["commit", "-qam", "feature side"], &source)
            .await
            .unwrap();
        tokio::fs::write(repo.join("content.txt"), "main side\n")
            .await
            .unwrap();
        tokio::fs::write(repo.join("gone.txt"), "main edit\n")
            .await
            .unwrap();
        run_git(&["commit", "-qam", "main side"], repo)
            .await
            .unwrap();
        (dir, worktree_parent, source)
    }

    async fn assert_clean_and_not_merging(repo: &Path) {
        assert!(!commands::has_uncommitted_changes(repo).await.unwrap());
        assert!(commands::unmerged_paths(repo).await.unwrap().is_empty());
        assert!(
            run_git(&["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], repo)
                .await
                .is_err(),
            "MERGE_HEAD must be gone after rollback"
        );
    }

    #[tokio::test]
    async fn conflicted_merge_reports_every_conflict_and_rolls_back() {
        let (dir, _worktree_parent, source) = conflicting_feature().await;
        let repo = dir.path();
        let state = setup_merge_state(repo, &source).await;
        let main_before = run_git(&["rev-parse", "main"], repo).await.unwrap();

        let result = merge_feature_branch(&state, merge_body()).await.unwrap();

        assert!(!result.success);
        let mut files = result.conflict_files.expect("structured conflict list");
        files.sort();
        assert_eq!(
            files,
            vec!["content.txt".to_string(), "gone.txt".to_string()]
        );
        assert_clean_and_not_merging(repo).await;
        assert_eq!(
            run_git(&["rev-parse", "main"], repo).await.unwrap(),
            main_before
        );
    }

    #[tokio::test]
    async fn conflicted_squash_without_merge_head_is_rolled_back() {
        let (dir, _worktree_parent, source) = conflicting_feature().await;
        let repo = dir.path();
        let state = setup_merge_state(repo, &source).await;
        let mut body = merge_body();
        body.mode = Some(MergeMode::Squash);

        let result = merge_feature_branch(&state, body).await.unwrap();

        assert!(!result.success);
        assert!(result.conflict_files.is_some_and(|files| files.len() == 2));
        assert_clean_and_not_merging(repo).await;
    }

    #[tokio::test]
    async fn merge_is_refused_while_the_target_worktree_is_busy() {
        let (dir, _worktree_parent, source) = repo_with_feature_worktree().await;
        let repo = dir.path();
        commit_file(&source, "committed.txt").await;
        let state = setup_merge_state(repo, &source).await;
        let _busy = state.git_mutations.try_acquire(repo).unwrap();

        let error = merge_feature_branch(&state, merge_body())
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
        assert!(!repo.join("committed.txt").exists());
    }

    #[tokio::test]
    async fn worktree_listing_failure_is_not_a_project_root_fallback() {
        let not_a_repo = tempfile::tempdir().unwrap();

        let error = target_worktree_or_project(not_a_repo.path(), "main")
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::GitCommandError(_)), "{error:?}");
    }

    /// The project root sits on a detached `HEAD` while `main` is merged into.
    /// `rev-parse --abbrev-ref` named that state `HEAD`, so the old restore
    /// ran `git checkout HEAD` and left the root on `main`.
    #[tokio::test]
    async fn detached_original_head_is_restored_after_the_merge() {
        let dir = init_repo().await;
        let repo = dir.path();
        run_git(&["branch", "-M", "main"], repo).await.unwrap();
        run_git(&["checkout", "-q", "-b", "feature/x"], repo)
            .await
            .unwrap();
        commit_file(repo, "feature.txt").await;
        run_git(&["checkout", "-q", "--detach", "main"], repo)
            .await
            .unwrap();
        let detached = run_git(&["rev-parse", "HEAD"], repo).await.unwrap();

        let result = run_merge(repo, "feature/x", "main", MergeMode::NoFf)
            .await
            .unwrap();

        assert!(result.success, "{:?}", result.error);
        assert!(result.warning.is_none(), "{:?}", result.warning);
        assert!(run_git(&["symbolic-ref", "-q", "HEAD"], repo)
            .await
            .is_err());
        assert_eq!(
            run_git(&["rev-parse", "HEAD"], repo).await.unwrap(),
            detached
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_switch_back_is_reported_on_a_successful_merge() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = init_repo().await;
        let repo = dir.path();
        run_git(&["branch", "-M", "main"], repo).await.unwrap();
        run_git(&["checkout", "-q", "-b", "feature/x"], repo)
            .await
            .unwrap();
        commit_file(repo, "feature.txt").await;
        run_git(&["checkout", "-q", "-b", "other", "main"], repo)
            .await
            .unwrap();
        // `post-checkout`'s exit status becomes `git checkout`'s: fail only
        // when returning to `other`.
        let hook = repo.join(".git/hooks/post-checkout");
        std::fs::write(
            &hook,
            "#!/bin/sh\n[ \"$(git symbolic-ref --short HEAD)\" = other ] && exit 1\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

        let result = run_merge(repo, "feature/x", "main", MergeMode::NoFf)
            .await
            .unwrap();

        assert!(result.success, "{:?}", result.error);
        let warning = result
            .warning
            .expect("switch-back failure must be reported");
        assert!(warning.contains("Could not switch"), "{warning}");
        assert!(warning.contains("'other'"), "{warning}");
        // `post-checkout` fails after Git already moved HEAD back.
        assert!(warning.contains("It is now on 'other'."), "{warning}");
    }

    #[test]
    fn merge_mode_setting_values_match_api_payloads() {
        assert_eq!(MergeMode::Default.as_setting(), "default");
        assert_eq!(MergeMode::NoFf.as_setting(), "no_ff");
        assert_eq!(MergeMode::FfOnly.as_setting(), "ff_only");
        assert_eq!(MergeMode::Squash.as_setting(), "squash");
    }
}
