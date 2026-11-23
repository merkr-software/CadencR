//! One commit's whole unified diff, stashes included.

use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::{guard_positionals, run_git_safe_refs_background_bounded};

use super::super::stash::commit_diff;
use super::super::util::FirstParentDiff;
use super::{decode_bounded_diff, diff_too_large, DiffScope, MAX_AGGREGATE_DIFF_BYTES};

/// Get the diff for a specific commit.
///
/// One `diff-tree --root` call covers every commit shape the viewer can open:
/// a root commit (no `sha^` to resolve), an ordinary commit, and a merge —
/// which, via `FirstParentDiff`, includes stashes. A stash's untracked
/// files are appended from its third parent, the only place they exist.
/// Both halves share one 16 MiB budget (`413 DIFF_TOO_LARGE` past it).
pub async fn get_commit_diff(worktree_path: &Path, commit_sha: &str) -> Result<String, AppError> {
    get_commit_diff_with_limit(worktree_path, commit_sha, MAX_AGGREGATE_DIFF_BYTES).await
}

async fn get_commit_diff_with_limit(
    worktree_path: &Path,
    commit_sha: &str,
    max_bytes: usize,
) -> Result<String, AppError> {
    guard_positionals(&[commit_sha])?;
    let target = FirstParentDiff::of(worktree_path, commit_sha).await?;
    let revs = target.revs();
    let args = [
        &["diff-tree", "--no-commit-id", "--root", "-M", "-p"],
        target.flags,
    ]
    .concat();
    let (diff_output, untracked_parent) = tokio::try_join!(
        run_git_safe_refs_background_bounded(&args, &[], &revs, worktree_path, max_bytes),
        commit_diff::untracked_parent(worktree_path, commit_sha),
    )?;
    let mut diff = decode_bounded_diff(diff_output, DiffScope::Aggregate, max_bytes)?;

    if let Some(parent) = untracked_parent {
        // The untracked half may only use what the tracked half left: reading
        // it with the whole cap could buffer twice the limit before refusing.
        let remaining = max_bytes.saturating_sub(diff.len());
        let untracked = run_git_safe_refs_background_bounded(
            &["diff-tree", "--no-commit-id", "--root", "-p"],
            &[],
            &[&parent],
            worktree_path,
            remaining,
        )
        .await?;
        let untracked = decode_bounded_diff(untracked, DiffScope::Aggregate, max_bytes)?;
        if diff.len().saturating_add(untracked.len()) > max_bytes {
            return Err(diff_too_large(DiffScope::Aggregate, max_bytes));
        }
        diff.push_str(&untracked);
    }
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{
        git, init_repo, repo_with_mixed_stash, rev_parse, too_large_message,
    };
    use super::*;

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

    /// The tracked and untracked halves of a stash share one budget: each
    /// fitting alone is not enough, and the untracked half is read with what
    /// the tracked half left (a zero budget included).
    #[tokio::test]
    async fn a_stash_diff_shares_one_budget_between_its_halves() {
        let (tmp, sha) = repo_with_mixed_stash().await;
        let root = tmp.path();
        let whole = get_commit_diff(root, &sha).await.unwrap();
        let untracked_at = whole.find("diff --git a/sub/fresh.txt").unwrap();

        assert_eq!(
            get_commit_diff_with_limit(root, &sha, whole.len())
                .await
                .unwrap(),
            whole
        );
        for limit in [whole.len() - 1, untracked_at + 1, untracked_at] {
            let error = get_commit_diff_with_limit(root, &sha, limit)
                .await
                .unwrap_err();
            let message = too_large_message(error);
            assert!(message.starts_with("Combined diff exceeds"), "{message}");
        }
    }

    /// Ordinary commits keep their old behaviour: a root commit still diffs
    /// against the empty tree, and a bad ref still errors instead of silently
    /// returning an empty patch.
    #[tokio::test]
    async fn get_commit_diff_handles_root_commit_and_bad_ref() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("first.txt"), "hello\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-q", "-m", "root"], root);

        let sha = rev_parse(root, "HEAD").await;

        let diff = get_commit_diff(root, &sha).await.unwrap();
        assert!(diff.contains("diff --git a/first.txt"), "{diff}");
        assert!(diff.contains("+hello"), "{diff}");

        assert!(get_commit_diff(root, "deadbeef").await.is_err());
    }
}
