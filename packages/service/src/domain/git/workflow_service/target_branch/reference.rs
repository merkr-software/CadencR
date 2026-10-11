use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::git_ref_resolves_readonly;

/// Resolve an existing object locally first, then through `origin/<ref>`.
pub(super) async fn branch_exists(repo: &Path, name: &str) -> Result<bool, AppError> {
    if git_ref_resolves_readonly(name, repo).await? {
        return Ok(true);
    }
    git_ref_resolves_readonly(&format!("origin/{name}"), repo).await
}

#[cfg(test)]
mod tests {
    use super::super::tests::run_git_for_test;
    use super::*;

    fn repository() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
            &["commit", "--allow-empty", "-q", "-m", "initial"],
            &["commit", "--allow-empty", "-q", "-m", "second"],
            &["tag", "release"],
            &["update-ref", "refs/remotes/origin/remote-only", "HEAD"],
        ] {
            run_git_for_test(root, args);
        }
        directory
    }

    #[tokio::test]
    async fn accepts_local_remote_and_existing_revision_expressions() {
        let directory = repository();
        for reference in [
            "main",
            "remote-only",
            "origin/remote-only",
            "HEAD",
            "HEAD~1",
            "HEAD@{0}",
            "release",
        ] {
            assert!(
                branch_exists(directory.path(), reference).await.unwrap(),
                "{reference}"
            );
        }
    }

    #[tokio::test]
    async fn missing_references_and_nonexistent_full_object_ids_do_not_resolve() {
        let directory = repository();
        for reference in ["missing", "1111111111111111111111111111111111111111"] {
            assert!(
                !branch_exists(directory.path(), reference).await.unwrap(),
                "{reference}"
            );
        }
    }

    #[tokio::test]
    async fn rejects_options_and_multiple_batch_requests_without_modifying_the_repository() {
        let directory = repository();
        for reference in [
            "--help",
            "--verify",
            "-c core.hooksPath=outside",
            "HEAD\nmain",
            "HEAD\rmain",
            "HEAD\0main",
        ] {
            assert!(
                matches!(
                    branch_exists(directory.path(), reference).await,
                    Err(AppError::BadRequest(_))
                ),
                "{reference:?}"
            );
        }
        assert!(!directory.path().join("outside").exists());
    }

    #[tokio::test]
    async fn repository_errors_are_not_reported_as_missing_references() {
        let directory = tempfile::tempdir().unwrap();
        assert!(branch_exists(directory.path(), "HEAD").await.is_err());
    }
}
