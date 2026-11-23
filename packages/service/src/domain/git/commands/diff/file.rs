//! One file's unified diff, the diff pane's per-row fetch.

use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::{
    guard_positionals, head_is_unborn, run_git_safe_background, run_git_safe_background_bounded,
};
use crate::shared::git_z;

use super::super::stash::commit_diff;
use super::super::untracked::synthesize_untracked_new_file_diff;
use super::super::util::{branch_read_error, empty_tree, FirstParentDiff};
use super::{decode_bounded_diff, DiffScope, MAX_FILE_DIFF_BYTES};

/// Get the unified diff for a single file. Same mode/ref semantics as
/// [`super::get_diff`], scoped to `file_path` via a trailing `-- <path>` so the
/// pane can load one file's patch at a time instead of the whole working-tree
/// diff. A patch over 10 MiB is refused with `413 DIFF_TOO_LARGE`.
///
/// `old_file` is the pre-rename path for a rename/copy (`R*`/`C*`) entry from
/// the changed-files list, or `None` otherwise. It's passed as a *second*
/// pathspec so git can pair the old path's deletion with the new path's
/// addition and emit a `rename from/to` block with just the edited hunk —
/// without it, `git diff -- <new>` only sees the new path and reports the whole
/// file as additions (`new file mode`).
///
/// `run_git_safe_background*` inserts the `--` separator, rejects a path that
/// begins with `-`, and prevents this observational request from refreshing
/// the real index. Refs (`target_branch`, `commit_sha`) are guarded against
/// flag-injection separately. Git errors (e.g. a bad ref) propagate as an
/// `AppError` so the HTTP response fails and the row shows its error state,
/// rather than being swallowed into an empty "no hunks" diff.
pub async fn get_file_diff(
    worktree_path: &Path,
    mode: &str,
    target_branch: Option<&str>,
    commit_sha: Option<&str>,
    file_path: &str,
    old_file: Option<&str>,
) -> Result<String, AppError> {
    get_file_diff_with_limit(
        worktree_path,
        mode,
        target_branch,
        commit_sha,
        file_path,
        old_file,
        MAX_FILE_DIFF_BYTES,
    )
    .await
}

async fn get_file_diff_with_limit(
    worktree_path: &Path,
    mode: &str,
    target_branch: Option<&str>,
    commit_sha: Option<&str>,
    file_path: &str,
    old_file: Option<&str>,
    max_bytes: usize,
) -> Result<String, AppError> {
    // For a rename/copy, scope to BOTH the old and new paths so git's rename
    // detection can pair them; otherwise just the one path.
    let paths: Vec<&str> = match old_file {
        Some(old) if old != file_path => vec![old, file_path],
        _ => vec![file_path],
    };
    if let Some(sha) = commit_sha {
        return commit_file_diff(worktree_path, sha, &paths, max_bytes).await;
    }
    if mode == "branch" {
        let branch = target_branch.unwrap_or("main");
        guard_positionals(&[branch])?;
        let range = format!("{branch}...HEAD");
        return match run_git_safe_background_bounded(
            &["diff", &range],
            &[],
            &paths,
            worktree_path,
            max_bytes,
        )
        .await
        {
            Ok(output) => decode_bounded_diff(output, DiffScope::File, max_bytes),
            Err(error) => Err(branch_read_error(worktree_path, branch, error).await),
        };
    }
    uncommitted_file_diff(worktree_path, file_path, &paths, max_bytes).await
}

