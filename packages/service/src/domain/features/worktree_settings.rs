use sqlx::SqlitePool;
use std::path::Path;

use crate::domain::features::repository::project_id_for_feature;
use crate::domain::features::service;
use crate::domain::features::worktree_validation::{validate_reuse_branch, validate_worktree_mode};
use crate::domain::git;
use crate::error::AppError;

pub(super) async fn normalize_feature_setting_value(
    read_pool: &SqlitePool,
    feature_id: i64,
    key: &str,
    value: &str,
) -> Result<String, AppError> {
    match key {
        "worktree_reuse_branch" => {
            let branch = validate_reuse_branch(value)?;
            validate_reuse_branch_for_feature(read_pool, feature_id, &branch).await?;
            Ok(branch)
        }
        "worktree_mode" => normalize_worktree_mode_setting(read_pool, feature_id, value).await,
        _ => Ok(value.to_string()),
    }
}

pub(super) async fn validate_reuse_branch_for_project(
    read_pool: &SqlitePool,
    project_id: i64,
    branch: &str,
) -> Result<(), AppError> {
    let project_path = git::repository::get_project_path(read_pool, project_id).await?;
    ensure_local_branch_exists(Path::new(&project_path), branch).await
}

pub(super) async fn validate_reuse_branch_for_feature(
    read_pool: &SqlitePool,
    feature_id: i64,
    branch: &str,
) -> Result<(), AppError> {
    let project_id = project_id_for_feature(read_pool, feature_id).await?;
    validate_reuse_branch_for_project(read_pool, project_id, branch).await
}

async fn normalize_worktree_mode_setting(
    read_pool: &SqlitePool,
    feature_id: i64,
    value: &str,
) -> Result<String, AppError> {
    let reuse_branch = current_reuse_branch(read_pool, feature_id).await?;
    let (mode, normalized_branch) =
        validate_worktree_mode(&Some(value.to_string()), &reuse_branch)?;
    if let Some(branch) = normalized_branch.as_deref() {
        validate_reuse_branch_for_feature(read_pool, feature_id, branch).await?;
    }
    mode.ok_or_else(|| AppError::BadRequest("worktree_mode must not be blank".into()))
}

async fn current_reuse_branch(
    read_pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    Ok(service::get_feature_settings(read_pool, feature_id)
        .await?
        .into_iter()
        .find(|setting| setting.key == "worktree_reuse_branch")
        .map(|setting| setting.value))
}

/// Exact, case-sensitive check (see `workflow_service::local_branch_exists`):
/// on a case-insensitive filesystem `show-ref --verify` accepted
/// `Feature/ABC` for a loose `feature/abc`, and the worktree then reused the
/// other branch. A repository Git cannot read is reported as such, not as a
/// missing branch.
async fn ensure_local_branch_exists(project_path: &Path, branch: &str) -> Result<(), AppError> {
    if git::workflow_service::local_branch_exists(project_path, branch).await? {
        return Ok(());
    }
    Err(AppError::BadRequest(format!(
        "reuse_branch does not exist: {branch:?}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli;

    #[tokio::test]
    async fn a_reuse_branch_must_match_a_branch_name_exactly() {
        let repo = tempfile::tempdir().unwrap();
        let path = repo.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "i",
            ],
            &["branch", "feature/abc"],
        ] {
            git_cli::run_git(args, path).await.unwrap();
        }
        for packed in [false, true] {
            if packed {
                git_cli::run_git(&["pack-refs", "--all"], path)
                    .await
                    .unwrap();
            }
            ensure_local_branch_exists(path, "feature/abc")
                .await
                .unwrap();
            for other in ["Feature/ABC", "feature/ABC", "feature"] {
                let error = ensure_local_branch_exists(path, other).await.unwrap_err();
                assert!(
                    matches!(error, AppError::BadRequest(_)),
                    "{other:?} (packed: {packed}): {error:?}"
                );
            }
        }

        let not_repo = tempfile::tempdir().unwrap();
        let error = ensure_local_branch_exists(not_repo.path(), "main")
            .await
            .unwrap_err();
        assert!(!matches!(error, AppError::BadRequest(_)), "{error:?}");
    }
}
