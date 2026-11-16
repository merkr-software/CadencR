//! Foreground stash mutations and their stable-selector safety checks.

use std::path::{Path, PathBuf};

use crate::domain::git::commands::unmerged_paths;
use crate::domain::git::models::GitOperationResponse;
use crate::error::AppError;
use crate::shared::git_cli::{run_git_background, run_git_capture, run_git_safe_refs};

mod push;

pub use push::push_stash;

/// Resolve the repository-global Git directory that owns `refs/stash` and its
/// reflog. Linked worktrees return the same canonical directory here.
pub async fn stash_common_dir(repo_path: &Path) -> Result<PathBuf, AppError> {
    let output = run_git_background(&["rev-parse", "--git-common-dir"], repo_path).await?;
    let common_dir = PathBuf::from(output.trim());
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        repo_path.join(common_dir)
    };
    tokio::fs::canonicalize(&common_dir).await.map_err(|error| {
        AppError::git_command(format!(
            "failed to resolve the repository Git directory {}: {error}",
            common_dir.display()
        ))
    })
}

pub async fn apply_stash(
    repo_path: &Path,
    ref_name: &str,
    expected_sha: &str,
) -> Result<GitOperationResponse, AppError> {
    verify_stash_ref(repo_path, ref_name, expected_sha).await?;
    run_conflictable_stash_command(repo_path, "apply", ref_name).await
}

pub async fn pop_stash(
    repo_path: &Path,
    ref_name: &str,
    expected_sha: &str,
) -> Result<GitOperationResponse, AppError> {
    verify_stash_ref(repo_path, ref_name, expected_sha).await?;
    run_conflictable_stash_command(repo_path, "pop", ref_name).await
}

pub async fn drop_stash(
    repo_path: &Path,
    ref_name: &str,
    expected_sha: &str,
) -> Result<GitOperationResponse, AppError> {
    verify_stash_ref(repo_path, ref_name, expected_sha).await?;
    run_git_capture(&["stash", "drop"], &[], &[ref_name], repo_path).await?;
    Ok(GitOperationResponse::Completed)
}

async fn verify_stash_ref(
    repo_path: &Path,
    ref_name: &str,
    expected_sha: &str,
) -> Result<(), AppError> {
    validate_selector(ref_name)?;
    validate_sha(expected_sha)?;
    let revision = format!("{ref_name}^{{commit}}");
    let resolved = run_git_safe_refs(&["rev-parse"], &["--verify"], &[&revision], repo_path)
        .await
        .map_err(|error| {
            AppError::Conflict(format!(
                "Stash {ref_name} no longer resolves; refresh the stash list before retrying: {error}"
            ))
        })?;
    let actual_sha = resolved.trim();
    if !actual_sha.eq_ignore_ascii_case(expected_sha) {
        return Err(AppError::Conflict(format!(
            "Stash {ref_name} moved from {expected_sha} to {actual_sha}; refresh the stash list before retrying"
        )));
    }
    Ok(())
}

fn validate_selector(ref_name: &str) -> Result<(), AppError> {
    let ordinal = ref_name
        .strip_prefix("stash@{")
        .and_then(|value| value.strip_suffix('}'));
    if ordinal.is_none_or(|value| value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit())) {
        return Err(AppError::BadRequest(format!(
            "Invalid stash selector {ref_name:?}; expected stash@{{N}}"
        )));
    }
    Ok(())
}

fn validate_sha(expected_sha: &str) -> Result<(), AppError> {
    if !matches!(expected_sha.len(), 40 | 64)
        || !expected_sha.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::BadRequest(
            "expected_sha must be a full hexadecimal Git object ID".into(),
        ));
    }
    Ok(())
}

