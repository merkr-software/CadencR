//! One side of a file diff, read from a Git tree or from the working tree, and
//! told apart from a missing side: only a side that truly has no such file is
//! an addition or a deletion. Every failed read is an error, never a fake
//! whole-file diff.

use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::shared::git_cli::{
    git_ref_resolves_background, guard_positionals, head_is_unborn, run_git_background,
    run_git_safe_refs_bytes,
};

/// Refusal code for a path with no text to diff (a directory, a symlink, a
/// socket…), so a view that only decorates (the editor's change markers) can
/// tell "nothing to show" from a failure.
pub const UNSUPPORTED_FILE_TYPE: &str = "UNSUPPORTED_FILE_TYPE";

pub fn unsupported_file_type() -> AppError {
    AppError::coded(
        axum::http::StatusCode::BAD_REQUEST,
        UNSUPPORTED_FILE_TYPE,
        "Unsupported file type cannot be opened as text",
    )
}

/// A path that does not exist, or whose parent is no longer a directory (a
/// folder replaced by a file of the same name): either way the file is gone.
pub(crate) fn is_missing(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// The bytes at `ref_spec` (the working tree when `None`), or `None` when that
/// side has no such file. `max_bytes` caps a read before it happens.
pub(super) async fn read_side(
    worktree_path: &Path,
    file_path: &str,
    ref_spec: Option<&str>,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, AppError> {
    match ref_spec {
        None => read_worktree_side(worktree_path, file_path, max_bytes).await,
        Some(reference) => read_tree_side(worktree_path, reference, file_path, max_bytes).await,
    }
}

/// What a tree holds at a path, as `ls-tree -l` reports it.
struct TreeEntry {
    kind: String,
    oid: String,
    size: Option<u64>,
}

/// One `ls-tree` answers whether the path is there and what it is, where a
/// blob read would fail alike for a missing path, a gitlink and a bad ref.
async fn read_tree_side(
    worktree_path: &Path,
    reference: &str,
    file_path: &str,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, AppError> {
    let entry = match tree_entry(worktree_path, reference, file_path).await {
        Ok(entry) => entry,
        // Git's own message says best why the read failed; a probe that fails
        // as well only confirms the reference is unreadable.
        Err(error) => match stands_for_empty_tree(worktree_path, reference).await {
            Ok(true) => return Ok(None),
            Ok(false) | Err(_) => return Err(error),
        },
    };
    let Some(entry) = entry else {
        return Ok(None);
    };
    match entry.kind.as_str() {
        "blob" => {
            ensure_file_size(entry.size.unwrap_or(0), max_bytes)?;
            let oid = [entry.oid.as_str()];
            let blob = run_git_safe_refs_bytes(&["cat-file", "blob"], &[], &oid, worktree_path);
            Ok(Some(blob.await?))
        }
        // A submodule reads as `git diff` shows it: the commit it points to.
        "commit" => Ok(Some(subproject_commit(&entry.oid))),
        _ => Err(unsupported_file_type()),
    }
}

async fn tree_entry(
    worktree_path: &Path,
    reference: &str,
    file_path: &str,
) -> Result<Option<TreeEntry>, AppError> {
    guard_positionals(&[reference])?;
    // Literal and root-relative, like `<ref>:<path>`: no glob or `:(magic)`.
    let args = [
        "--literal-pathspecs",
        "ls-tree",
        "-l",
        "-z",
        "--full-tree",
        reference,
        "--",
        file_path,
    ];
    let listing = run_git_background(&args, worktree_path).await?;
    let Some(record) = listing.split('\0').find(|record| !record.is_empty()) else {
        return Ok(None);
    };
    let (meta, _path) = record.split_once('\t').ok_or_else(|| bad_listing(record))?;
    let mut fields = meta.split_whitespace();
    let (Some(_mode), Some(kind), Some(oid), Some(size)) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return Err(bad_listing(record));
    };
    // `-` for a tree or a gitlink, which have no blob size.
    let size = match size {
        "-" => None,
        size => Some(size.parse().map_err(|_| bad_listing(record))?),
    };
    Ok(Some(TreeEntry {
        kind: kind.to_string(),
        oid: oid.to_string(),
        size,
    }))
}

fn bad_listing(record: &str) -> AppError {
    AppError::git_command(format!("unexpected git ls-tree output: {record:?}"))
}

/// Whether a reference that names no tree still stands for the empty one: the
/// `HEAD` of a branch with no commit yet (proven, see [`head_is_unborn`]) or
/// the parent (`<commit>^`) of a root commit. Every file is an addition there.
async fn stands_for_empty_tree(worktree_path: &Path, reference: &str) -> Result<bool, AppError> {
    if reference == "HEAD" {
        return head_is_unborn(worktree_path).await;
    }
    let Some(commit) = reference.strip_suffix('^') else {
        return Ok(false);
    };
    Ok(git_ref_resolves_background(commit, worktree_path).await?
        && !git_ref_resolves_background(reference, worktree_path).await?)
}

async fn read_worktree_side(
    worktree_path: &Path,
    file_path: &str,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, AppError> {
    let Some(file) = resolve_worktree_file(worktree_path, file_path)? else {
        return Ok(None);
    };
    let metadata = match tokio::fs::metadata(&file).await {
        Ok(metadata) => metadata,
        Err(error) if is_missing(&error) => return Ok(None),
        Err(error) => return Err(read_error(&file, &error)),
    };
    if metadata.is_dir() {
        return submodule_side(&file).await;
    }
    ensure_file_size(metadata.len(), max_bytes)?;
    match tokio::fs::read(&file).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if is_missing(&error) => Ok(None),
        Err(error) => Err(read_error(&file, &error)),
    }
}

/// A checked-out submodule reads as the commit it has checked out; any other
/// directory has no text to diff.
async fn submodule_side(directory: &Path) -> Result<Option<Vec<u8>>, AppError> {
    if !is_submodule_checkout(directory).await? {
        return Err(unsupported_file_type());
    }
    let head = run_git_background(&["rev-parse", "--verify", "HEAD"], directory).await?;
    Ok(Some(subproject_commit(head.trim())))
}

/// A directory holding its own `.git` (a directory, or a file pointing at the
/// superproject's modules) is a submodule checkout.
pub(crate) async fn is_submodule_checkout(directory: &Path) -> Result<bool, AppError> {
    match tokio::fs::symlink_metadata(directory.join(".git")).await {
        Ok(_) => Ok(true),
        Err(error) if is_missing(&error) => Ok(false),
        Err(error) => Err(read_error(directory, &error)),
    }
}

fn subproject_commit(oid: &str) -> Vec<u8> {
    format!("Subproject commit {oid}\n").into_bytes()
}

fn resolve_worktree_file(
    worktree_path: &Path,
    file_path: &str,
) -> Result<Option<PathBuf>, AppError> {
    let canonical_worktree = worktree_path
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("Invalid worktree path: {e}")))?;
    let canonical_file = match worktree_path.join(file_path).canonicalize() {
        Ok(canonical_file) => canonical_file,
        Err(error) if is_missing(&error) => return Ok(None),
        Err(error) => return Err(read_error(Path::new(file_path), &error)),
    };
    if !canonical_file.starts_with(&canonical_worktree) {
        return Err(AppError::BadRequest("Path traversal not allowed".into()));
    }
    Ok(Some(canonical_file))
}

