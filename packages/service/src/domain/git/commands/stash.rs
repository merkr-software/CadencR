//! `git stash list` orchestration for the Git-tab Stashes view.
//!
//! A single `git stash list --first-parent -m --numstat -z` call yields, for every
//! stash, its SHA, reflog selector, description, creation date, parent list
//! *and* the numstat block — all in one git invocation. `--first-parent` is what
//! makes the numstat meaningful: a stash is a merge commit (HEAD + index [+
//! untracked parent]), and plain `--numstat` emits nothing for a merge. (`-m`
//! is implied by `--first-parent` from Git 2.29 only.)
//! Following the first parent diffs `<sha>^1..<sha>` — the exact same range the
//! diff viewer opens on click (via the shared `commit_sha` path).
//!
//! That first-parent diff covers the tracked edits only. Files swept in by
//! `stash push --include-untracked` live in the stash's third parent, so their
//! numstat is added from that tree ([`commit_diff::untracked_parent`]) — the
//! same source the diff viewer expands them from, so the row summary and the
//! diff it opens can never disagree.

use std::path::Path;

use crate::domain::git::models::StashEntry;
use crate::error::AppError;
use crate::shared::git_cli::{run_git, run_git_background};

use super::changed_files::parse_numstat;

pub(super) mod commit_diff;
mod mutations;

pub(crate) use mutations::stash_common_dir;
pub use mutations::{apply_stash, drop_stash, pop_stash, push_stash};

/// Record separator emitted before every stash; field separator between the
/// `--format` placeholders. Both are control bytes that can't appear in stash
/// metadata, so splitting on them is unambiguous. Fields: full SHA (`%H`),
/// reflog selector (`%gd` → `stash@{0}`), reflog subject (`%gs`, the stash
/// description), the strict ISO-8601 committer date (`%cI`) and the parent SHAs
/// (`%P`, which reveal whether this stash carries untracked files). The
/// trailing `%x1f` is what lets us peel the `--numstat` block (which git appends
/// *after* the formatted output) off into its own field.
const FORMAT: &str = "%x1e%H%x1f%gd%x1f%gs%x1f%cI%x1f%P%x1f";

/// Sum a `git diff --numstat -z` block into `(files_changed, additions, deletions)`.
/// Binary files (numstat `-`) contribute a changed file but zero line counts,
/// matching [`parse_numstat`].
fn sum_numstat(numstat: &str) -> (i32, i32, i32) {
    // `stash list -z` separates the format from the numstat with `\0\n`; a
    // numstat record starts with its counts, so this never eats a path.
    let map = parse_numstat(numstat.trim_start_matches(['\0', '\n']));
    let files = map.len() as i32;
    let (adds, dels) = map
        .values()
        .fold((0, 0), |(a, d), (ai, di)| (a + ai, d + di));
    (files, adds, dels)
}

/// A parsed stash row plus the third parent holding its untracked files, when
/// the stash was pushed with `--include-untracked`.
struct ParsedStash {
    entry: StashEntry,
    untracked_parent: Option<String>,
}

/// Parse `git stash list --numstat -z --format=<FORMAT>` output into `StashEntry`
/// rows in git's native order (newest stash first). Field 5 (after the format's
/// closing separator) holds the trailing numstat block.
fn parse_stashes(output: &str) -> Vec<ParsedStash> {
    output
        .split('\x1e')
        .filter(|s| !s.trim().is_empty())
        .filter_map(|record| {
            let f: Vec<&str> = record.split('\x1f').collect();
            if f.len() < 6 {
                return None;
            }
            let (files_changed, additions, deletions) = sum_numstat(f[5]);
            Some(ParsedStash {
                entry: StashEntry {
                    sha: f[0].trim().to_string(),
                    ref_name: f[1].trim().to_string(),
                    message: f[2].trim().to_string(),
                    date: f[3].trim().to_string(),
                    files_changed,
                    additions,
                    deletions,
                },
                untracked_parent: commit_diff::untracked_parent_of(f[4]),
            })
        })
        .collect()
}

