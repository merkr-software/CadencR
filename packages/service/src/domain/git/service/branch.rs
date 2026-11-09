use std::path::Path;

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::models::*;
use crate::domain::git::repository;
use crate::domain::git::workflow_service;
use crate::error::AppError;
use crate::shared::git_cli::run_git_capture;

use super::{
    get_project_and_branch, normalize_git_path, resolve_feature_git_path, SETTING_WORKTREE_PATH,
};

pub async fn get_original_branch(
    state: &AppState,
    params: GetOriginalBranchParams,
) -> Result<OriginalBranchResponse, AppError> {
    let (project_path, worktree_branch) =
        get_project_and_branch(state, params.project_id, params.feature_id).await?;
    let original_branch =
        commands::get_original_branch(Path::new(&project_path), &worktree_branch).await?;
    Ok(OriginalBranchResponse {
        original_branch,
        worktree_branch,
    })
}

pub async fn check_merge_conflicts(
    state: &AppState,
    params: CheckMergeConflictsParams,
) -> Result<MergeConflictResult, AppError> {
    let (project_path, branch) =
        get_project_and_branch(state, params.project_id, params.feature_id).await?;
    let (repo_path, target) =
        resolve_feature_repo_and_target(state, params.feature_id, &project_path).await?;
    commands::check_merge_conflicts(Path::new(&repo_path), &branch, &target).await
}

async fn resolve_feature_repo_and_target(
    state: &AppState,
    feature_id: i64,
    fallback_project_path: &str,
) -> Result<(String, String), AppError> {
    let git_path = resolve_feature_git_path(state, feature_id)
        .await?
        .unwrap_or_else(|| fallback_project_path.to_string());
    let target =
        workflow_service::resolve_target_branch(state, feature_id, Path::new(&git_path)).await?;
    Ok((git_path, target))
}

pub async fn delete_feature_branch(
    state: &AppState,
    params: DeleteFeatureBranchParams,
) -> Result<SuccessResponse, AppError> {
    let (project_path, branch) =
        get_project_and_branch(state, params.project_id, params.feature_id).await?;
    if !commands::list_local_branches(Path::new(&project_path))
        .await?
        .contains(&branch)
    {
        return Ok(SuccessResponse {
            success: true,
            error: None,
            blocked_reason: None,
        });
    }
    // Covers the optional checkout away from the branch and the deletion.
    let _permit = state
        .git_mutations
        .try_acquire(Path::new(&project_path))
        .map_err(|error| workflow_service::mutation_guard_error(error))?;
    let has_separate_worktree =
        feature_has_separate_worktree(state, &project_path, params.feature_id).await?;
    if !has_separate_worktree {
        return delete_no_worktree_feature_branch(
            state,
            &project_path,
            &branch,
            params.feature_id,
            params.force,
        )
        .await;
    }
    let default_branch = workflow_service::resolve_default_branch(Path::new(&project_path)).await?;
    if workflow_service::same_branch_identity(&branch, &default_branch) {
        return Ok(branch_delete_blocked(
            "default_branch",
            "Cannot remove the default branch",
        ));
    }
    let (_, target_branch) =
        resolve_feature_repo_and_target(state, params.feature_id, &project_path).await?;
    if workflow_service::same_branch_identity(&branch, &target_branch) {
        return Ok(branch_delete_blocked(
            "target_branch",
            "Cannot remove the target branch",
        ));
    }
    if params.force {
        return delete_branch_after_validation(Path::new(&project_path), &branch).await;
    }
    delete_branch_against_target(Path::new(&project_path), &branch, &target_branch).await
}

