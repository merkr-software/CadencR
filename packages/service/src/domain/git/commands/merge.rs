//! Branch resolution: `get_current_branch` plus the `get_original_branch`
//! fallback chain that the merge dialog uses to figure out which base ref
//! to compare against. Merge / merge-tree / branch-delete orchestration
//! lives in [`super::merge_ops`].

use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::{run_git, run_git_safe_refs};

/// Get the current branch name. Returns None on error (detached HEAD, not a repo).
pub async fn get_current_branch(repo_path: &Path) -> Result<Option<String>, AppError> {
    if !crate::shared::git_context::has_git_metadata(repo_path).await? {
        return Ok(None);
    }
    match run_git(&["rev-parse", "--abbrev-ref", "HEAD"], repo_path).await {
        Ok(stdout) => {
            let branch = stdout.trim().to_string();
            Ok(if branch.is_empty() {
                None
            } else {
                Some(branch)
            })
        }
        Err(_) => Ok(None),
    }
}

/// Detect the original branch from which a worktree branch was created.
///
/// Always prefers a remote-tracking ref (e.g. `origin/main`) over the local
/// branch name so callers comparing against this base see the shared remote
/// tip — never a stale local copy. The chain:
///
///   1. tracking config: if `branch.<branch>.remote == origin` and
///      `branch.<branch>.merge == refs/heads/<name>` for a different branch,
///      return `origin/<name>`,
///   2. `origin/HEAD` symbolic ref → `origin/<name>`,
///   3. `origin/main` then `origin/master` if either exists,
///   4. local `main`, `master`, `develop`, `trunk` as a last resort.
pub async fn get_original_branch(
    repo_path: &Path,
    worktree_branch: &str,
) -> Result<String, AppError> {
    crate::shared::git_context::require_git_metadata(repo_path).await?;
    // 1. Tracking config — only honor when the remote is `origin`. A merge
    //    target whose remote is anything else (or unset) doesn't tell us the
    //    correct `origin/...` ref, so fall through to the symbolic-ref probe
    //    below rather than guessing.
    if let Some(remote_ref) = tracking_remote_ref(repo_path, worktree_branch).await {
        return Ok(remote_ref);
    }

    // 2. Remote HEAD — keep the `origin/` prefix so callers compare against
    //    the remote tip, not a (possibly stale) local branch with the same
    //    short name.
    if let Ok(stdout) = run_git_safe_refs(
        &["symbolic-ref"],
        &[],
        &["refs/remotes/origin/HEAD"],
        repo_path,
    )
    .await
    {
        let remote_head = stdout.trim();
        if let Some(short) = remote_head.strip_prefix("refs/remotes/") {
            if !short.is_empty() {
                return Ok(short.to_string());
            }
        }
    }

    // 3. Remote `main` / `master` before any local fallback.
    for candidate in &["origin/main", "origin/master"] {
        if run_git_safe_refs(&["rev-parse"], &["--verify"], &[candidate], repo_path)
            .await
            .is_ok()
        {
            return Ok((*candidate).to_string());
        }
    }

    // 4. Local-branch last resort. We only land here when there is no remote
    //    at all (e.g. a brand-new repo without an `origin`).
    for candidate in &["main", "master", "develop", "trunk"] {
        if run_git_safe_refs(&["rev-parse"], &["--verify"], &[candidate], repo_path)
            .await
            .is_ok()
        {
            return Ok((*candidate).to_string());
        }
    }

    Err(AppError::git_command(format!(
        "Cannot determine original branch for worktree branch: {worktree_branch}"
    )))
}