fn read_error(path: &Path, error: &std::io::Error) -> AppError {
    AppError::internal(format!("cannot read {}: {error}", path.display()))
}

fn ensure_file_size(len: u64, max_bytes: usize) -> Result<(), AppError> {
    if len > max_bytes as u64 {
        return Err(AppError::BadRequest(format!(
            "File exceeds {} MB size limit",
            max_bytes / (1024 * 1024)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(args: &[&str], cwd: &Path) {
        let status = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("git available");
        assert!(status.success(), "git {args:?} failed");
    }

    fn repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        git(&["init", "-q"], tmp.path());
        git(&["symbolic-ref", "HEAD", "refs/heads/main"], tmp.path());
        tmp
    }

    async fn side(
        root: &Path,
        path: &str,
        reference: Option<&str>,
    ) -> Result<Option<Vec<u8>>, AppError> {
        read_side(root, path, reference, usize::MAX).await
    }

    /// A branch ref holding garbage makes `HEAD` fail to resolve exactly like
    /// an unborn branch does; only the latter is an empty base.
    #[tokio::test]
    async fn a_corrupt_branch_ref_is_an_error_not_an_unborn_branch() {
        let tmp = repo();
        let root = tmp.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        assert_eq!(side(root, "a.txt", Some("HEAD")).await.unwrap(), None);

        git(&["add", "a.txt"], root);
        git(&["commit", "-qm", "init"], root);
        std::fs::write(root.join(".git/refs/heads/main"), "invalid\n").unwrap();
        assert!(side(root, "a.txt", Some("HEAD")).await.is_err());
    }

    /// A folder replaced by a file of the same name leaves its files deleted:
    /// `ENOTDIR` on the working-tree side is an absence, not a failure.
    #[tokio::test]
    async fn a_folder_replaced_by_a_file_reads_as_a_deletion() {
        let tmp = repo();
        let root = tmp.path();
        std::fs::write(root.join("folder"), "now a file\n").unwrap();
        assert_eq!(side(root, "folder/nested.txt", None).await.unwrap(), None);
    }

    /// A gitlink reads as `git diff` shows it, on both sides, rather than as
    /// a blob read that fails.
    #[tokio::test]
    async fn a_submodule_reads_as_the_commit_it_points_to() {
        let tmp = repo();
        let root = tmp.path();
        let module = root.join("module");
        std::fs::create_dir(&module).unwrap();
        git(&["init", "-q"], &module);
        git(&["commit", "-q", "--allow-empty", "-m", "sub"], &module);
        let sub_head = String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&module)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        git(&["add", "module"], root);
        git(&["commit", "-qm", "add module"], root);

        let expected = format!("Subproject commit {}\n", sub_head.trim()).into_bytes();
        assert_eq!(
            side(root, "module", Some("HEAD")).await.unwrap(),
            Some(expected.clone())
        );
        assert_eq!(side(root, "module", None).await.unwrap(), Some(expected));
    }

    /// Paths are literal and root-relative, like `<ref>:<path>`: glob and
    /// pathspec-magic characters name the file itself.
    #[tokio::test]
    async fn tree_paths_are_literal() {
        let tmp = repo();
        let root = tmp.path();
        for (name, body) in [("a?", "q"), ("ab", "b"), (":(top)x", "m")] {
            std::fs::write(root.join(name), body).unwrap();
        }
        git(&["add", "-A"], root);
        git(&["commit", "-qm", "init"], root);
        assert_eq!(
            side(root, "a?", Some("HEAD")).await.unwrap(),
            Some(b"q".to_vec())
        );
        assert_eq!(
            side(root, ":(top)x", Some("HEAD")).await.unwrap(),
            Some(b"m".to_vec())
        );
        assert_eq!(side(root, "a*", Some("HEAD")).await.unwrap(), None);
    }
}