async fn run_conflictable_stash_command(
    repo_path: &Path,
    action: &str,
    ref_name: &str,
) -> Result<GitOperationResponse, AppError> {
    let existing_conflicts = unmerged_paths(repo_path).await?;
    if !existing_conflicts.is_empty() {
        return Err(AppError::BadRequest(format!(
            "Resolve existing Git conflicts before running stash {action}: {}",
            existing_conflicts.join(", ")
        )));
    }
    let command_result = run_git_capture(&["stash", action], &[], &[ref_name], repo_path).await;
    let conflict_files = unmerged_paths(repo_path).await?;
    if !conflict_files.is_empty() {
        return Ok(GitOperationResponse::Conflicts { conflict_files });
    }
    command_result?;
    Ok(GitOperationResponse::Completed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::commands::list_stashes;
    use crate::shared::git_cli::run_git;

    pub(super) struct Repo {
        _temp: tempfile::TempDir,
        pub(super) path: PathBuf,
    }

    impl Repo {
        pub(super) async fn seeded() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().to_path_buf();
            for args in [
                &["init", "-q", "-b", "main"][..],
                &["config", "user.email", "test@example.com"],
                &["config", "user.name", "Test"],
                &["config", "commit.gpgsign", "false"],
            ] {
                run_git(args, &path).await.unwrap();
            }
            tokio::fs::write(path.join("staged.txt"), "base staged\n")
                .await
                .unwrap();
            tokio::fs::write(path.join("unstaged.txt"), "base unstaged\n")
                .await
                .unwrap();
            run_git(&["add", "."], &path).await.unwrap();
            run_git(&["commit", "-q", "-m", "base"], &path)
                .await
                .unwrap();
            Self { _temp: temp, path }
        }

        async fn modify_and_push(&self, message: Option<&str>) -> String {
            tokio::fs::write(self.path.join("staged.txt"), "stashed\n")
                .await
                .unwrap();
            push_stash(&self.path, message, false).await.unwrap();
            list_stashes(&self.path).await.unwrap()[0].sha.clone()
        }
    }

    #[tokio::test]
    async fn apply_retains_stash_and_successful_pop_drops_it() {
        let repo = Repo::seeded().await;
        let sha = repo.modify_and_push(Some("apply")).await;
        assert_eq!(
            apply_stash(&repo.path, "stash@{0}", &sha).await.unwrap(),
            GitOperationResponse::Completed
        );
        assert_eq!(list_stashes(&repo.path).await.unwrap().len(), 1);
        run_git(&["reset", "--hard", "-q", "HEAD"], &repo.path)
            .await
            .unwrap();
        assert_eq!(
            pop_stash(&repo.path, "stash@{0}", &sha).await.unwrap(),
            GitOperationResponse::Completed
        );
        assert!(list_stashes(&repo.path).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn conflicted_pop_returns_paths_and_retains_stash() {
        let repo = Repo::seeded().await;
        let sha = repo.modify_and_push(Some("conflict")).await;
        tokio::fs::write(repo.path.join("staged.txt"), "current branch\n")
            .await
            .unwrap();
        run_git(&["add", "staged.txt"], &repo.path).await.unwrap();
        run_git(&["commit", "-q", "-m", "current"], &repo.path)
            .await
            .unwrap();

        let outcome = pop_stash(&repo.path, "stash@{0}", &sha).await.unwrap();
        assert_eq!(
            outcome,
            GitOperationResponse::Conflicts {
                conflict_files: vec!["staged.txt".into()]
            }
        );
        assert_eq!(list_stashes(&repo.path).await.unwrap().len(), 1);
        let contents = tokio::fs::read_to_string(repo.path.join("staged.txt"))
            .await
            .unwrap();
        assert!(contents.contains("<<<<<<<"), "{contents}");
        let preexisting = apply_stash(&repo.path, "stash@{0}", &sha)
            .await
            .unwrap_err();
        assert!(matches!(preexisting, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn drop_removes_only_the_verified_entry() {
        let repo = Repo::seeded().await;
        let older_sha = repo.modify_and_push(Some("older")).await;
        repo.modify_and_push(Some("newer")).await;
        drop_stash(&repo.path, "stash@{1}", &older_sha)
            .await
            .unwrap();
        let remaining = list_stashes(&repo.path).await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert!(remaining[0].message.ends_with("newer"));
    }

    #[tokio::test]
    async fn moved_ordinal_and_wrong_sha_are_rejected_before_mutation() {
        let repo = Repo::seeded().await;
        let older_sha = repo.modify_and_push(Some("older")).await;
        let newer_sha = repo.modify_and_push(Some("newer")).await;
        let moved = apply_stash(&repo.path, "stash@{0}", &older_sha)
            .await
            .unwrap_err();
        assert!(matches!(moved, AppError::Conflict(_)), "{moved:?}");
        let wrong = drop_stash(&repo.path, "stash@{1}", &newer_sha)
            .await
            .unwrap_err();
        assert!(matches!(wrong, AppError::Conflict(_)), "{wrong:?}");
        assert_eq!(list_stashes(&repo.path).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn malformed_selector_and_flag_injection_are_rejected() {
        let repo = Repo::seeded().await;
        let sha = repo.modify_and_push(Some("safe")).await;
        for selector in ["--index", "stash@{0} --index", "stash@{-1}", "refs/stash"] {
            let error = apply_stash(&repo.path, selector, &sha).await.unwrap_err();
            assert!(
                matches!(error, AppError::BadRequest(_)),
                "{selector}: {error:?}"
            );
        }
        assert_eq!(list_stashes(&repo.path).await.unwrap().len(), 1);
    }
}
