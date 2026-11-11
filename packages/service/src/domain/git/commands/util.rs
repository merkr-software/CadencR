//! Internal helpers shared across the `commands/*` submodules.

use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::version::{self, GitFeature};
use crate::shared::git_cli::{git_ref_resolves_background, run_git_background};

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

/// Run a git command, returning Ok("") instead of Err on failure.
pub(super) async fn run_git_quiet(args: &[&str], cwd: &Path) -> String {
    run_git_background(args, cwd).await.unwrap_or_default()
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
}