async fn delete_no_worktree_feature_branch(
    state: &AppState,
    project_path: &str,
    branch: &str,
    feature_id: i64,
    force: bool,
) -> Result<SuccessResponse, AppError> {
    let repo = Path::new(project_path);
    let (_, target_branch) =
        resolve_feature_repo_and_target(state, feature_id, project_path).await?;
    if workflow_service::same_branch_identity(branch, &target_branch) {
        return Ok(branch_delete_blocked(
            "target_branch",
            "Cannot remove the target branch",
        ));
    }
    let default_branch = workflow_service::resolve_default_branch(repo).await?;
    if workflow_service::same_branch_identity(branch, &default_branch) {
        return Ok(branch_delete_blocked(
            "default_branch",
            "Cannot remove the default branch",
        ));
    }

    if !force {
        if let Some(blocked) = unmerged_branch_blocker(repo, branch, &target_branch).await? {
            return Ok(blocked);
        }
    }

    let current_branch = commands::get_current_branch(repo).await?;
    if current_branch.as_deref() == Some(branch) {
        let checkout_ref = match workflow_service::resolve_checkout_ref(repo, &target_branch).await
        {
            Ok(resolved) => resolved,
            Err(err) => return Ok(branch_delete_blocked("checkout_failed", err.to_string())),
        };
        if let Err(err) = run_git_capture(&["checkout"], &[], &[&checkout_ref], repo).await {
            return Ok(branch_delete_blocked("checkout_failed", err.to_string()));
        }
    }

    delete_branch_after_validation(repo, branch).await
}

async fn delete_branch_against_target(
    repo: &Path,
    branch: &str,
    target_branch: &str,
) -> Result<SuccessResponse, AppError> {
    if let Some(blocked) = unmerged_branch_blocker(repo, branch, target_branch).await? {
        return Ok(blocked);
    }
    delete_branch_after_validation(repo, branch).await
}

async fn unmerged_branch_blocker(
    repo: &Path,
    branch: &str,
    target_branch: &str,
) -> Result<Option<SuccessResponse>, AppError> {
    if commands::is_branch_merged(repo, branch, target_branch).await? {
        return Ok(None);
    }
    Ok(Some(branch_delete_blocked(
        "unmerged_branch",
        format!("Branch '{branch}' is not fully merged into target branch '{target_branch}'"),
    )))
}

async fn delete_branch_after_validation(
    repo: &Path,
    branch: &str,
) -> Result<SuccessResponse, AppError> {
    let result = commands::force_delete_branch(repo, branch).await?;
    Ok(SuccessResponse {
        success: result.success,
        error: result.error,
        blocked_reason: None,
    })
}

pub async fn check_branch_delete(
    state: &AppState,
    params: BranchDeleteCheckParams,
) -> Result<BranchDeleteCheckResponse, AppError> {
    let (project_path, branch) =
        get_project_and_branch(state, params.project_id, params.feature_id).await?;
    let (repo_path, target_branch) =
        resolve_feature_repo_and_target(state, params.feature_id, &project_path).await?;
    let default_branch = workflow_service::resolve_default_branch(Path::new(&repo_path)).await?;
    let is_default_branch = workflow_service::same_branch_identity(&branch, &default_branch);
    let branch_exists = commands::list_local_branches(Path::new(&repo_path))
        .await?
        .contains(&branch);
    let merged = if branch_exists {
        commands::is_branch_merged(Path::new(&repo_path), &branch, &target_branch).await?
    } else {
        true
    };
    let current_branch = commands::get_current_branch(Path::new(&repo_path)).await?;
    Ok(BranchDeleteCheckResponse {
        branch,
        branch_exists,
        current_branch,
        target_branch,
        default_branch,
        is_default_branch,
        merged,
    })
}

async fn feature_has_separate_worktree(
    state: &AppState,
    project_path: &str,
    feature_id: i64,
) -> Result<bool, AppError> {
    let Some(worktree_path) =
        repository::get_feature_setting(&state.read_pool, feature_id, SETTING_WORKTREE_PATH)
            .await?
    else {
        return Ok(false);
    };
    Ok(
        normalize_git_path(&worktree_path) != normalize_git_path(project_path)
            && commands::is_live_worktree(Path::new(project_path), Path::new(&worktree_path))
                .await?,
    )
}

