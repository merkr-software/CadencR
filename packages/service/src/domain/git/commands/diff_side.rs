//! One side of a file diff, read from a Git tree or from the working tree, and
//! told apart from a missing side: only a side that truly has no such file is
//! an addition or a deletion. Every failed read is an error, never a fake
//! whole-file diff.

use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::shared::git_cli::{
    git_ref_resolves_background, guard_positionals, head_is_unborn, run_git_background,
    run_git_safe_refs_background_bounded, BoundedGitOutput,
};

use super::util::{format_bytes, read_file_prefix};

mod batch;
pub(super) use batch::read_side_for_batch;

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
/// side has no such file. `max_bytes` caps a read before and during capture.
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

async fn resolve_tree_entry(
    worktree_path: &Path,
    reference: &str,
    file_path: &str,
) -> Result<Option<TreeEntry>, AppError> {
    match tree_entry(worktree_path, reference, file_path).await {
        Ok(entry) => Ok(entry),
        // Git's own message says best why the read failed; a probe that fails
        // as well only confirms the reference is unreadable.
        Err(error) => match base_without_tree(worktree_path, reference).await {
            Ok(BaseWithoutTree::Empty) => Ok(None),
            Ok(BaseWithoutTree::Truncated(commit)) => Err(history_truncated(&commit)),
            Ok(BaseWithoutTree::Unreadable) | Err(_) => Err(error),
        },
    }
}

