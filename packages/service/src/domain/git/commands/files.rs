//! File-content fetchers used by the diff viewer (single + batch) and
//! `ls-files` listing.

use std::path::Path;

use crate::domain::git::file_size::{classify_batch_sides, MAX_SINGLE_FILE_SIDE_BYTES};
use crate::domain::git::models::FileContentBatchItem;
use crate::error::AppError;
use crate::shared::git_cli::run_git_background;
use crate::shared::git_z;

use super::diff_side::{read_side, read_side_for_batch};

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
    read_side(
        worktree_path,
        file_path,
        ref_spec,
        MAX_SINGLE_FILE_SIDE_BYTES,
    )
    .await
}

/// Get file content for multiple files (batch). A side that cannot be read
/// fails the whole batch rather than rendering as an added or deleted file.
///
/// Files at or above `LARGE_FILE_BYTES` are streamed for their binary verdict
/// instead of read into memory, and return `is_large: true` with content
/// omitted so the frontend renders its placeholder and pulls the content via
/// the single-file endpoint on opt-in.
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
                    read_side_for_batch(&git_path, &file_path, Some(&old_ref)),
                    read_side_for_batch(&git_path, &file_path, new_ref.as_deref()),
                )?;
                Ok(classify_batch_sides(file_path, old, new))
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
            assert!(
                matches!(
                    error,
                    AppError::Coded {
                        status: axum::http::StatusCode::PAYLOAD_TOO_LARGE,
                        code: super::super::diff_side::FILE_TOO_LARGE,
                        ..
                    }
                ),
                "{error:?}"
            );
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

    #[tokio::test]
    async fn batch_classifies_large_text_and_binary_files_without_inlining_content() {
        use crate::domain::git::file_size::LARGE_FILE_BYTES;

        let tmp = committed_repo();
        let root = tmp.path();
        let large_text = "x".repeat(LARGE_FILE_BYTES as usize + 123);
        let mut large_bin = vec![b'a'; LARGE_FILE_BYTES as usize + 45];
        large_bin[10] = 0;

        std::fs::write(root.join("big.txt"), &large_text).unwrap();
        std::fs::write(root.join("big.bin"), &large_bin).unwrap();
        git(&["add", "big.txt", "big.bin"], root);
        git(&["commit", "-q", "-m", "large"], root);
        std::fs::write(root.join("big.txt"), format!("{large_text}!")).unwrap();

        let items = get_file_content_batch(
            root,
            &["kept.txt".into(), "big.txt".into(), "big.bin".into()],
            "HEAD",
            None,
        )
        .await
        .unwrap();

        let by_path: std::collections::HashMap<_, _> = items
            .into_iter()
            .map(|i| (i.file_path.clone(), i))
            .collect();

        let kept = &by_path["kept.txt"];
        assert!(!kept.is_large);
        assert!(!kept.is_binary);
        assert_eq!(kept.old_content.as_deref(), Some("kept\n"));
        assert_eq!(kept.new_content.as_deref(), Some("kept\n"));

        let big_txt = &by_path["big.txt"];
        assert!(big_txt.is_large);
        assert!(!big_txt.is_binary);
        assert!(big_txt.old_content.is_none());
        assert!(big_txt.new_content.is_none());
        assert_eq!(big_txt.old_size, LARGE_FILE_BYTES + 123);
        assert_eq!(big_txt.new_size, LARGE_FILE_BYTES + 124);

        let big_bin = &by_path["big.bin"];
        assert!(big_bin.is_large);
        assert!(big_bin.is_binary);
        assert!(big_bin.old_content.is_none());
        assert!(big_bin.new_content.is_none());
        assert_eq!(big_bin.old_size, LARGE_FILE_BYTES + 45);
        assert_eq!(big_bin.new_size, LARGE_FILE_BYTES + 45);
    }

    /// A large file is binary in the batch exactly when the single-file
    /// endpoint finds it binary: a Latin-1 byte far past the first 8 KB used
    /// to pass the batch as text, then open as binary. Checked for a working
    /// tree side and a committed side alike.
    #[tokio::test]
    async fn batch_and_single_file_reads_agree_on_large_binary_content() {
        use crate::domain::git::file_size::{classify_content_bytes, LARGE_FILE_BYTES};

        let tmp = committed_repo();
        let root = tmp.path();
        let mut latin1 = vec![b'a'; LARGE_FILE_BYTES as usize + 10];
        latin1.extend_from_slice(b"caf\xe9\n");
        let utf8 = "caf\u{e9}\n".repeat(LARGE_FILE_BYTES as usize / 5);
        std::fs::write(root.join("latin1.txt"), &latin1).unwrap();
        std::fs::write(root.join("utf8.txt"), &utf8).unwrap();
        git(&["add", "latin1.txt", "utf8.txt"], root);
        git(&["commit", "-q", "-m", "large"], root);

        let files = ["latin1.txt".to_string(), "utf8.txt".to_string()];
        for new_ref in [None, Some("HEAD")] {
            let batch = get_file_content_batch(root, &files, "HEAD", new_ref)
                .await
                .unwrap();
            for item in batch {
                let single = classify_content_bytes(
                    item.file_path.clone(),
                    get_diff_side_bytes(root, &item.file_path, Some("HEAD"))
                        .await
                        .unwrap()
                        .unwrap(),
                    get_diff_side_bytes(root, &item.file_path, new_ref)
                        .await
                        .unwrap()
                        .unwrap(),
                    true,
                );
                assert!(item.is_large, "{}", item.file_path);
                assert_eq!(
                    item.is_binary, single.is_binary,
                    "{} ({new_ref:?})",
                    item.file_path
                );
                assert_eq!(item.is_binary, item.file_path == "latin1.txt");
            }
        }
    }
}