fn branch_delete_blocked(reason: &str, error: impl Into<String>) -> SuccessResponse {
    SuccessResponse {
        success: false,
        error: Some(error.into()),
        blocked_reason: Some(reason.to_string()),
    }
}

pub async fn has_uncommitted_changes(
    state: &AppState,
    params: HasUncommittedChangesParams,
) -> Result<HasUncommittedChangesResponse, AppError> {
    let wt_path = repository::get_feature_setting(
        &state.read_pool,
        params.feature_id,
        super::SETTING_WORKTREE_PATH,
    )
    .await?
    .ok_or_else(|| AppError::NotFound("No worktree found for this feature".into()))?;

    let has_changes = crate::shared::git_context::has_git_metadata(Path::new(&wt_path)).await?
        && commands::has_uncommitted_changes(Path::new(&wt_path)).await?;
    Ok(HasUncommittedChangesResponse { has_changes })
}

#[cfg(test)]
mod tests {
    use super::super::{test_support::setup_diff_refs_schema, SETTING_WORKTREE_BRANCH};
    use super::*;

    #[tokio::test]
    async fn resolve_merge_conflict_target_honors_stored_target_branch() {
        let pool = setup_diff_refs_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'project', '/tmp/project')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, "target_branch", "develop")
            .await
            .unwrap();

        let state = AppState::with_pool(pool);
        let (repo_path, target) = resolve_feature_repo_and_target(&state, 1, "/tmp/project")
            .await
            .unwrap();
        assert_eq!(repo_path, "/tmp/project");
        assert_eq!(target, "develop");
    }

    #[tokio::test]
    async fn branch_deletion_rejects_unverifiable_repositories() {
        let dir = tempfile::tempdir().unwrap();
        let pool = setup_diff_refs_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'project', ?)")
            .bind(dir.path().to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "feature/test")
            .await
            .unwrap();
        let state = AppState::with_pool(pool);
        for path in [dir.path().to_path_buf(), dir.path().join("missing")] {
            sqlx::query("UPDATE projects SET path = ? WHERE id = 1")
                .bind(path.to_string_lossy().as_ref())
                .execute(&state.write_pool)
                .await
                .unwrap();
            assert!(delete_feature_branch(
                &state,
                DeleteFeatureBranchParams {
                    project_id: 1,
                    feature_id: 1,
                    force: true,
                }
            )
            .await
            .is_err());
            assert!(check_branch_delete(
                &state,
                BranchDeleteCheckParams {
                    project_id: 1,
                    feature_id: 1,
                }
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn branch_deletion_is_refused_while_the_project_worktree_is_busy() {
        let repo = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &[
                "-c",
                "user.email=t@e",
                "-c",
                "user.name=T",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "seed",
            ][..],
            &["branch", "feature/test"][..],
        ] {
            run_git_capture(args, &[], &[], repo.path()).await.unwrap();
        }
        let pool = setup_diff_refs_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'project', ?)")
            .bind(repo.path().to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "feature/test")
            .await
            .unwrap();
        let state = AppState::with_pool(pool);
        let _busy = state.git_mutations.try_acquire(repo.path()).unwrap();

        let error = delete_feature_branch(
            &state,
            DeleteFeatureBranchParams {
                project_id: 1,
                feature_id: 1,
                force: true,
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
        assert!(commands::list_local_branches(repo.path())
            .await
            .unwrap()
            .contains("feature/test"));
    }

    #[tokio::test]
    async fn deleting_an_already_absent_branch_is_successful() {
        let repo = tempfile::tempdir().unwrap();
        run_git_capture(&["init"], &[], &[], repo.path())
            .await
            .unwrap();
        let pool = setup_diff_refs_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'project', ?)")
            .bind(repo.path().to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "feature/removed")
            .await
            .unwrap();

        let result = delete_feature_branch(
            &AppState::with_pool(pool),
            DeleteFeatureBranchParams {
                project_id: 1,
                feature_id: 1,
                force: true,
            },
        )
        .await
        .unwrap();

        assert!(result.success);
        assert!(result.error.is_none());
    }
}
