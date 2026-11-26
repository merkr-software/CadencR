//! `git diff` / `git diff --shortstat` orchestration plus the unified-diff
//! emission for untracked files. Spans both `branch` and `worktree`/
//! `uncommitted` modes; the ws/HTTP handlers pick the mode.
//!
//! - this module: the whole-tree diff and its stats;
//! - [`file`]: one file's diff, the diff pane's per-row fetch;
//! - [`commit`]: one commit's (or stash's) whole diff.
//!
//! Every diff is read with a byte cap and answers `413 DIFF_TOO_LARGE` past
//! it, so a giant generated file cannot OOM or stall the service.

use std::path::Path;

use axum::http::StatusCode;

use crate::domain::git::models::{DiffResponse, GitStats};
use crate::error::AppError;
use crate::shared::git_cli::{
    bytes_to_string_lossy, guard_positionals, run_git_background, run_git_background_bounded,
    run_git_safe_background_bounded, BoundedGitOutput,
};
use crate::shared::git_z;

use super::untracked::{count_untracked_lines, synthesize_untracked_new_file_diff};
use super::util::{branch_read_error, format_bytes};

mod commit;
mod file;

pub use commit::get_commit_diff;
pub use file::get_file_diff;

/// Public code of a diff refused for its size.
pub const DIFF_TOO_LARGE: &str = "DIFF_TOO_LARGE";

/// Ceiling on one file's unified diff (10 MiB).
const MAX_FILE_DIFF_BYTES: usize = 10 * 1024 * 1024;

/// Ceiling on a whole-tree or whole-commit unified diff (16 MiB).
const MAX_AGGREGATE_DIFF_BYTES: usize = 16 * 1024 * 1024;

/// What a refused diff covered, which decides where the user can look instead.
#[derive(Clone, Copy, Debug)]
enum DiffScope {
    /// One file's diff: the editor still opens the file.
    File,
    /// Several files' diffs at once: each file still opens on its own.
    Aggregate,
}

fn diff_too_large(scope: DiffScope, max_bytes: usize) -> AppError {
    let label = format_bytes(max_bytes as u64);
    let message = match scope {
        DiffScope::File => format!(
            "Diff exceeds the {label} display limit — open the file in the editor to inspect it"
        ),
        DiffScope::Aggregate => format!(
            "Combined diff exceeds the {label} display limit — open the files one at a time \
             to inspect them"
        ),
    };
    AppError::coded(StatusCode::PAYLOAD_TOO_LARGE, DIFF_TOO_LARGE, message)
}

fn decode_bounded_diff(
    output: BoundedGitOutput,
    scope: DiffScope,
    max_bytes: usize,
) -> Result<String, AppError> {
    match output {
        BoundedGitOutput::Bytes(bytes) => Ok(bytes_to_string_lossy(bytes)),
        BoundedGitOutput::ExceededLimit => Err(diff_too_large(scope, max_bytes)),
    }
}

/// Parse the `N files changed, I insertions(+), D deletions(-)` summary line
/// that `git diff --shortstat` prints (and `--stat` ends with).
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
            unavailable_line_counts: 0,
        }
    } else {
        GitStats::default()
    }
}

/// `git diff <target>...HEAD <flags>`, the branch-mode comparison. A target
/// that does not resolve is an error here, as it is for the changed-file list
/// and the per-file diff of the same view — never a silent "no changes".
async fn branch_diff(
    worktree_path: &Path,
    target_branch: Option<&str>,
    flags: &[&str],
    max_bytes: usize,
) -> Result<String, AppError> {
    let branch = target_branch.unwrap_or("main");
    guard_positionals(&[branch])?;
    let range = format!("{branch}...HEAD");
    // The path list is empty: `run_git_safe_background_bounded` still ends the
    // revisions with `--`, so a file named like the range stays a revision.
    match run_git_safe_background_bounded(&["diff", &range], flags, &[], worktree_path, max_bytes)
        .await
    {
        Ok(output) => decode_bounded_diff(output, DiffScope::Aggregate, max_bytes),
        Err(error) => Err(branch_read_error(worktree_path, branch, error).await),
    }
}

async fn list_untracked(worktree_path: &Path) -> Result<String, AppError> {
    run_git_background(
        &["ls-files", "--others", "--exclude-standard", "-z"],
        worktree_path,
    )
    .await
}