/// List all stashes with a per-stash numstat summary, newest first.
pub async fn list_stashes(repo_path: &Path) -> Result<Vec<StashEntry>, AppError> {
    let format_arg = format!("--format={FORMAT}");
    let stdout = run_git(
        &[
            "stash",
            "list",
            "--first-parent",
            "-m",
            "--numstat",
            "-z",
            &format_arg,
        ],
        repo_path,
    )
    .await?;

    // One extra `diff-tree` per `-u` stash, run concurrently: a list of twenty
    // such stashes is one round trip, not twenty.
    futures::future::try_join_all(parse_stashes(&stdout).into_iter().map(|parsed| async move {
        let mut entry = parsed.entry;
        if let Some(parent) = parsed.untracked_parent {
            add_untracked_totals(repo_path, &mut entry, &parent).await?;
        }
        Ok(entry)
    }))
    .await
}

/// Fold the untracked half of a `stash push -u` into the row summary. The
/// untracked parent is a root commit whose tree is exactly those files, so
/// diffing it against the empty tree (`--root`) numstats them as the additions
/// they were — the same source the diff viewer expands them from.
async fn add_untracked_totals(
    repo_path: &Path,
    entry: &mut StashEntry,
    parent: &str,
) -> Result<(), AppError> {
    let numstat = run_git_background(
        &[
            "diff-tree",
            "--no-commit-id",
            "--root",
            "--numstat",
            "-z",
            "-r",
            parent,
        ],
        repo_path,
    )
    .await?;
    let (files_changed, additions, deletions) = sum_numstat(&numstat);
    entry.files_changed += files_changed;
    entry.additions += additions;
    entry.deletions += deletions;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_stashes_multiple_entries_with_numstat() {
        let output = "\x1eabc123\x1fstash@{0}\x1fWIP on main: 1234 subject\x1f2024-01-02T03:04:05+00:00\x1fbase0 index0 untracked0\x1f\0\n10\t2\tsrc/a.rs\0\x1edef456\x1fstash@{1}\x1fOn main: my work\x1f2024-01-01T00:00:00+00:00\x1fbase1 index1\x1f\0\n3\t4\tsrc/b.rs\x001\t0\tsrc/c d.rs\0";
        let rows = parse_stashes(output);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].entry.sha, "abc123");
        assert_eq!(rows[0].entry.ref_name, "stash@{0}");
        assert_eq!(rows[0].entry.message, "WIP on main: 1234 subject");
        assert_eq!(rows[0].entry.date, "2024-01-02T03:04:05+00:00");
        assert_eq!(
            (
                rows[0].entry.files_changed,
                rows[0].entry.additions,
                rows[0].entry.deletions
            ),
            (1, 10, 2)
        );
        // Three parents: this stash carries untracked files.
        assert_eq!(rows[0].untracked_parent.as_deref(), Some("untracked0"));
        assert_eq!(rows[1].entry.ref_name, "stash@{1}");
        assert_eq!(rows[1].entry.message, "On main: my work");
        assert_eq!(
            (
                rows[1].entry.files_changed,
                rows[1].entry.additions,
                rows[1].entry.deletions
            ),
            (2, 4, 4)
        );
        assert_eq!(rows[1].untracked_parent, None);
    }

    #[test]
    fn parse_stashes_empty() {
        assert!(parse_stashes("").is_empty());
        assert!(parse_stashes("   \n ").is_empty());
    }

    #[test]
    fn parse_stashes_skips_malformed_record() {
        // Missing the parent and numstat fields — not enough to build an entry.
        let output = "\x1eabc123\x1fstash@{0}\x1fmsg";
        assert!(parse_stashes(output).is_empty());
    }

    #[test]
    fn sum_numstat_totals_lines_and_files() {
        let numstat = "10\t2\tsrc/a.rs\x003\t4\tsrc/b.rs\0";
        assert_eq!(sum_numstat(numstat), (2, 13, 6));
    }

    #[test]
    fn sum_numstat_binary_counts_file_not_lines() {
        let numstat = "-\t-\tassets/logo.png\x005\t1\tsrc/a.rs\0";
        assert_eq!(sum_numstat(numstat), (2, 5, 1));
    }

    #[test]
    fn sum_numstat_empty() {
        assert_eq!(sum_numstat(""), (0, 0, 0));
    }

    /// End-to-end against real git: two stashes must be listed newest-first
    /// with their reflog selector, description and numstat summary — all from
    /// the single `git stash list --first-parent -m --numstat -z` call.
    #[tokio::test]
    async fn list_stashes_reports_entries_with_numstat() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run_git(&["init", "-q", "-b", "main"], path).await.unwrap();
        run_git(&["config", "user.email", "t@example.com"], path)
            .await
            .unwrap();
        run_git(&["config", "user.name", "T"], path).await.unwrap();
        run_git(&["config", "commit.gpgsign", "false"], path)
            .await
            .unwrap();

        // Base commit so stashes have a parent to diff against.
        tokio::fs::write(path.join("a.txt"), "1\n2\n3\n")
            .await
            .unwrap();
        run_git(&["add", "."], path).await.unwrap();
        run_git(&["commit", "-q", "-m", "base"], path)
            .await
            .unwrap();

        // First stash: modify a.txt.
        tokio::fs::write(path.join("a.txt"), "1\n2\n3\n4\n")
            .await
            .unwrap();
        run_git(&["stash", "push", "-m", "first"], path)
            .await
            .unwrap();

        // Second stash: add a new tracked file.
        tokio::fs::write(path.join("b.txt"), "x\ny\n")
            .await
            .unwrap();
        run_git(&["add", "b.txt"], path).await.unwrap();
        run_git(&["stash", "push", "-m", "second"], path)
            .await
            .unwrap();

        let stashes = list_stashes(path).await.unwrap();
        assert_eq!(stashes.len(), 2);

        // Newest first: stash@{0} is the "second" stash.
        assert_eq!(stashes[0].ref_name, "stash@{0}");
        assert!(stashes[0].message.contains("second"), "{:?}", stashes[0]);
        assert_eq!(stashes[0].files_changed, 1);
        assert_eq!(stashes[0].additions, 2);
        assert!(!stashes[0].sha.is_empty());
        assert!(!stashes[0].date.is_empty());

        assert_eq!(stashes[1].ref_name, "stash@{1}");
        assert!(stashes[1].message.contains("first"));
        assert_eq!(stashes[1].files_changed, 1);
        assert_eq!(stashes[1].additions, 1);
    }

    /// A `stash push -u` keeps its untracked files in a third parent that the
    /// first-parent numstat can't see. The row must still count them, or it
    /// advertises "0 files" for a stash that opens onto a full diff.
    #[tokio::test]
    async fn list_stashes_counts_untracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run_git(&["init", "-q", "-b", "main"], path).await.unwrap();
        run_git(&["config", "user.email", "t@example.com"], path)
            .await
            .unwrap();
        run_git(&["config", "user.name", "T"], path).await.unwrap();
        run_git(&["config", "commit.gpgsign", "false"], path)
            .await
            .unwrap();
        tokio::fs::write(path.join("a.txt"), "1\n").await.unwrap();
        run_git(&["add", "."], path).await.unwrap();
        run_git(&["commit", "-q", "-m", "base"], path)
            .await
            .unwrap();

        // One tracked edit (+1) and one brand-new untracked file (+2).
        tokio::fs::write(path.join("a.txt"), "1\n2\n")
            .await
            .unwrap();
        tokio::fs::write(path.join("new.txt"), "x\ny\n")
            .await
            .unwrap();
        run_git(&["stash", "push", "-u", "-q", "-m", "mixed"], path)
            .await
            .unwrap();

        let stashes = list_stashes(path).await.unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].files_changed, 2);
        assert_eq!(stashes[0].additions, 3);
        assert_eq!(stashes[0].deletions, 0);
    }

    #[tokio::test]
    async fn list_stashes_empty_when_no_stashes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run_git(&["init", "-q", "-b", "main"], path).await.unwrap();
        run_git(&["config", "user.email", "t@example.com"], path)
            .await
            .unwrap();
        run_git(&["config", "user.name", "T"], path).await.unwrap();
        run_git(&["config", "commit.gpgsign", "false"], path)
            .await
            .unwrap();
        tokio::fs::write(path.join("a.txt"), "1\n").await.unwrap();
        run_git(&["add", "."], path).await.unwrap();
        run_git(&["commit", "-q", "-m", "base"], path)
            .await
            .unwrap();

        assert!(list_stashes(path).await.unwrap().is_empty());
    }
}
