//! `git diff` / `git diff --stat` orchestration plus the unified-diff
//! emission for untracked files. Spans both `branch` and `worktree`/
//! `uncommitted` modes; the ws/HTTP handlers pick the mode.

use std::path::Path;

use crate::domain::git::models::GitStats;
use crate::error::AppError;
use crate::shared::git_cli::{
    guard_positionals, run_git_safe_background, run_git_safe_refs_background,
};

use super::stash::commit_diff;
use super::untracked::{count_untracked_lines, synthesize_untracked_new_file_diff};
use super::util::{run_git_quiet, FIRST_PARENT_MERGES};

/// Parse git diff --stat summary line.
pub(super) fn parse_stat_line(output: &str) -> GitStats {
    static STAT_RE: std::sync::LazyLock<regex_lite::Regex> = std::sync::LazyLock::new(|| {
        regex_lite::Regex::new(
            r"(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?"
        ).unwrap()
    });

    if let Some(caps) = STAT_RE.captures(output) {
        GitStats {
            files_changed: caps.get(1).map_or(0, |m| m.as_str().parse().unwrap_or(0)),
            insertions: caps.get(2).map_or(0, |m| m.as_str().parse().unwrap_or(0)),
            deletions: caps.get(3).map_or(0, |m| m.as_str().parse().unwrap_or(0)),
        }
    } else {
        GitStats {
            files_changed: 0,
            insertions: 0,
            deletions: 0,
        }
    }
}

/// Get git diff stats.
pub async fn get_stats(
    worktree_path: &Path,
    mode: &str,
    target_branch: Option<&str>,
) -> Result<GitStats, AppError> {
    if mode == "branch" {
        let branch = target_branch.unwrap_or("main");
        let diff_arg = format!("{branch}...HEAD");
        let stdout = run_git_quiet(&["diff", &diff_arg, "--stat"], worktree_path).await;
        return Ok(parse_stat_line(&stdout));
    }

    // Worktree mode: unstaged + staged + untracked
    let (unstaged, staged, untracked) = tokio::join!(
        run_git_quiet(&["diff", "--stat"], worktree_path),
        run_git_quiet(&["diff", "--cached", "--stat"], worktree_path),
        run_git_quiet(
            &["ls-files", "--others", "--exclude-standard"],
            worktree_path
        ),
    );

    let mut stats_unstaged = parse_stat_line(&unstaged);
    let stats_staged = parse_stat_line(&staged);
    stats_unstaged.files_changed += stats_staged.files_changed;
    stats_unstaged.insertions += stats_staged.insertions;
    stats_unstaged.deletions += stats_staged.deletions;

    // Count untracked files. `--exclude-standard` already filters gitignored
    // paths, so we only see files that count. Lines are counted with a buffered
    // stream (bounded memory, not a full read-into-String of every file) and
    // binaries are skipped.
    for file in untracked.trim().lines().filter(|l| !l.is_empty()) {
        let full_path = worktree_path.join(file);
        if let Some(line_count) = count_untracked_lines(&full_path).await {
            stats_unstaged.files_changed += 1;
            stats_unstaged.insertions += line_count as i32;
        }
    }

    Ok(stats_unstaged)
}

/// Get unified diff string.
pub async fn get_diff(
    worktree_path: &Path,
    mode: &str,
    target_branch: Option<&str>,
) -> Result<String, AppError> {
    if mode == "branch" {
        let branch = target_branch.unwrap_or("main");
        let diff_arg = format!("{branch}...HEAD");
        return Ok(run_git_quiet(&["diff", &diff_arg], worktree_path).await);
    }

    // Worktree mode
    let (unstaged, staged, untracked_list) = tokio::join!(
        run_git_quiet(&["diff"], worktree_path),
        run_git_quiet(&["diff", "--cached"], worktree_path),
        run_git_quiet(
            &["ls-files", "--others", "--exclude-standard"],
            worktree_path
        ),
    );

    let mut result = unstaged;
    result.push_str(&staged);

    // `git ls-files --others --exclude-standard` already filters gitignored
    // paths, so we never synthesize a diff for an ignored file. Each remaining
    // untracked file is bounded per-file (see `untracked`) so a giant generated
    // file can't blow up the aggregate response.
    for file in untracked_list.trim().lines().filter(|l| !l.is_empty()) {
        if let Some(block) = synthesize_untracked_new_file_diff(worktree_path, file).await {
            result.push_str(&block);
        }
    }

    Ok(result)
}