/// Get git diff stats.
///
/// `--shortstat` prints the summary line alone: a `--stat` listing grows with
/// the number of changed files, which the summary does not need, and could
/// reach the diff size cap on a branch that rewrote a whole tree.
pub async fn get_stats(
    worktree_path: &Path,
    mode: &str,
    target_branch: Option<&str>,
) -> Result<GitStats, AppError> {
    if mode == "branch" {
        let stdout = branch_diff(
            worktree_path,
            target_branch,
            &["--shortstat"],
            MAX_AGGREGATE_DIFF_BYTES,
        )
        .await?;
        return Ok(parse_stat_line(&stdout));
    }

    // Worktree mode: unstaged + staged + untracked
    let (unstaged, staged, untracked) = tokio::try_join!(
        run_git_background(&["diff", "--shortstat"], worktree_path),
        run_git_background(&["diff", "--cached", "--shortstat"], worktree_path),
        list_untracked(worktree_path),
    )?;

    let mut stats_unstaged = parse_stat_line(&unstaged);
    let stats_staged = parse_stat_line(&staged);
    stats_unstaged.files_changed += stats_staged.files_changed;
    stats_unstaged.insertions += stats_staged.insertions;
    stats_unstaged.deletions += stats_staged.deletions;

    // Count untracked files. `--exclude-standard` already filters gitignored
    // paths, so we only see files that count. Lines are counted with a buffered
    // stream (bounded memory, not a full read-into-String of every file) and
    // binaries are skipped.
    for file in git_z::paths(&untracked) {
        match count_untracked_lines(&worktree_path.join(file)).await {
            Ok(Some(line_count)) => {
                stats_unstaged.files_changed += 1;
                stats_unstaged.insertions += line_count as i32;
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, "untracked file line count unavailable");
                stats_unstaged.files_changed += 1;
                stats_unstaged.unavailable_line_counts += 1;
            }
        }
    }

    Ok(stats_unstaged)
}

/// Get unified diff string.
pub async fn get_diff(
    worktree_path: &Path,
    mode: &str,
    target_branch: Option<&str>,
) -> Result<DiffResponse, AppError> {
    get_diff_with_limit(worktree_path, mode, target_branch, MAX_AGGREGATE_DIFF_BYTES).await
}

async fn get_diff_with_limit(
    worktree_path: &Path,
    mode: &str,
    target_branch: Option<&str>,
    max_bytes: usize,
) -> Result<DiffResponse, AppError> {
    if mode == "branch" {
        let diff = branch_diff(worktree_path, target_branch, &[], max_bytes).await?;
        return Ok(DiffResponse {
            diff,
            ..DiffResponse::default()
        });
    }

    // Worktree mode: a whole-tree dump, so unstaged (`diff`) and staged
    // (`diff --cached`) are simply concatenated. A partially staged file gets
    // two `diff --git` blocks here; the per-file diff folds them into one.
    let (unstaged, staged, untracked_list) = tokio::try_join!(
        run_git_background_bounded(&["diff"], worktree_path, max_bytes),
        run_git_background_bounded(&["diff", "--cached"], worktree_path, max_bytes),
        list_untracked(worktree_path),
    )?;

    let too_large = || diff_too_large(DiffScope::Aggregate, max_bytes);
    let mut result = decode_bounded_diff(unstaged, DiffScope::Aggregate, max_bytes)?;
    let staged = decode_bounded_diff(staged, DiffScope::Aggregate, max_bytes)?;
    if result.len().saturating_add(staged.len()) > max_bytes {
        return Err(too_large());
    }
    result.push_str(&staged);

    // `git ls-files --others --exclude-standard` already filters gitignored
    // paths, so we never synthesize a diff for an ignored file. Each remaining
    // untracked file is bounded per-file (see `untracked`) so a giant generated
    // file can't blow up the aggregate response.
    let mut omitted_untracked_files = Vec::new();
    for file in git_z::paths(&untracked_list) {
        match synthesize_untracked_new_file_diff(worktree_path, &file).await {
            Ok(Some(block)) => {
                if result.len().saturating_add(block.len()) > max_bytes {
                    return Err(too_large());
                }
                result.push_str(&block);
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, "untracked file omitted from combined diff");
                omitted_untracked_files.push(file);
            }
        }
    }

    Ok(DiffResponse {
        diff: result,
        omitted_untracked_files,
    })
}

#[cfg(test)]
mod test_support {
    use std::path::Path;
    use std::process::Command;

    use crate::error::AppError;

