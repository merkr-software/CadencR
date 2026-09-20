use std::path::Path;

use crate::domain::git::host::{detect_remote, GitHost};
use crate::error::AppError;

use super::invalid;

pub(in crate::domain::projects::publication_release) async fn inspect_git(
    root: &Path,
    repository: &str,
) -> Result<String, AppError> {
    let top = git(root, &["rev-parse", "--show-toplevel"]).await?;
    let canonical =
        std::fs::canonicalize(top.trim()).map_err(|_| invalid("Git root is invalid"))?;
    if canonical != root {
        return Err(invalid("project must be a dedicated Git repository root"));
    }
    if !git(root, &["status", "--porcelain", "--untracked-files=normal"])
        .await?
        .is_empty()
    {
        return Err(invalid("Git worktree must be clean before release"));
    }
    let head = git(root, &["rev-parse", "--verify", "HEAD"]).await?;
    if head.len() != 40 || !head.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("Git HEAD must be an exact 40-character commit id"));
    }
    let origin = git(root, &["config", "--get", "remote.origin.url"]).await?;
    let remote =
        detect_remote(&origin).ok_or_else(|| invalid("origin is not a supported remote"))?;
    if remote.host != GitHost::GitHub
        || remote.hostname != "github.com"
        || format!("{}/{}", remote.owner, remote.repo) != repository
    {
        return Err(invalid(
            "origin must be the same public GitHub repository as package metadata",
        ));
    }
    Ok(head)
}

async fn git(root: &Path, args: &[&str]) -> Result<String, AppError> {
    crate::shared::git_cli::run_git_readonly_bounded(args, root)
        .await
        .map_err(|error| invalid(format!("Git repository inspection failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "-q"]);
        std::fs::write(dir.path().join("tracked"), "clean").unwrap();
        run(dir.path(), &["add", "tracked"]);
        run(
            dir.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-qm",
                "initial",
            ],
        );
        run(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/acme/provider.git",
            ],
        );
        dir
    }

    #[tokio::test]
    async fn rejects_dirty_worktree_and_mismatched_origin() {
        let dirty = repository();
        std::fs::write(dirty.path().join("untracked"), "dirty").unwrap();
        assert!(
            inspect_git(&dirty.path().canonicalize().unwrap(), "acme/provider")
                .await
                .is_err()
        );
        let wrong_origin = repository();
        assert!(inspect_git(
            &wrong_origin.path().canonicalize().unwrap(),
            "other/provider"
        )
        .await
        .is_err());
        assert!(inspect_git(
            &wrong_origin.path().canonicalize().unwrap(),
            "acme/provider"
        )
        .await
        .is_ok());
    }
}
