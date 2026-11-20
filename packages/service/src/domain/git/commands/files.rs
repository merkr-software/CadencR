//! File-content fetchers used by the diff viewer (single + batch) and
//! `ls-files` listing.

use std::path::Path;

use crate::domain::git::file_size::classify_content_bytes;
use crate::domain::git::models::FileContentBatchItem;
use crate::error::AppError;
use crate::shared::git_cli::run_git_background;
use crate::shared::git_z;

use super::diff_side::read_side;

/// Get exact file bytes at a ref, or from the working tree when `ref_spec` is
/// `None`. This never applies UTF-8 conversion. A path the side does not hold
/// is `NotFound`.
pub async fn get_file_bytes(
    worktree_path: &Path,
    file_path: &str,
    ref_spec: Option<&str>,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    read_side(worktree_path, file_path, ref_spec, max_bytes)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("{file_path} not found")))
}

/// One side of a file diff: the bytes at `ref_spec` (the working tree when
/// `None`), or `None` when that side has no such file — the file was added or
/// deleted. Every other failure is an error: a ref that does not resolve or a
/// Git read that fails must never pass for an added or deleted file.
pub async fn get_diff_side_bytes(
    worktree_path: &Path,
    file_path: &str,
    ref_spec: Option<&str>,
) -> Result<Option<Vec<u8>>, AppError> {
    read_side(worktree_path, file_path, ref_spec, usize::MAX).await
}

/// Get file content for multiple files (batch). A side that cannot be read
/// fails the whole batch rather than rendering as an added or deleted file.
///
/// We fetch both sides of every file (same per-file cost as the original
/// implementation) and then derive size + binary + large flags from the
/// returned content. For binary files or files whose largest side meets
/// `LARGE_FILE_BYTES`, content is omitted from the response — the frontend
/// renders a placeholder and pulls the content via the single-file endpoint
/// on opt-in. Deriving metadata from the already-fetched content avoids
/// adding extra git calls per file (which was making the batch slow and
/// produced visible empty blocks while the diff view loaded).
pub async fn get_file_content_batch(
    git_path: &Path,
    file_paths: &[String],
    old_ref: &str,
    new_ref: Option<&str>,
) -> Result<Vec<FileContentBatchItem>, AppError> {
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }

    use futures::stream::{self, StreamExt};

    let git_path = git_path.to_path_buf();
    let old_ref = old_ref.to_string();
    let new_ref = new_ref.map(|s| s.to_string());

    let items: Vec<Result<FileContentBatchItem, AppError>> = stream::iter(file_paths.to_vec())
        .map(|file_path| {
            let git_path = git_path.clone();
            let old_ref = old_ref.clone();
            let new_ref = new_ref.clone();
            async move {
                let (old, new) = tokio::try_join!(
                    get_diff_side_bytes(&git_path, &file_path, Some(&old_ref)),
                    get_diff_side_bytes(&git_path, &file_path, new_ref.as_deref()),
                )?;
                Ok(classify_content_bytes(
                    file_path,
                    old.unwrap_or_default(),
                    new.unwrap_or_default(),
                    /* keep_large_content */ false,
                ))
            }
        })
        .buffer_unordered(20)
        .collect()
        .await;

    items.into_iter().collect()
}

