use std::path::{Path, PathBuf};

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::mutation_guard::GitMutationGuardError;
use crate::domain::git::service::resolve_feature_git_dir;
use crate::error::AppError;
use crate::shared::git_cli::{
    git_output_error, git_ref_resolves_background, guard_positionals, run_git_output_with_env,
    run_git_safe_refs_background,
};

use super::{detect_active_git_operation, operation_name};

/// Resolve the checkout this feature currently observes. A live configured
/// linked worktree wins; no-worktree and stale-worktree features use the
/// project's primary checkout, matching status, index, commit, and stash.
pub(super) async fn resolve_feature_update_path(
    state: &AppState,
    feature_id: i64,
) -> Result<PathBuf, AppError> {
    // Merge and rebase name no repository-relative paths; they run in the
    // feature's own directory, the key its post-write refresh needs.
    Ok(resolve_feature_git_dir(state, feature_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id} has no git path")))?
        .cwd)
}

pub(super) async fn require_no_active_operation(worktree: &Path) -> Result<(), AppError> {
    if let Some(operation) = detect_active_git_operation(worktree).await? {
        return Err(AppError::BadRequest(format!(
            "a {} is already active in this worktree",
            operation_name(operation)
        )));
    }
    Ok(())
}

pub(super) async fn attached_head_ref(worktree: &Path) -> Result<String, AppError> {
    let args = ["symbolic-ref", "--quiet", "HEAD"];
    let output = run_git_output_with_env(&args, worktree, &[]).await?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    if output.stderr.is_empty() {
        return Err(AppError::BadRequest(
            "current worktree is in detached HEAD".into(),
        ));
    }
    Err(git_output_error(&args, &output))
}

pub(super) async fn require_clean_worktree(worktree: &Path) -> Result<(), AppError> {
    if commands::has_uncommitted_changes(worktree).await? {
        return Err(AppError::BadRequest(
            "worktree must be clean, including untracked files".into(),
        ));
    }
    Ok(())
}

/// Select the exact source ref for Update without changing the configured
/// comparison target. Incoming commits from the checked-out branch's upstream
/// win first. Otherwise, when the configured target is a local branch whose
/// own upstream has incoming commits, use that remote-tracking ref. The final
/// fallback preserves the configured target verbatim.
pub(crate) async fn resolve_update_target(
    worktree: &Path,
    current_ref: &str,
    configured_target: &str,
) -> Result<String, AppError> {
    guard_positionals(&[current_ref, configured_target])?;
    if let Some(upstream) = incoming_upstream_for_ref(worktree, current_ref).await? {
        return Ok(upstream);
    }
    resolve_configured_update_target(worktree, current_ref, configured_target).await
}

/// Resolve only the configured-target portion of Update selection. Status uses
/// this after consuming the checked-out branch's upstream directly from its
/// porcelain snapshot, avoiding repeated Git probes on every watcher refresh.
pub(crate) async fn resolve_configured_update_target(
    worktree: &Path,
    current_ref: &str,
    configured_target: &str,
) -> Result<String, AppError> {
    guard_positionals(&[current_ref, configured_target])?;
    if configured_target == current_ref
        || current_ref.strip_prefix("refs/heads/") == Some(configured_target)
    {
        return Ok(configured_target.to_string());
    }
    if let Some(target_ref) = local_ref(worktree, configured_target).await? {
        if target_ref != current_ref {
            if let Some(upstream) = incoming_upstream_for_ref(worktree, &target_ref).await? {
                return Ok(upstream);
            }
        }
    }
    Ok(configured_target.to_string())
}

async fn incoming_upstream_for_ref(
    worktree: &Path,
    local_ref: &str,
) -> Result<Option<String>, AppError> {
    let tracking = run_git_safe_refs_background(
        &[
            "for-each-ref",
            "--format=%(upstream:short)%00%(upstream:trackshort)",
        ],
        &[],
        &[local_ref],
        worktree,
    )
    .await?;
    let Some((upstream, track)) = tracking.trim_end().split_once('\0') else {
        return Ok(None);
    };
    let has_incoming = matches!(track.trim(), "<" | "<>");

    Ok(has_incoming.then(|| upstream.to_string()))
}