/// If `branch.<branch>.remote == origin` and `branch.<branch>.merge` resolves
/// to a different `refs/heads/<name>`, return `origin/<name>`. Returns `None`
/// for any other configuration (including a non-origin remote, where we don't
/// know what ref to compare against).
async fn tracking_remote_ref(repo_path: &Path, branch: &str) -> Option<String> {
    let remote_key = format!("branch.{branch}.remote");
    let merge_key = format!("branch.{branch}.merge");

    let remote = run_git_safe_refs(&["config"], &["--get"], &[&remote_key], repo_path)
        .await
        .ok()
        .map(|s| s.trim().to_string())?;
    if remote != "origin" {
        return None;
    }

    let merge = run_git_safe_refs(&["config"], &["--get"], &[&merge_key], repo_path)
        .await
        .ok()
        .map(|s| s.trim().to_string())?;
    let short = merge.strip_prefix("refs/heads/").unwrap_or(&merge);
    if short.is_empty() {
        return None;
    }
    if short == branch {
        return None;
    }
    Some(format!("origin/{short}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn init_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run_git(&["init", "-q"], path).await.unwrap();
        run_git(&["config", "user.email", "test@example.com"], path)
            .await
            .unwrap();
        run_git(&["config", "user.name", "Test"], path)
            .await
            .unwrap();
        // Disable gpg signing locally so the test doesn't depend on the
        // developer's global `commit.gpgsign` / signing-key state.
        run_git(&["config", "commit.gpgsign", "false"], path)
            .await
            .unwrap();
        run_git(&["config", "tag.gpgsign", "false"], path)
            .await
            .unwrap();
        run_git(&["commit", "--allow-empty", "-m", "init"], path)
            .await
            .unwrap();
        dir
    }

    /// Local `main` is one commit behind `origin/main`. The fallback chain
    /// for "what should we compare against?" must land on `origin/main` —
    /// the remote tip is the shared truth, the stale local copy isn't.
    /// Regression test for the bug where step 3 used to return local `main`
    /// before any `origin/...` probe.
    #[tokio::test]
    async fn get_original_branch_prefers_origin_over_stale_local_main() {
        let dir = init_test_repo().await;
        let path = dir.path();
        // Force the branch name to `main` regardless of the developer's
        // `init.defaultBranch` so the rest of the test doesn't depend on
        // local git config.
        let _ = run_git(&["branch", "-M", "main"], path).await;

        // Commit on local `main`, then snapshot it as the remote tip.
        tokio::fs::write(path.join("a.txt"), "remote\n")
            .await
            .unwrap();
        run_git(&["add", "a.txt"], path).await.unwrap();
        run_git(&["commit", "-q", "-m", "shared"], path)
            .await
            .unwrap();
        let remote_head = run_git(&["rev-parse", "HEAD"], path)
            .await
            .unwrap()
            .trim()
            .to_string();
        run_git(
            &["update-ref", "refs/remotes/origin/main", &remote_head],
            path,
        )
        .await
        .unwrap();
        run_git(
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
            path,
        )
        .await
        .unwrap();

        // Now reset local `main` *backwards* one commit so it's stale w.r.t.
        // origin/main. A naive fallback would compare against this local
        // `main`, hiding work that's actually in front of the remote.
        run_git(&["commit", "--allow-empty", "-q", "-m", "extra"], path)
            .await
            .unwrap();
        // Stale by going back to the parent.
        run_git(&["reset", "--hard", "HEAD~1"], path).await.unwrap();
        // Verify our setup: local main and origin/main point to different
        // commits (we made origin advance via a separate empty commit).
        run_git(
            &["commit", "--allow-empty", "-q", "-m", "remote-only"],
            path,
        )
        .await
        .unwrap();
        let new_remote_head = run_git(&["rev-parse", "HEAD"], path)
            .await
            .unwrap()
            .trim()
            .to_string();
        run_git(
            &["update-ref", "refs/remotes/origin/main", &new_remote_head],
            path,
        )
        .await
        .unwrap();
        run_git(&["reset", "--hard", "HEAD~1"], path).await.unwrap();

        let local_main = run_git(&["rev-parse", "main"], path)
            .await
            .unwrap()
            .trim()
            .to_string();
        let remote_main = run_git(&["rev-parse", "origin/main"], path)
            .await
            .unwrap()
            .trim()
            .to_string();
        assert_ne!(
            local_main, remote_main,
            "test setup invariant: local main must be stale w.r.t. origin/main"
        );

        // Detach HEAD so tracking config (step 1) doesn't fire — we're
        // exercising the symbolic-ref step here.
        run_git(&["checkout", "-q", "--detach"], path)
            .await
            .unwrap();

        let resolved = get_original_branch(path, "feature/anything").await.unwrap();
        assert_eq!(
            resolved, "origin/main",
            "fallback must keep the `origin/` prefix so a stale local main \
             cannot bias the comparison base"
        );
    }

    /// When `branch.<branch>.remote == origin` and `branch.<branch>.merge`
    /// resolves, return `origin/<merge-shortname>` rather than the local
    /// shortname. Without this fix the function returned `main` (local) and
    /// silently used a stale comparison base.
    #[tokio::test]
    async fn get_original_branch_returns_origin_prefixed_tracking_target() {
        let dir = init_test_repo().await;
        let path = dir.path();
        let _ = run_git(&["branch", "-M", "main"], path).await;

        // Create a feature branch and configure it to track origin/main.
        run_git(&["checkout", "-q", "-b", "feature/x"], path)
            .await
            .unwrap();
        run_git(&["config", "branch.feature/x.remote", "origin"], path)
            .await
            .unwrap();
        run_git(
            &["config", "branch.feature/x.merge", "refs/heads/main"],
            path,
        )
        .await
        .unwrap();

        let resolved = get_original_branch(path, "feature/x").await.unwrap();
        assert_eq!(resolved, "origin/main");
    }

    #[tokio::test]
    async fn get_original_branch_ignores_self_tracking_feature_upstream() {
        let dir = init_test_repo().await;
        let path = dir.path();
        let _ = run_git(&["branch", "-M", "main"], path).await;
        run_git(&["update-ref", "refs/remotes/origin/main", "HEAD"], path)
            .await
            .unwrap();
        run_git(
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
            path,
        )
        .await
        .unwrap();

        run_git(&["checkout", "-q", "-b", "feature/x"], path)
            .await
            .unwrap();
        run_git(&["config", "branch.feature/x.remote", "origin"], path)
            .await
            .unwrap();
        run_git(
            &["config", "branch.feature/x.merge", "refs/heads/feature/x"],
            path,
        )
        .await
        .unwrap();

        let resolved = get_original_branch(path, "feature/x").await.unwrap();
        assert_eq!(resolved, "origin/main");
    }
}