async fn commit_file_diff(
    worktree_path: &Path,
    sha: &str,
    paths: &[&str],
    max_bytes: usize,
) -> Result<String, AppError> {
    guard_positionals(&[sha])?;
    // `diff-tree --root` diffs a commit against its parent (or the empty
    // tree for a root commit) in one call, so it handles both cases without
    // a `sha^..sha` probe whose errors we'd have to swallow to reach the
    // root-commit fallback. `-M` matches the rename detection the commit
    // changed-files listing uses, so file list and file diff agree, and
    // `FirstParentDiff` keeps merge commits (every stash is one) from
    // diffing to nothing.
    let target = FirstParentDiff::of(worktree_path, sha).await?;
    let args = [
        &["diff-tree", "--no-commit-id", "--root", "-M", "-p"],
        target.flags,
        &target.revs(),
    ]
    .concat();
    let diff = decode_bounded_diff(
        run_git_safe_background_bounded(&args, &[], paths, worktree_path, max_bytes).await?,
        DiffScope::File,
        max_bytes,
    )?;
    if !diff.is_empty() {
        return Ok(diff);
    }
    // Empty means this path isn't in the first-parent diff at all. For a
    // stash pushed with `--include-untracked` that is exactly what its new
    // files look like — they live in a third parent — so read them from
    // there before reporting "no hunks". Every other commit falls straight
    // through with the empty diff it really has.
    let Some(parent) = commit_diff::untracked_parent(worktree_path, sha).await? else {
        return Ok(diff);
    };
    decode_bounded_diff(
        run_git_safe_background_bounded(
            &["diff-tree", "--no-commit-id", "--root", "-p", &parent],
            &[],
            paths,
            worktree_path,
            max_bytes,
        )
        .await?,
        DiffScope::File,
        max_bytes,
    )
}

/// Worktree / uncommitted mode: `diff HEAD` folds staged + unstaged changes
/// into a single coherent block per file (unlike the aggregate `get_diff`,
/// which concatenates `diff` + `diff --cached` — fine for a whole-tree dump,
/// but it would hand a partially-staged file two `diff --git` headers here).
/// A tracked file always appears there; only an empty diff can be an
/// untracked file (absent from HEAD), so the extra `ls-files` probe and the
/// synthesis are paid in that case alone rather than for every tracked file.
async fn uncommitted_file_diff(
    worktree_path: &Path,
    file_path: &str,
    paths: &[&str],
    max_bytes: usize,
) -> Result<String, AppError> {
    let tracked = worktree_file_diff(worktree_path, paths, max_bytes).await?;
    if !tracked.is_empty() {
        return Ok(tracked);
    }
    let new_only = [file_path];
    let untracked = run_git_safe_background(
        &["ls-files", "--others", "--exclude-standard", "-z"],
        &[],
        &new_only,
        worktree_path,
    )
    .await?;
    if !git_z::paths(&untracked)
        .iter()
        .any(|path| path == file_path)
    {
        return Ok(tracked);
    }
    Ok(
        match synthesize_untracked_new_file_diff(worktree_path, file_path).await? {
            Some(block) => block,
            // Synthesis skips binary (and too-large-binary) untracked files.
            // The aggregate diff just omits them, but a per-file request
            // names a file the changed-files list DID surface — so emit a
            // minimal binary marker, otherwise the row shows "No text hunks"
            // instead of the "Binary file" placeholder the frontend draws.
            None => format!(
                "diff --git a/{file_path} b/{file_path}\nnew file mode 100644\nBinary files /dev/null and b/{file_path} differ\n"
            ),
        },
    )
}