/// One `ls-tree` answers whether the path is there and what it is, where a
/// blob read would fail alike for a missing path, a gitlink and a bad ref.
async fn read_tree_side(
    worktree_path: &Path,
    reference: &str,
    file_path: &str,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, AppError> {
    let Some(entry) = resolve_tree_entry(worktree_path, reference, file_path).await? else {
        return Ok(None);
    };
    match entry.kind.as_str() {
        "blob" => {
            ensure_file_size(entry.size.unwrap_or(0), max_bytes)?;
            let oid = [entry.oid.as_str()];
            match run_git_safe_refs_background_bounded(
                &["cat-file", "blob"],
                &[],
                &oid,
                worktree_path,
                max_bytes,
            )
            .await?
            {
                BoundedGitOutput::Bytes(bytes) => Ok(Some(bytes)),
                BoundedGitOutput::ExceededLimit => Err(oversized_file_error(max_bytes)),
            }
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
    // `-` for a tree or a gitlink, which have no blob size; `BAD` for an
    // entry whose object the repository does not have.
    let size = match size {
        "-" => None,
        "BAD" => {
            return Err(AppError::git_rejected(format!(
                "fatal: bad object {oid}: the repository is missing the object {file_path} \
                 points to in {reference}"
            )))
        }
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

/// What a reference that names no tree stands for.
enum BaseWithoutTree {
    /// The empty tree: the `HEAD` of a branch with no commit yet (proven, see
    /// [`head_is_unborn`]) or the parent (`<commit>^`) of a root commit. Every
    /// file is an addition there.
    Empty,
    /// The parent of the commit at the boundary of a shallow clone: it exists,
    /// but not in this repository.
    Truncated(String),
    Unreadable,
}

async fn base_without_tree(
    worktree_path: &Path,
    reference: &str,
) -> Result<BaseWithoutTree, AppError> {
    if reference == "HEAD" {
        return Ok(if head_is_unborn(worktree_path).await? {
            BaseWithoutTree::Empty
        } else {
            BaseWithoutTree::Unreadable
        });
    }
    let Some(commit) = reference.strip_suffix('^') else {
        return Ok(BaseWithoutTree::Unreadable);
    };
    if !git_ref_resolves_background(commit, worktree_path).await?
        || git_ref_resolves_background(reference, worktree_path).await?
    {
        return Ok(BaseWithoutTree::Unreadable);
    }
    // A shallow clone cuts history with grafts that read exactly like a root
    // commit; `shallow` lists the commits whose parents were cut off.
    let sha = run_git_background(&["rev-parse", "--verify", commit], worktree_path).await?;
    let sha = sha.trim();
    Ok(
        if shallow_boundaries(worktree_path)
            .await?
            .iter()
            .any(|b| b == sha)
        {
            BaseWithoutTree::Truncated(sha.to_string())
        } else {
            BaseWithoutTree::Empty
        },
    )
}

/// The commits listed in `$GIT_DIR/shallow`; none outside a shallow clone.
async fn shallow_boundaries(worktree_path: &Path) -> Result<Vec<String>, AppError> {
    let path = run_git_background(&["rev-parse", "--git-path", "shallow"], worktree_path).await?;
    let path = worktree_path.join(path.trim());
    match tokio::fs::read_to_string(&path).await {
        Ok(list) => Ok(list.lines().map(str::trim).map(str::to_string).collect()),
        Err(error) if is_missing(&error) => Ok(Vec::new()),
        Err(error) => Err(read_error(&path, &error)),
    }
}

/// Refusal for the earlier side of a commit whose parent a shallow clone left
/// out: showing it empty would turn every file into an addition.
fn history_truncated(commit: &str) -> AppError {
    AppError::coded(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "HISTORY_TRUNCATED",
        format!(
            "History is truncated: {commit} is the boundary of a shallow clone and its parent \
             is not in this repository"
        ),
    )
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
    let read_limit = max_bytes.saturating_add(1);
    match read_file_prefix(&file, read_limit, Some(metadata.len())).await {
        Ok(bytes) => {
            if bytes.len() > max_bytes {
                return Err(oversized_file_error(max_bytes));
            }
            Ok(Some(bytes))
        }
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

/// A directory, symlink, socket or other special file has no text to diff,
/// refused with its own code so the editor's change markers can tell "no text
/// baseline" from a failure. A submodule checkout reads as the commit it has
/// checked out. A path that is gone — missing, or under a folder replaced by a
/// file — is left to the read, which reports it as deleted.
pub(crate) async fn ensure_worktree_side_is_a_file(path: &Path) -> Result<(), AppError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(metadata) if metadata.is_dir() && is_submodule_checkout(path).await? => Ok(()),
        Ok(_) => Err(unsupported_file_type()),
        Err(error) if is_missing(&error) => Ok(()),
        Err(error) => Err(AppError::internal(format!(
            "cannot inspect {}: {error}",
            path.display()
        ))),
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
        return Err(oversized_file_error(max_bytes));
    }
    Ok(())
}

/// Refusal code for a file side past the read cap, the counterpart of
/// `DIFF_TOO_LARGE` for file contents.
pub const FILE_TOO_LARGE: &str = "FILE_TOO_LARGE";

fn oversized_file_error(max_bytes: usize) -> AppError {
    AppError::coded(
        axum::http::StatusCode::PAYLOAD_TOO_LARGE,
        FILE_TOO_LARGE,
        format!(
            "File exceeds the {} display limit",
            format_bytes(max_bytes as u64)
        ),
    )
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

    /// A symlink has no text baseline: refused with its own code, which the
    /// editor's change markers read as "nothing to mark" rather than an error.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_worktree_symlink_is_refused_with_its_own_code() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("target.md"), "x").unwrap();
        std::os::unix::fs::symlink("target.md", dir.path().join("link.md")).unwrap();
        let error = ensure_worktree_side_is_a_file(&dir.path().join("link.md"))
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                AppError::Coded {
                    code: "UNSUPPORTED_FILE_TYPE",
                    ..
                }
            ),
            "{error:?}"
        );
        assert!(
            ensure_worktree_side_is_a_file(&dir.path().join("target.md"))
                .await
                .is_ok()
        );
        assert!(ensure_worktree_side_is_a_file(&dir.path().join("gone.md"))
            .await
            .is_ok());
        // Under a folder replaced by a file: deleted, left to the read.
        let replaced = dir.path().join("target.md/nested.md");
        assert!(ensure_worktree_side_is_a_file(&replaced).await.is_ok());
    }

    /// A blob the repository no longer has is a 422 naming the bad object,
    /// not an unparsable listing (`ls-tree -l` prints `BAD` for its size).
    #[tokio::test]
    async fn a_missing_blob_is_a_named_bad_object() {
        let tmp = repo();
        let root = tmp.path();
        std::fs::write(root.join("a.txt"), "hello\n").unwrap();
        git(&["add", "a.txt"], root);
        git(&["commit", "-qm", "init"], root);
        let oid = String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD:a.txt"])
                .current_dir(root)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let oid = oid.trim();
        std::fs::remove_file(root.join(".git/objects").join(&oid[..2]).join(&oid[2..])).unwrap();

        let error = side(root, "a.txt", Some("HEAD")).await.unwrap_err();
        assert!(matches!(error, AppError::GitRejected(_)), "{error:?}");
        assert!(error.to_string().contains("bad object"), "{error}");
    }

    /// At the boundary of a shallow clone the parent exists but is not here:
    /// the earlier side is refused as truncated history, not read as empty.
    #[tokio::test]
    async fn the_parent_of_a_shallow_boundary_is_truncated_history() {
        let source = repo();
        std::fs::write(source.path().join("f.txt"), "1\n").unwrap();
        git(&["add", "f.txt"], source.path());
        git(&["commit", "-qm", "one"], source.path());
        std::fs::write(source.path().join("f.txt"), "2\n").unwrap();
        git(&["commit", "-qam", "two"], source.path());
        let clones = tempfile::tempdir().unwrap();
        let url = format!("file://{}", source.path().display());
        git(
            &["clone", "-q", "--depth=1", &url, "shallow"],
            clones.path(),
        );
        let clone = clones.path().join("shallow");

        let error = side(&clone, "f.txt", Some("HEAD^")).await.unwrap_err();
        assert!(
            matches!(
                error,
                AppError::Coded {
                    code: "HISTORY_TRUNCATED",
                    ..
                }
            ),
            "{error:?}"
        );
        // A real root commit still reads as an empty base.
        assert_eq!(
            side(source.path(), "f.txt", Some("HEAD~1^")).await.unwrap(),
            None
        );
    }
}