    pub(super) fn git(args: &[&str], cwd: &Path) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("git available");
        assert!(status.success(), "git {args:?} failed");
    }

    pub(super) fn init_repo(root: &Path) {
        git(&["init", "-q", "-b", "main"], root);
        git(&["config", "user.email", "test@example.com"], root);
        git(&["config", "user.name", "Test"], root);
        git(&["config", "commit.gpgsign", "false"], root);
    }

    pub(super) async fn rev_parse(root: &Path, rev: &str) -> String {
        crate::shared::git_cli::run_git(&["rev-parse", rev], root)
            .await
            .unwrap()
            .trim()
            .to_string()
    }

    /// Set up a repo with one stash holding a tracked edit and an untracked
    /// new file, and return `(repo, stash sha)`.
    pub(super) async fn repo_with_mixed_stash() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
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

    /// The public message of a `413 DIFF_TOO_LARGE`, or a panic.
    pub(super) fn too_large_message(error: AppError) -> String {
        match error {
            AppError::Coded {
                status,
                code: super::DIFF_TOO_LARGE,
                message,
            } => {
                assert_eq!(status, axum::http::StatusCode::PAYLOAD_TOO_LARGE);
                message
            }
            other => panic!("expected DIFF_TOO_LARGE, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{git, init_repo, too_large_message};
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_untracked_file_leaves_other_counts_and_patches_available() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("tracked.txt"), "old\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-qm", "init"], root);
        std::fs::write(root.join("tracked.txt"), "old\nnew\n").unwrap();
        std::fs::write(root.join("empty.txt"), "").unwrap();
        std::fs::write(root.join("text.txt"), "one\ntwo").unwrap();
        std::fs::write(root.join("binary.dat"), b"hey\0").unwrap();
        // A symlink loop makes metadata fail consistently, even under root.
        std::os::unix::fs::symlink("unreadable", root.join("unreadable")).unwrap();

        let files = super::super::get_changed_files(root, "worktree", None, None)
            .await
            .unwrap();
        let row = |path| files.iter().find(|file| file.file == path).unwrap();
        assert!(row("unreadable").line_count_unavailable);
        for file in ["empty.txt", "binary.dat"] {
            assert_eq!(row(file).additions, 0);
            assert!(!row(file).line_count_unavailable);
        }
        assert_eq!(row("text.txt").additions, 2);
        assert_eq!(row("tracked.txt").additions, 1);

        let stats = get_stats(root, "worktree", None).await.unwrap();
        assert_eq!(
            (stats.files_changed, stats.insertions, stats.deletions),
            (4, 3, 0)
        );
        assert_eq!(stats.unavailable_line_counts, 1);

        let combined = get_diff(root, "worktree", None).await.unwrap();
        assert_eq!(combined.omitted_untracked_files, ["unreadable"]);
        for file in ["tracked.txt", "empty.txt", "text.txt"] {
            assert!(combined.diff.contains(file), "missing patch for {file}");
        }
        assert!(!combined.diff.contains("binary.dat"));
        assert!(!combined.diff.contains("unreadable"));

        std::fs::remove_file(root.join("unreadable")).unwrap();
        std::fs::write(root.join("unreadable"), "now readable\n").unwrap();
        let recovered = get_stats(root, "worktree", None).await.unwrap();
        assert_eq!(recovered.insertions, 4);
        assert_eq!(recovered.unavailable_line_counts, 0);
        assert!(get_diff(root, "worktree", None)
            .await
            .unwrap()
            .omitted_untracked_files
            .is_empty());
    }

    /// A missing target branch or an unreadable repository must fail the
    /// aggregate diff and its stats, not report a clean "0 files changed".
    #[tokio::test]
    async fn aggregate_diff_and_stats_surface_git_failures() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "init"], root);
        std::fs::write(root.join("a.txt"), "two\n").unwrap();

        let stats = get_stats(root, "worktree", None).await.unwrap();
        assert_eq!(stats.files_changed, 1);
        // A target that does not exist says so, not "bad revision".
        for result in [
            get_stats(root, "branch", Some("missing")).await.map(|_| ()),
            get_diff(root, "branch", Some("missing")).await.map(|_| ()),
            get_file_diff(root, "branch", Some("missing"), None, "a.txt", None)
                .await
                .map(|_| ()),
            super::super::get_changed_files(root, "branch", Some("missing"), None)
                .await
                .map(|_| ()),
        ] {
            assert!(matches!(result, Err(AppError::Conflict(_))), "{result:?}");
        }
        assert!(get_stats(root, "branch", Some("--output=x")).await.is_err());

        let not_repo = tempfile::tempdir().expect("tempdir");
        assert!(get_stats(not_repo.path(), "worktree", None).await.is_err());
        assert!(get_diff(not_repo.path(), "worktree", None).await.is_err());
    }

    /// Both modes count from the summary line alone, staged and unstaged
    /// edits plus untracked files in worktree mode.
    #[tokio::test]
    async fn stats_count_branch_and_worktree_changes() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "init"], root);
        git(&["checkout", "-q", "-b", "feature"], root);
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(root.join("b.txt"), "b\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "work"], root);

        let branch = get_stats(root, "branch", Some("main")).await.unwrap();
        assert_eq!(
            (branch.files_changed, branch.insertions, branch.deletions),
            (2, 3, 0)
        );

        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"], root);
        std::fs::write(root.join("b.txt"), "changed\n").unwrap();
        std::fs::write(root.join("c.txt"), "new\nfile\n").unwrap();
        let worktree = get_stats(root, "worktree", None).await.unwrap();
        assert_eq!(
            (
                worktree.files_changed,
                worktree.insertions,
                worktree.deletions
            ),
            (3, 3, 3)
        );
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

    /// A refused whole-tree diff points at the per-file view, never at "the
    /// file": there are many.
    #[tokio::test]
    async fn an_aggregate_diff_over_the_cap_is_refused_for_every_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("big.txt"), "seed\n").unwrap();
        git(&["add", "big.txt"], root);
        git(&["commit", "-q", "-m", "init"], root);
        std::fs::write(root.join("big.txt"), "line of text\n".repeat(1000)).unwrap();

        let message = too_large_message(
            get_diff_with_limit(root, "worktree", None, 4096)
                .await
                .unwrap_err(),
        );
        assert!(message.starts_with("Combined diff exceeds"), "{message}");
        assert!(!message.contains("the file in the editor"), "{message}");
        assert!(get_diff(root, "worktree", None).await.is_ok());
    }
}