async fn local_ref(worktree: &Path, target: &str) -> Result<Option<String>, AppError> {
    let target_commit = format!("{target}^{{commit}}");
    if !git_ref_resolves_background(&target_commit, worktree).await? {
        return Ok(None);
    }
    let symbolic = run_git_safe_refs_background(
        &["rev-parse", "--symbolic-full-name"],
        &[],
        &[target],
        worktree,
    )
    .await?;
    let symbolic = symbolic.trim();
    Ok(symbolic
        .starts_with("refs/heads/")
        .then(|| symbolic.to_string()))
}

pub(super) async fn validate_target(
    worktree: &Path,
    current_ref: &str,
    target: &str,
) -> Result<(), AppError> {
    if target.trim().is_empty() || target.starts_with('-') {
        return Err(AppError::BadRequest("target ref is invalid".into()));
    }
    guard_positionals(&[target])?;
    let commit = format!("{target}^{{commit}}");
    let verify_args = ["rev-parse", "--verify", commit.as_str()];
    let verify = run_git_output_with_env(&verify_args, worktree, &[]).await?;
    if !verify.status.success() {
        return Err(AppError::BadRequest(format!(
            "target ref '{target}' does not resolve"
        )));
    }
    let symbolic_args = ["rev-parse", "--symbolic-full-name", target];
    let symbolic_output = run_git_output_with_env(&symbolic_args, worktree, &[]).await?;
    if !symbolic_output.status.success() {
        return Err(git_output_error(&symbolic_args, &symbolic_output));
    }
    let symbolic = String::from_utf8_lossy(&symbolic_output.stdout)
        .trim()
        .to_string();
    if symbolic == current_ref {
        return Err(AppError::BadRequest(format!(
            "target ref '{target}' is the current branch"
        )));
    }
    Ok(())
}

pub(super) fn mutation_error(error: GitMutationGuardError) -> AppError {
    match error {
        GitMutationGuardError::Busy { .. } => AppError::Conflict(error.to_string()),
        GitMutationGuardError::InvalidWorktree { .. } => AppError::NotFound(error.to_string()),
        GitMutationGuardError::RegistryUnavailable => AppError::Internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::git::models::{UpdateBranchBody, UpdateBranchStrategy};
    use crate::domain::git::workflow_service::update_branch::test_support::RepoFixture;
    use crate::domain::git::workflow_service::update_branch::update_branch;

    async fn assert_rejected(fixture: &RepoFixture, target: &str, needle: &str) {
        let state = fixture.state(target).await;
        let error = update_branch(
            &state,
            UpdateBranchBody {
                feature_id: 1,
                strategy: UpdateBranchStrategy::Rebase,
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains(needle), "{error:?}");
    }

    #[tokio::test]
    async fn rejects_same_branch_and_missing_target() {
        let same = RepoFixture::new();
        assert_rejected(&same, "feature/test", "current branch").await;

        let missing = RepoFixture::new();
        assert_rejected(&missing, "does-not-exist", "does not resolve").await;
    }

    #[tokio::test]
    async fn rejects_tracked_and_untracked_dirt() {
        let tracked = RepoFixture::new();
        tracked.write_feature("seed.txt", "dirty\n");
        assert_rejected(&tracked, "main", "must be clean").await;

        let untracked = RepoFixture::new();
        untracked.write_feature("untracked.txt", "dirty\n");
        assert_rejected(&untracked, "main", "must be clean").await;
    }

    #[tokio::test]
    async fn rejects_detached_head_and_pre_existing_operation() {
        let detached = RepoFixture::new();
        detached.git_feature(&["checkout", "--detach"]);
        assert_rejected(&detached, "main", "detached HEAD").await;

        let active = RepoFixture::new();
        active.create_conflicting_histories();
        let output = active.git_output_feature(&["merge", "main"]);
        assert!(!output.status.success());
        assert_rejected(&active, "main", "already active").await;
    }

    #[tokio::test]
    async fn falls_back_to_the_project_checkout_for_a_stale_worktree() {
        let fixture = RepoFixture::new();
        fixture.create_remote_only_tip();
        let state = fixture.state("origin/main").await;
        let feature_arg = fixture.feature.to_string_lossy().to_string();
        fixture.git_project(&["worktree", "remove", "--force", &feature_arg]);

        update_branch(
            &state,
            UpdateBranchBody {
                feature_id: 1,
                strategy: UpdateBranchStrategy::Rebase,
            },
        )
        .await
        .unwrap();

        assert!(fixture.project.join("remote-only.txt").exists());
    }
}