/// List files in the worktree the user might want to open from Cmd+P:
/// every git-tracked file, plus any env files (`.env`, `.env.local`,
/// `local.env`, ...) that are usually gitignored. Agents do most of the
/// editing inside Cadencr, but humans still need to reach env files by
/// hand, so this endpoint deliberately steps around `.gitignore` for the
/// env-file allowlist while leaving every other untracked path alone.
pub async fn list_files(worktree_path: &Path) -> Result<Vec<String>, AppError> {
    let stdout = run_git_background(&["ls-files", "-z"], worktree_path).await?;
    let mut files = git_z::paths(&stdout);

    // The env-file scan touches the filesystem; do it off the runtime
    // thread to keep the handler non-blocking.
    let wt = worktree_path.to_path_buf();
    let env_files: Vec<String> =
        tokio::task::spawn_blocking(move || crate::shared::env_file::find_env_files(&wt))
            .await
            .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))?;

    let mut seen: std::collections::HashSet<String> = files.iter().cloned().collect();
    for rel in env_files {
        if seen.insert(rel.clone()) {
            files.push(rel);
        }
    }
    // Re-sort so the union is stable; `git ls-files` output is already
    // sorted, but appending env files preserves order only when none are
    // new, so we sort defensively.
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(args: &[&str], cwd: &Path) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("git available");
        assert!(status.success(), "git {args:?} failed");
    }

    #[tokio::test]
    async fn list_files_includes_gitignored_env_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        git(&["init", "-q", "-b", "main"], root);
        git(&["config", "user.email", "test@example.com"], root);
        git(&["config", "user.name", "Test"], root);
        git(&["config", "commit.gpgsign", "false"], root);
        git(&["config", "tag.gpgsign", "false"], root);
        std::fs::write(root.join(".gitignore"), ".env*\n").unwrap();
        std::fs::write(root.join("README.md"), "# hi").unwrap();
        std::fs::write(root.join("src.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join(".env"), "FOO=bar").unwrap();
        std::fs::write(root.join(".env.local"), "FOO=local").unwrap();
        std::fs::write(root.join("local.env"), "FOO=user").unwrap();
        std::fs::write(root.join("development.env"), "FOO=dev").unwrap();
        std::fs::write(root.join("untracked.txt"), "ignored junk").unwrap();
        git(&["add", ".gitignore", "README.md", "src.rs"], root);
        git(&["commit", "-q", "-m", "init"], root);

        let listed = list_files(root).await.expect("list_files");

        // Tracked files still appear.
        assert!(listed.iter().any(|p| p == "README.md"));
        assert!(listed.iter().any(|p| p == "src.rs"));
        assert!(listed.iter().any(|p| p == ".gitignore"));
        // Env files appear even though gitignored.
        assert!(
            listed.iter().any(|p| p == ".env"),
            "missing .env: {listed:?}"
        );
        assert!(listed.iter().any(|p| p == ".env.local"));
        // Plain-suffix env files appear too (these typically aren't gitignored,
        // but git ls-files wouldn't list them if untracked).
        assert!(listed.iter().any(|p| p == "local.env"));
        assert!(listed.iter().any(|p| p == "development.env"));
        // We must not start listing every untracked file — only env files.
        assert!(
            !listed.iter().any(|p| p == "untracked.txt"),
            "untracked non-env file leaked through: {listed:?}",
        );
    }

    #[tokio::test]
    async fn get_file_bytes_preserves_binary_data_from_ref_and_worktree() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        git(&["init", "-q", "-b", "main"], root);
        git(&["config", "user.email", "test@example.com"], root);
        git(&["config", "user.name", "Test"], root);
        git(&["config", "commit.gpgsign", "false"], root);

        let committed = b"\x89PNG\r\n\x1a\n\0committed";
        let working = b"\x89PNG\r\n\x1a\n\0working";
        std::fs::write(root.join("image.png"), committed).unwrap();
        git(&["add", "image.png"], root);
        git(&["commit", "-q", "-m", "add image"], root);
        std::fs::write(root.join("image.png"), working).unwrap();

        assert_eq!(
            get_file_bytes(root, "image.png", Some("HEAD"), usize::MAX)
                .await
                .unwrap(),
            committed
        );
        assert_eq!(
            get_file_bytes(root, "image.png", None, usize::MAX)
                .await
                .unwrap(),
            working
        );
    }

    #[tokio::test]
    async fn get_file_bytes_rejects_oversized_ref_and_worktree_before_reading() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        git(&["init", "-q", "-b", "main"], root);
        git(&["config", "user.email", "test@example.com"], root);
        git(&["config", "user.name", "Test"], root);
        git(&["config", "commit.gpgsign", "false"], root);
        std::fs::write(root.join("image.png"), b"1234").unwrap();
        git(&["add", "image.png"], root);
        git(&["commit", "-q", "-m", "add image"], root);

        for reference in [Some("HEAD"), None] {
            let error = get_file_bytes(root, "image.png", reference, 3)
                .await
                .unwrap_err();
            assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
        }
    }

    fn committed_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        git(&["init", "-q", "-b", "main"], root);
        git(&["config", "user.email", "test@example.com"], root);
        git(&["config", "user.name", "Test"], root);
        git(&["config", "commit.gpgsign", "false"], root);
        std::fs::write(root.join("kept.txt"), "kept\n").unwrap();
        git(&["add", "kept.txt"], root);
        git(&["commit", "-q", "-m", "root"], root);
        tmp
    }

    /// Only a side whose tree (or working tree) lacks the file reads as an
    /// addition or deletion. A ref that does not resolve used to read the
    /// same way, turning a Git failure into a whole-file add/delete diff.
    #[tokio::test]
    async fn diff_sides_tell_an_absent_file_from_a_failed_read() {
        let tmp = committed_repo();
        let root = tmp.path();

        let kept = get_diff_side_bytes(root, "kept.txt", Some("HEAD")).await;
        assert_eq!(kept.unwrap().as_deref(), Some(&b"kept\n"[..]));
        assert_eq!(
            get_diff_side_bytes(root, "new.txt", Some("HEAD"))
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            get_diff_side_bytes(root, "gone.txt", None).await.unwrap(),
            None
        );

        assert!(get_diff_side_bytes(root, "kept.txt", Some("missing"))
            .await
            .is_err());
        let batch = get_file_content_batch(root, &["kept.txt".into()], "missing", None).await;
        assert!(batch.is_err());
    }

    /// An unreadable working-tree file is a failure, not a deleted file.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unreadable_worktree_file_is_not_a_deletion() {
        if !crate::shared::test_dirs::permissions_bind() {
            return;
        }
        use std::os::unix::fs::PermissionsExt as _;

        let tmp = committed_repo();
        let root = tmp.path();
        let locked = root.join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("secret.txt"), "x").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let result = get_diff_side_bytes(root, "locked/secret.txt", None).await;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err(), "{result:?}");
    }

    /// The parent of a root commit and the `HEAD` of an unborn branch stand
    /// for the empty tree: every file is an addition there, not a failed read.
    #[tokio::test]
    async fn a_root_commit_and_an_unborn_branch_read_as_empty_bases() {
        let tmp = committed_repo();
        let root = tmp.path();
        assert_eq!(
            get_diff_side_bytes(root, "kept.txt", Some("HEAD^"))
                .await
                .unwrap(),
            None
        );
        assert!(get_diff_side_bytes(root, "kept.txt", Some("missing^"))
            .await
            .is_err());

        let unborn = tempfile::tempdir().expect("tempdir");
        git(&["init", "-q"], unborn.path());
        std::fs::write(unborn.path().join("draft.txt"), "x").unwrap();
        assert_eq!(
            get_diff_side_bytes(unborn.path(), "draft.txt", Some("HEAD"))
                .await
                .unwrap(),
            None
        );
    }
}