/// Get the unified diff for a single file. Same mode/ref semantics as
/// [`get_diff`], scoped to `file_path` via a trailing `-- <path>` so the pane
/// can load one file's patch at a time instead of the whole working-tree diff.
///
/// `old_file` is the pre-rename path for a rename/copy (`R*`/`C*`) entry from
/// the changed-files list, or `None` otherwise. It's passed as a *second*
/// pathspec so git can pair the old path's deletion with the new path's
/// addition and emit a `rename from/to` block with just the edited hunk —
/// without it, `git diff -- <new>` only sees the new path and reports the whole
/// file as additions (`new file mode`).
///
/// `run_git_safe_background` inserts the `--` separator, rejects a path that
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
    // For a rename/copy, scope to BOTH the old and new paths so git's rename
    // detection can pair them; otherwise just the one path.
    let paths: Vec<&str> = match old_file {
        Some(old) if old != file_path => vec![old, file_path],
        _ => vec![file_path],
    };

    if let Some(sha) = commit_sha {
        guard_positionals(&[sha])?;
        // `diff-tree --root` diffs a commit against its parent (or the empty
        // tree for a root commit) in one call, so it handles both cases without
        // a `sha^..sha` probe whose errors we'd have to swallow to reach the
        // root-commit fallback. `-M` matches the rename detection the commit
        // changed-files listing uses, so file list and file diff agree, and
        // `FIRST_PARENT_MERGES` keeps merge commits (every stash is one) from
        // diffing to nothing.
        let diff = run_git_safe_background(
            &["diff-tree", "--root", "-M", FIRST_PARENT_MERGES, "-p", sha],
            &[],
            &paths,
            worktree_path,
        )
        .await?;
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
        return run_git_safe_background(
            &["diff-tree", "--no-commit-id", "--root", "-p", &parent],
            &[],
            &paths,
            worktree_path,
        )
        .await;
    }

    if mode == "branch" {
        let branch = target_branch.unwrap_or("main");
        guard_positionals(&[branch])?;
        let range = format!("{branch}...HEAD");
        return run_git_safe_background(&["diff", &range], &[], &paths, worktree_path).await;
    }

    // Worktree / uncommitted mode: `diff HEAD` folds staged + unstaged changes
    // into a single coherent block per file (unlike the aggregate `get_diff`,
    // which concatenates `diff` + `diff --cached` — fine for a whole-tree dump,
    // but it would hand a partially-staged file two `diff --git` headers here).
    // A tracked file always appears here; only an empty diff can be an untracked
    // file (absent from HEAD), so we pay the extra `ls-files` probe + synthesis
    // in that case alone rather than for every tracked file.
    let tracked = run_git_safe_background(&["diff", "HEAD"], &[], &paths, worktree_path).await?;
    if !tracked.is_empty() {
        return Ok(tracked);
    }

    let new_only = [file_path];
    let untracked = run_git_safe_background(
        &["ls-files", "--others", "--exclude-standard"],
        &[],
        &new_only,
        worktree_path,
    )
    .await?;
    if untracked.lines().any(|l| l == file_path) {
        return Ok(
            match synthesize_untracked_new_file_diff(worktree_path, file_path).await {
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
        );
    }

    Ok(tracked)
}

