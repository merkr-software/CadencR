//! Branch resolution: `get_current_branch` plus the `get_original_branch`
//! fallback chain that the merge dialog uses to figure out which base ref
//! to compare against. Merge / merge-tree / branch-delete orchestration
//! lives in [`super::merge_ops`].

use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::{
    git_ref_resolves_background, guard_positionals, head_is_unborn, run_git_background,
    run_git_probe_background,
};

/// Get the current branch name: `HEAD` when detached, `None` outside a
/// repository or on an unborn branch, which has no commit to name yet. Any
/// other Git failure is an error.
pub async fn get_current_branch(repo_path: &Path) -> Result<Option<String>, AppError> {
    if !crate::shared::git_context::has_git_metadata(repo_path).await? {
        return Ok(None);
    }
    let stdout = match run_git_background(&["rev-parse", "--abbrev-ref", "HEAD"], repo_path).await {
        Ok(stdout) => stdout,
        Err(error) => {
            return match head_is_unborn(repo_path).await {
                Ok(true) => Ok(None),
                // Git's own message says best why the lookup failed.
                Ok(false) | Err(_) => Err(error),
            };
        }
    };
    let branch = stdout.trim();
    Ok((!branch.is_empty()).then(|| branch.to_string()))
}

/// Detect the original branch from which a worktree branch was created, or
/// `None` when no candidate exists. A failing probe is an error, never a
/// reason to move on to the next candidate.
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
) -> Result<Option<String>, AppError> {
    crate::shared::git_context::require_git_metadata(repo_path).await?;
    // 1. Tracking config — only honor when the remote is `origin`. A merge
    //    target whose remote is anything else (or unset) doesn't tell us the
    //    correct `origin/...` ref, so fall through to the symbolic-ref probe
    //    below rather than guessing.
    if let Some(remote_ref) = tracking_remote_ref(repo_path, worktree_branch).await? {
        return Ok(Some(remote_ref));
    }

    // 2. Remote HEAD — keep the `origin/` prefix so callers compare against
    //    the remote tip, not a (possibly stale) local branch with the same
    //    short name.
    if let Some(remote_head) = origin_head(repo_path).await? {
        return Ok(Some(remote_head));
    }

    // 3. Remote `main` / `master` before any local fallback.
    // 4. Local-branch last resort. We only land here when there is no remote
    //    at all (e.g. a brand-new repo without an `origin`).
    for candidate in [
        "origin/main",
        "origin/master",
        "main",
        "master",
        "develop",
        "trunk",
    ] {
        if git_ref_resolves_background(candidate, repo_path).await? {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

/// `origin/<name>` from the `refs/remotes/origin/HEAD` symbolic ref, or `None`
/// when the repository has none.
pub(crate) async fn origin_head(repo_path: &Path) -> Result<Option<String>, AppError> {
    let args = ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"];
    let Some(stdout) = run_git_probe_background(&args, repo_path).await? else {
        return Ok(None);
    };
    Ok(stdout
        .trim()
        .strip_prefix("refs/remotes/")
        .filter(|short| !short.is_empty())
        .map(str::to_string))
}

/// If `branch.<branch>.remote == origin` and `branch.<branch>.merge` resolves
/// to a different `refs/heads/<name>`, return `origin/<name>`. Returns `None`
/// for any other configuration (including a non-origin remote, where we don't
/// know what ref to compare against).
async fn tracking_remote_ref(repo_path: &Path, branch: &str) -> Result<Option<String>, AppError> {
    let remote_key = format!("branch.{branch}.remote");
    let merge_key = format!("branch.{branch}.merge");
    guard_positionals(&[&remote_key, &merge_key])?;

    let remote = run_git_probe_background(&["config", "--get", &remote_key], repo_path).await?;
    if remote.as_deref().map(str::trim) != Some("origin") {
        return Ok(None);
    }
    let Some(merge) = run_git_probe_background(&["config", "--get", &merge_key], repo_path).await?
    else {
        return Ok(None);
    };
    let merge = merge.trim();
    let short = merge.strip_prefix("refs/heads/").unwrap_or(merge);
    if short.is_empty() || short == branch {
        return Ok(None);
    }
    Ok(Some(format!("origin/{short}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli::run_git;

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

        let resolved = get_original_branch(path, "feature/anything")
            .await
            .unwrap()
            .unwrap();
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

        let resolved = get_original_branch(path, "feature/x")
            .await
            .unwrap()
            .unwrap();
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

        let resolved = get_original_branch(path, "feature/x")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resolved, "origin/main");
    }

    /// No candidate is an answer (`None`); an unborn branch has no current
    /// branch to name; a `HEAD` Git cannot read is an error, where both used
    /// to read as "nothing found".
    #[tokio::test]
    async fn branch_probes_tell_absence_from_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run_git(&["init", "-q"], path).await.unwrap();
        run_git(&["symbolic-ref", "HEAD", "refs/heads/topic"], path)
            .await
            .unwrap();
        assert_eq!(get_current_branch(path).await.unwrap(), None);
        assert_eq!(get_original_branch(path, "topic").await.unwrap(), None);

        std::fs::write(path.join(".git/HEAD"), "ref: refs/heads/topic\n").unwrap();
        std::fs::write(path.join(".git/packed-refs"), "not a packed-refs file\n").unwrap();
        assert!(get_original_branch(path, "topic").await.is_err());
    }
}
