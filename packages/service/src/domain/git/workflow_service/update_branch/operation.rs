use std::path::{Path, PathBuf};

use crate::domain::git::models::GitOperationKind;
use crate::error::AppError;
use crate::shared::git_cli::run_git_background;

/// Detect the merge/rebase state belonging to `worktree` without assuming
/// `.git` is a directory. `git rev-parse --git-path` resolves the per-worktree
/// administrative path correctly for both primary and linked worktrees.
pub async fn detect_active_git_operation(
    worktree: &Path,
) -> Result<Option<GitOperationKind>, AppError> {
    let paths = run_git_background(
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "MERGE_HEAD",
            "--git-path",
            "rebase-merge",
            "--git-path",
            "rebase-apply",
        ],
        worktree,
    )
    .await?;
    let [merge_head, rebase_merge, rebase_apply] = parse_git_paths(worktree, &paths)?;

    if rebase_merge.exists() || rebase_apply.exists() {
        return Ok(Some(GitOperationKind::Rebase));
    }
    if merge_head.exists() {
        return Ok(Some(GitOperationKind::Merge));
    }
    Ok(None)
}

fn parse_git_paths(worktree: &Path, output: &str) -> Result<[PathBuf; 3], AppError> {
    let paths = output
        .lines()
        .map(|line| {
            let path = PathBuf::from(line);
            if path.is_absolute() {
                path
            } else {
                worktree.join(path)
            }
        })
        .collect::<Vec<_>>();
    paths.try_into().map_err(|paths: Vec<PathBuf>| {
        AppError::git_command(format!(
            "git rev-parse returned {} operation paths instead of 3",
            paths.len()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::workflow_service::update_branch::test_support::RepoFixture;

    #[tokio::test]
    async fn detects_operations_in_a_linked_worktree() {
        let fixture = RepoFixture::new();
        assert!(fixture.feature.join(".git").is_file());
        assert_eq!(
            detect_active_git_operation(&fixture.feature).await.unwrap(),
            None
        );

        fixture.create_conflicting_histories();
        let output = fixture.git_output_feature(&["merge", "main"]);
        assert!(!output.status.success());
        assert_eq!(
            detect_active_git_operation(&fixture.feature).await.unwrap(),
            Some(GitOperationKind::Merge)
        );
    }

    #[tokio::test]
    async fn detects_rebase_apply_or_merge_metadata_via_git_path() {
        let fixture = RepoFixture::new();
        fixture.create_conflicting_histories();
        let output = fixture.git_output_feature(&["rebase", "main"]);
        assert!(!output.status.success());

        assert_eq!(
            detect_active_git_operation(&fixture.feature).await.unwrap(),
            Some(GitOperationKind::Rebase)
        );
    }
}