/// Get the diff for a specific commit.
///
/// One `diff-tree --root` call covers every commit shape the viewer can open:
/// a root commit (no `sha^` to resolve), an ordinary commit, and a merge —
/// which, via `FIRST_PARENT_MERGES`, includes stashes. A stash's untracked
/// files are appended from its third parent, the only place they exist.
pub async fn get_commit_diff(worktree_path: &Path, commit_sha: &str) -> Result<String, AppError> {
    guard_positionals(&[commit_sha])?;
    let args = [
        "diff-tree",
        "--no-commit-id",
        "--root",
        "-M",
        FIRST_PARENT_MERGES,
        "-p",
    ];
    let refs = [commit_sha];
    let (mut diff, untracked_parent) = tokio::try_join!(
        run_git_safe_refs_background(&args, &[], &refs, worktree_path),
        commit_diff::untracked_parent(worktree_path, commit_sha),
    )?;

    if let Some(parent) = untracked_parent {
        let untracked = run_git_safe_refs_background(
            &["diff-tree", "--no-commit-id", "--root", "-p"],
            &[],
            &[&parent],
            worktree_path,
        )
        .await?;
        diff.push_str(&untracked);
    }
    Ok(diff)
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

    fn init_repo(root: &Path) {
        git(&["init", "-q", "-b", "main"], root);
        git(&["config", "user.email", "test@example.com"], root);
        git(&["config", "user.name", "Test"], root);
        git(&["config", "commit.gpgsign", "false"], root);
    }

    async fn rev_parse(root: &Path, rev: &str) -> String {
        crate::shared::git_cli::run_git(&["rev-parse", rev], root)
            .await
            .unwrap()
            .trim()
            .to_string()
    }

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

    /// Set up a repo with one stash holding a tracked edit and an untracked
    /// new file, and return `(repo, stash sha)`.
    async fn repo_with_mixed_stash() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        git(&["config", "commit.gpgsign", "false"], root);
        std::fs::write(root.join("tracked.txt"), "one\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "init"], root);

        std::fs::write(root.join("tracked.txt"), "one\ntwo\n").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/fresh.txt"), "hello\nworld\n").unwrap();
        git(&["stash", "push", "-u", "-q", "-m", "mixed"], root);

        let sha = rev_parse(root, "refs/stash").await;
        (tmp, sha)
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

    /// The aggregate commit diff must carry the same two halves, and stay a
    /// pure patch (no leading commit-id line) for the parser downstream.
    #[tokio::test]
    async fn get_commit_diff_includes_stashed_untracked_files() {
        let (tmp, sha) = repo_with_mixed_stash().await;
        let root = tmp.path();

        let diff = get_commit_diff(root, &sha).await.unwrap();
        assert!(diff.starts_with("diff --git"), "{diff}");
        assert!(diff.contains("diff --git a/tracked.txt"), "{diff}");
        assert!(diff.contains("+two"), "{diff}");
        assert!(diff.contains("diff --git a/sub/fresh.txt"), "{diff}");
        assert!(diff.contains("+hello"), "{diff}");
    }

    /// Ordinary commits keep their old behaviour: a root commit still diffs
    /// against the empty tree, and a bad ref still errors instead of silently
    /// returning an empty patch.
    #[tokio::test]
    async fn get_commit_diff_handles_root_commit_and_bad_ref() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        git(&["config", "commit.gpgsign", "false"], root);
        std::fs::write(root.join("first.txt"), "hello\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "root"], root);

        let sha = rev_parse(root, "HEAD").await;

        let diff = get_commit_diff(root, &sha).await.unwrap();
        assert!(diff.contains("diff --git a/first.txt"), "{diff}");
        assert!(diff.contains("+hello"), "{diff}");

        assert!(get_commit_diff(root, "deadbeef").await.is_err());
    }

    #[test]
    fn test_parse_changed_files_numstat() {
        // Test parse_stat_line since that's the numstat parser
        let output = "3 files changed, 5 insertions(+), 3 deletions(-)";
        let stats = parse_stat_line(output);
        assert_eq!(stats.files_changed, 3);
        assert_eq!(stats.insertions, 5);
        assert_eq!(stats.deletions, 3);
    }

    #[test]
    fn test_parse_stat_line_insertions_only() {
        let output = "1 file changed, 10 insertions(+)";
        let stats = parse_stat_line(output);
        assert_eq!(stats.files_changed, 1);
        assert_eq!(stats.insertions, 10);
        assert_eq!(stats.deletions, 0);
    }
}