/// `git diff HEAD -- <paths>`: staged and unstaged changes in one block. On a
/// branch with no commit yet there is no `HEAD` to compare with, so the
/// changes are read against the empty tree — the file a first `git add`
/// staged is an addition, not a "bad revision".
async fn worktree_file_diff(
    worktree_path: &Path,
    paths: &[&str],
    max_bytes: usize,
) -> Result<String, AppError> {
    let error = match run_git_safe_background_bounded(
        &["diff", "HEAD"],
        &[],
        paths,
        worktree_path,
        max_bytes,
    )
    .await
    {
        Ok(output) => return decode_bounded_diff(output, DiffScope::File, max_bytes),
        Err(error) => error,
    };
    if !matches!(head_is_unborn(worktree_path).await, Ok(true)) {
        // Git's own message says best why the diff failed.
        return Err(error);
    }
    let tree = empty_tree(worktree_path).await?;
    decode_bounded_diff(
        run_git_safe_background_bounded(&["diff", &tree], &[], paths, worktree_path, max_bytes)
            .await?,
        DiffScope::File,
        max_bytes,
    )
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{
        git, init_repo, repo_with_mixed_stash, rev_parse, too_large_message,
    };
    use super::*;

    /// The per-file diff must scope to the requested path and fold staged +
    /// unstaged edits into a single block, while ignoring every other file.
    #[tokio::test]
    async fn get_file_diff_scopes_to_one_file_and_folds_staged() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("b.txt"), "keep\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "init"], root);

        // a.txt: one staged edit + one unstaged edit; b.txt: untouched.
        std::fs::write(root.join("a.txt"), "ONE\ntwo\n").unwrap();
        git(&["add", "a.txt"], root);
        std::fs::write(root.join("a.txt"), "ONE\nTWO\n").unwrap();

        let diff = get_file_diff(root, "uncommitted", None, None, "a.txt", None)
            .await
            .unwrap();

        assert!(diff.contains("diff --git a/a.txt b/a.txt"), "{diff}");
        // Combined HEAD-vs-worktree yields both edited lines in one block…
        assert!(diff.contains("+ONE"));
        assert!(diff.contains("+TWO"));
        // …with exactly one file header, and never touches b.txt.
        assert_eq!(diff.matches("diff --git").count(), 1, "{diff}");
        assert!(!diff.contains("b.txt"), "{diff}");
    }

    /// An untracked file has no HEAD/index entry, so it must be synthesized as
    /// a new-file diff.
    #[tokio::test]
    async fn get_file_diff_synthesizes_untracked_new_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "init"], root);

        std::fs::write(root.join("fresh.txt"), "hello\nworld\n").unwrap();

        let diff = get_file_diff(root, "uncommitted", None, None, "fresh.txt", None)
            .await
            .unwrap();

        assert!(diff.contains("new file mode"), "{diff}");
        assert!(diff.contains("+hello"));
        assert!(diff.contains("+world"));
    }

    /// An untracked *binary* file is surfaced by the changed-files list but
    /// synthesis skips it — the per-file diff must still emit a binary marker so
    /// the row shows the "Binary file" placeholder, not "No text hunks".
    #[tokio::test]
    async fn get_file_diff_marks_untracked_binary_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "init"], root);

        // NUL byte in the head → git's binary heuristic; synthesis returns None.
        std::fs::write(root.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();

        let diff = get_file_diff(root, "uncommitted", None, None, "blob.bin", None)
            .await
            .unwrap();
        assert!(diff.contains("Binary files"), "{diff}");
        assert!(diff.contains("b/blob.bin"), "{diff}");
    }

    /// A renamed file must be scoped with BOTH old and new paths so git's
    /// rename detection fires — otherwise it's mis-reported as a whole-file
    /// addition (`new file mode`) with contradictory numstat counts.
    #[tokio::test]
    async fn get_file_diff_detects_rename_with_old_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("old.txt"), "l1\nl2\nl3\nl4\nl5\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "init"], root);

        // Rename + a small edit so the file is similar enough to detect.
        git(&["mv", "old.txt", "new.txt"], root);
        std::fs::write(root.join("new.txt"), "l1\nl2\nCHANGED\nl4\nl5\n").unwrap();

        // Passing the old path pairs the deletion with the addition → rename.
        let diff = get_file_diff(root, "uncommitted", None, None, "new.txt", Some("old.txt"))
            .await
            .unwrap();
        assert!(diff.contains("rename from old.txt"), "{diff}");
        assert!(diff.contains("rename to new.txt"), "{diff}");
        assert!(!diff.contains("new file mode"), "{diff}");

        // Without the old path git only sees the new path and reports the whole
        // file as a fresh addition — the exact regression we're guarding.
        let no_old = get_file_diff(root, "uncommitted", None, None, "new.txt", None)
            .await
            .unwrap();
        assert!(no_old.contains("new file mode"), "{no_old}");
    }

    /// The commit path (`commit_sha`) uses `diff-tree -M`, so it scopes to the
    /// requested file, detects a rename against the parent, and — crucially —
    /// surfaces git errors instead of a `sha^..sha` probe that swallowed them.
    #[tokio::test]
    async fn get_file_diff_commit_scopes_and_detects_rename() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("old.txt"), "l1\nl2\nl3\nl4\nl5\n").unwrap();
        std::fs::write(root.join("other.txt"), "untouched\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "init"], root);

        git(&["mv", "old.txt", "new.txt"], root);
        std::fs::write(root.join("new.txt"), "l1\nl2\nCHANGED\nl4\nl5\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "rename"], root);

        let sha = rev_parse(root, "HEAD").await;

        let diff = get_file_diff(root, "commit", None, Some(&sha), "new.txt", Some("old.txt"))
            .await
            .unwrap();
        assert!(diff.contains("rename from old.txt"), "{diff}");
        assert!(diff.contains("rename to new.txt"), "{diff}");
        assert!(!diff.contains("other.txt"), "{diff}");

        // A bad ref must surface as an error, not a silently-empty diff.
        assert!(
            get_file_diff(root, "commit", None, Some("deadbeef"), "new.txt", None)
                .await
                .is_err()
        );
    }

    /// A stash is a merge commit, so a plain `diff-tree` reports it as changing
    /// nothing; and its untracked files live in a third parent the first-parent
    /// diff can't see. Both halves must reach the per-file diff.
    #[tokio::test]
    async fn get_file_diff_covers_both_halves_of_a_stash() {
        let (tmp, sha) = repo_with_mixed_stash().await;
        let root = tmp.path();

        let tracked = get_file_diff(root, "commit", None, Some(&sha), "tracked.txt", None)
            .await
            .unwrap();
        assert!(tracked.contains("diff --git a/tracked.txt"), "{tracked}");
        assert!(tracked.contains("+two"), "{tracked}");

        let untracked = get_file_diff(root, "commit", None, Some(&sha), "sub/fresh.txt", None)
            .await
            .unwrap();
        // A pure patch, like every other per-file diff: the untracked parent's
        // own sha must not leak in as a leading commit-id line.
        assert!(untracked.starts_with("diff --git"), "{untracked}");
        assert!(untracked.contains("new file mode"), "{untracked}");
        assert!(untracked.contains("+hello"), "{untracked}");
        assert!(untracked.contains("+world"), "{untracked}");
        // Scoped to the requested path only.
        assert!(!untracked.contains("tracked.txt"), "{untracked}");
    }

    /// The per-file commit diff is a pure patch, like every other per-file
    /// diff: `diff-tree` given one commit otherwise prints its id first.
    #[tokio::test]
    async fn get_file_diff_of_a_root_commit_is_a_pure_patch() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("first.txt"), "hello\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "root"], root);
        let sha = rev_parse(root, "HEAD").await;

        let diff = get_file_diff(root, "commit", None, Some(&sha), "first.txt", None)
            .await
            .unwrap();
        assert!(diff.starts_with("diff --git"), "{diff}");
        assert!(diff.contains("+hello"), "{diff}");
    }

    /// The first file staged on a branch with no commit yet diffs as an
    /// addition; there is no `HEAD` to compare with, and that is normal.
    #[tokio::test]
    async fn get_file_diff_reads_a_first_staged_file_as_an_addition() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("draft.txt"), "hello\n").unwrap();
        git(&["add", "draft.txt"], root);

        let diff = get_file_diff(root, "uncommitted", None, None, "draft.txt", None)
            .await
            .unwrap();
        assert!(diff.contains("new file mode"), "{diff}");
        assert!(diff.contains("+hello"), "{diff}");
    }

    /// A tracked file whose own patch outgrows the cap is refused, pointing
    /// at the editor; the production cap still serves the same diff.
    #[tokio::test]
    async fn a_file_diff_over_the_cap_is_refused_for_that_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("big.txt"), "seed\n").unwrap();
        git(&["add", "big.txt"], root);
        git(&["commit", "-q", "-m", "init"], root);
        std::fs::write(root.join("big.txt"), "line of text\n".repeat(1000)).unwrap();

        let error =
            get_file_diff_with_limit(root, "uncommitted", None, None, "big.txt", None, 4096)
                .await
                .unwrap_err();
        let message = too_large_message(error);
        assert!(message.contains("open the file in the editor"), "{message}");

        let ok = get_file_diff(root, "uncommitted", None, None, "big.txt", None)
            .await
            .unwrap();
        assert!(ok.contains("diff --git a/big.txt b/big.txt"));
    }
}
