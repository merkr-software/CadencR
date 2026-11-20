//! Internal helpers shared across the `commands/*` submodules.

use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::version::{self, GitFeature};
use crate::shared::git_cli::{git_ref_resolves_background, head_is_unborn, run_git_background};

/// Makes `diff-tree` and `log` describe a merge commit by its first-parent
/// diff instead of their default (no output whatsoever). Without it a merge —
/// and every stash is one — reports itself as changing nothing. Harmless on
/// non-merge and root commits. Needs Git 2.31: see [`FirstParentDiff`].
pub(super) const FIRST_PARENT_MERGES: &str = "--diff-merges=first-parent";

/// What to hand `diff-tree --root` so it diffs `rev` against its first parent,
/// merges included: [`FIRST_PARENT_MERGES`], or on older Git the first parent
/// named as the other tree (a root commit has none and needs no flag).
pub(super) struct FirstParentDiff {
    pub(super) flags: &'static [&'static str],
    pub(super) revs: Vec<String>,
}

impl FirstParentDiff {
    pub(super) async fn of(cwd: &Path, rev: &str) -> Result<Self, AppError> {
        Self::resolve(cwd, rev, version::supports(GitFeature::DiffMerges)).await
    }

    async fn resolve(cwd: &Path, rev: &str, diff_merges: bool) -> Result<Self, AppError> {
        if diff_merges {
            return Ok(Self {
                flags: &[FIRST_PARENT_MERGES],
                revs: vec![rev.to_string()],
            });
        }
        let parent = format!("{rev}^1");
        let revs = if git_ref_resolves_background(&parent, cwd).await? {
            vec![parent, rev.to_string()]
        } else {
            vec![rev.to_string()]
        };
        Ok(Self { flags: &[], revs })
    }

    pub(super) fn revs(&self) -> Vec<&str> {
        self.revs.iter().map(String::as_str).collect()
    }
}

/// The empty tree's id, which depends on the repository's hash algorithm.
/// `/dev/null` rather than `--stdin`: the command must never wait on an
/// inherited standard input.
pub(super) async fn empty_tree(cwd: &Path) -> Result<String, AppError> {
    let args = ["hash-object", "-t", "tree", "/dev/null"];
    Ok(run_git_background(&args, cwd).await?.trim().to_string())
}

/// The refusal for a comparison against a target branch that does not exist:
/// the reason itself, where Git would only say "bad revision".
pub(crate) fn missing_target_branch(target: &str) -> AppError {
    AppError::Conflict(format!(
        "Target branch '{target}' does not exist; set the feature's target branch"
    ))
}

/// The error for a failed `<target>...HEAD` read: [`missing_target_branch`]
/// when the target itself is missing, Git's own error otherwise.
pub(super) async fn branch_read_error(cwd: &Path, target: &str, error: AppError) -> AppError {
    match git_ref_resolves_background(target, cwd).await {
        Ok(false) => missing_target_branch(target),
        Ok(true) | Err(_) => error,
    }
}

/// The error for a failed file-content read. In branch mode the old side is the target branch: one that does not exist
/// is refused by name (409), as the diff, stats and changed files are.
pub(crate) async fn content_read_error(
    path: &Path,
    old_ref: &str,
    new_ref: &Option<String>,
    commit_sha: &Option<String>,
    error: AppError,
) -> AppError {
    if commit_sha.is_none() && new_ref.is_some() {
        return branch_read_error(path, old_ref, error).await;
    }
    error
}

/// After a history walk over `revs` failed with `error`: the revisions that
/// do resolve, when some do not. A revision that names nothing yet — the
/// `HEAD` of an unborn branch, a target branch never created — has no history,
/// which is an answer rather than a failure. When every revision resolves, the
/// walk failed for another reason and `error` is returned. Probing only once a
/// walk has failed keeps the common case to the walk itself.
///
/// `HEAD` needs proof: its lookup fails silently for an unborn branch and for
/// a branch ref holding garbage alike (see [`head_is_unborn`]). Other names
/// warn about a broken ref, which the probe reports as an error.
pub(super) async fn revs_after_failed_walk<'a>(
    cwd: &Path,
    revs: &[&'a str],
    error: AppError,
) -> Result<Vec<&'a str>, AppError> {
    let mut existing = Vec::with_capacity(revs.len());
    for rev in revs {
        if git_ref_resolves_background(rev, cwd).await? {
            existing.push(*rev);
        } else if *rev == "HEAD" && !matches!(head_is_unborn(cwd).await, Ok(true)) {
            // Git's own message says best why the walk failed.
            return Err(error);
        }
    }
    if existing.len() == revs.len() {
        return Err(error);
    }
    Ok(existing)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(args: &[&str], cwd: &Path) -> String {
        crate::shared::git_cli::run_git(args, cwd).await.unwrap()
    }

    /// The pre-2.31 form must diff a merge (a stash) and a root commit (`HEAD`
    /// here) exactly as the modern flag does.
    #[tokio::test]
    async fn the_older_git_flags_diff_a_merge_like_the_modern_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        git(&["init", "-q"], path).await;
        std::fs::write(path.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"], path).await;
        git(
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "i",
            ],
            path,
        )
        .await;
        std::fs::write(path.join("a.txt"), "two\n").unwrap();
        git(
            &["-c", "user.name=t", "-c", "user.email=t@t", "stash", "-q"],
            path,
        )
        .await;

        let diff = |rev: &'static str, diff_merges: bool| async move {
            let target = FirstParentDiff::resolve(path, rev, diff_merges)
                .await
                .unwrap();
            let args = [
                &["diff-tree", "--no-commit-id", "--root", "-M", "-p"],
                target.flags,
                &target.revs(),
            ]
            .concat();
            git(&args, path).await
        };
        for rev in ["stash@{0}", "HEAD"] {
            let modern = diff(rev, true).await;
            assert_eq!(diff(rev, false).await, modern, "{rev}");
            assert!(!modern.is_empty(), "{rev}");
        }
        assert!(diff("stash@{0}", true).await.contains("+two"));
    }

    /// A content read against a target branch that does not exist is refused
    /// by name (409), like the diff and stats; a commit read keeps its error.
    #[tokio::test]
    async fn a_missing_target_refuses_content_reads_by_name() {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["symbolic-ref", "HEAD", "refs/heads/topic"],
            vec![
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "i",
            ],
        ] {
            assert!(std::process::Command::new("git")
                .args(&args)
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success());
        }
        let files = ["a.txt".to_string()];
        let read =
            || super::super::get_file_content_batch(dir.path(), &files, "main", Some("HEAD"));
        let head = Some("HEAD".to_string());

        let error =
            content_read_error(dir.path(), "main", &head, &None, read().await.unwrap_err()).await;
        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
        let commit = Some("abc".to_string());
        let error = content_read_error(
            dir.path(),
            "main",
            &head,
            &commit,
            read().await.unwrap_err(),
        )
        .await;
        assert!(!matches!(error, AppError::Conflict(_)), "{error:?}");
    }
}
