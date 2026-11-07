//! Service layer for stash listing and foreground mutations.

use std::path::{Path, PathBuf};

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::models::{
    GitOperationResponse, ListStashesParams, StashEntry, StashMutationBody, StashPushBody,
};
use crate::domain::git::mutation_guard::{GitMutationGuardError, GitMutationPermit};
use crate::error::AppError;

use super::{resolve_feature_git_dir, resolve_feature_git_path};

pub async fn list_stashes(
    state: &AppState,
    params: ListStashesParams,
) -> Result<Vec<StashEntry>, AppError> {
    let git_path = match resolve_feature_git_path(state, params.feature_id).await? {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    commands::list_stashes(Path::new(&git_path)).await
}

pub async fn push_stash(
    state: &AppState,
    body: StashPushBody,
) -> Result<GitOperationResponse, AppError> {
    let (repo, permits) = acquire_stash_permits(state, body.feature_id).await?;
    let outcome =
        commands::push_stash(&repo, body.message.as_deref(), body.include_untracked).await?;
    drop(permits);
    crate::domain::git::workflow_service::broadcast_after_write_at(state, &repo).await;
    Ok(outcome)
}

pub async fn apply_stash(
    state: &AppState,
    body: StashMutationBody,
) -> Result<GitOperationResponse, AppError> {
    let (repo, permits) = acquire_stash_permits(state, body.feature_id).await?;
    let outcome = commands::apply_stash(&repo, &body.ref_name, &body.expected_sha).await?;
    drop(permits);
    crate::domain::git::workflow_service::broadcast_after_write_at(state, &repo).await;
    Ok(outcome)
}

pub async fn pop_stash(
    state: &AppState,
    body: StashMutationBody,
) -> Result<GitOperationResponse, AppError> {
    let (repo, permits) = acquire_stash_permits(state, body.feature_id).await?;
    let outcome = commands::pop_stash(&repo, &body.ref_name, &body.expected_sha).await?;
    drop(permits);
    crate::domain::git::workflow_service::broadcast_after_write_at(state, &repo).await;
    Ok(outcome)
}

pub async fn drop_stash(
    state: &AppState,
    body: StashMutationBody,
) -> Result<GitOperationResponse, AppError> {
    let (repo, permits) = acquire_stash_permits(state, body.feature_id).await?;
    let outcome = commands::drop_stash(&repo, &body.ref_name, &body.expected_sha).await?;
    drop(permits);
    crate::domain::git::workflow_service::broadcast_after_write_at(state, &repo).await;
    Ok(outcome)
}

struct StashMutationPermits {
    _worktree: GitMutationPermit,
    _repository: GitMutationPermit,
}

/// Stash commands mutate both the selected worktree/index and the repository-
/// global `refs/stash` reflog. Holding both keys prevents sibling linked
/// worktrees from concurrently acting on moving `stash@{N}` ordinals.
async fn acquire_stash_permits(
    state: &AppState,
    feature_id: i64,
) -> Result<(PathBuf, StashMutationPermits), AppError> {
    // Stash commands name no repository-relative paths; they run in the
    // feature's own directory, the key its post-write refresh needs.
    let repo = resolve_feature_git_dir(state, feature_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id} has no git path")))?
        .cwd;
    let worktree = state
        .git_mutations
        .try_acquire(&repo)
        .map_err(map_guard_error)?;
    let common_dir = commands::stash::stash_common_dir(&repo).await?;
    let repository = state
        .git_mutations
        .try_acquire(&common_dir)
        .map_err(map_guard_error)?;
    Ok((
        repo,
        StashMutationPermits {
            _worktree: worktree,
            _repository: repository,
        },
    ))
}

fn map_guard_error(error: GitMutationGuardError) -> AppError {
    match error {
        GitMutationGuardError::Busy { .. } => AppError::Conflict(error.to_string()),
        GitMutationGuardError::InvalidWorktree { .. } => AppError::BadRequest(error.to_string()),
        GitMutationGuardError::RegistryUnavailable => AppError::Internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::service::test_support::setup_diff_refs_schema;
    use crate::shared::git_cli::run_git;

    async fn linked_worktree_state() -> (tempfile::TempDir, PathBuf, PathBuf, AppState) {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let linked = temp.path().join("linked");
        tokio::fs::create_dir_all(&main).await.unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run_git(args, &main).await.unwrap();
        }
        tokio::fs::write(main.join("tracked.txt"), "base\n")
            .await
            .unwrap();
        run_git(&["add", "."], &main).await.unwrap();
        run_git(&["commit", "-q", "-m", "base"], &main)
            .await
            .unwrap();
        run_git(
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature/test",
                linked.to_str().unwrap(),
            ],
            &main,
        )
        .await
        .unwrap();

        let pool = setup_diff_refs_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'repo', ?)")
            .bind(main.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'main')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (2, 1, 'linked')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO feature_settings (feature_id, key, value) VALUES (2, 'worktree_path', ?)",
        )
        .bind(linked.to_string_lossy().as_ref())
        .execute(&pool)
        .await
        .unwrap();
        let state = AppState::with_pool(pool);
        (temp, main, linked, state)
    }

    #[tokio::test]
    async fn linked_worktrees_serialize_on_the_repository_stash_ref() {
        let (_temp, _main, linked, state) = linked_worktree_state().await;
        let (_main_path, main_permits) = acquire_stash_permits(&state, 1).await.unwrap();
        let resolved_linked = resolve_feature_git_path(&state, 2).await.unwrap().unwrap();
        assert_eq!(
            std::fs::canonicalize(resolved_linked).unwrap(),
            std::fs::canonicalize(&linked).unwrap()
        );
        let independent_worktree = state.git_mutations.try_acquire(&linked).unwrap();
        drop(independent_worktree);
        tokio::fs::write(linked.join("tracked.txt"), "linked change\n")
            .await
            .unwrap();

        let blocked = push_stash(
            &state,
            StashPushBody {
                feature_id: 2,
                message: Some("linked".into()),
                include_untracked: false,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(blocked, AppError::Conflict(_)), "{blocked:?}");
        assert!(commands::list_stashes(&linked).await.unwrap().is_empty());

        drop(main_permits);
        let outcome = push_stash(
            &state,
            StashPushBody {
                feature_id: 2,
                message: Some("linked".into()),
                include_untracked: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(outcome, GitOperationResponse::Completed);
        assert_eq!(commands::list_stashes(&linked).await.unwrap().len(), 1);
    }
}
