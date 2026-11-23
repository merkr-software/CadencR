//! Worktree-level Git state: what `git status` and its companions report for
//! a checkout, independent of the target branch a feature compares against.
//! Computed once per checkout and shared by every feature on it.

use std::path::Path;

use super::parsing::{parse_porcelain_v2, ParsedPorcelain};
use super::DETACHED_HEAD;
use crate::domain::git::host::{self, RemoteInfo};
use crate::domain::git::models::GitOperationKind;
use crate::domain::git::workflow_service::detect_active_git_operation;
use crate::error::AppError;
use crate::shared::git_cli::{
    head_is_unborn, run_git_background, run_git_background_within, GitReadDeadline,
};

/// Worktree-level Git state shared across features on the same checkout.
pub(crate) enum WorktreeStatusBase {
    NoGit,
    Git(GitWorktreeBase),
}

pub(crate) struct GitWorktreeBase {
    pub(super) parsed: ParsedPorcelain,
    pub(super) probes: WorktreeProbes,
}

/// What the probes that follow `git status` report.
pub(super) struct WorktreeProbes {
    pub(super) ahead_of_remote: u32,
    pub(super) remote_info: Option<RemoteInfo>,
    pub(super) operation: Option<GitOperationKind>,
}

impl WorktreeStatusBase {
    pub(crate) fn has_git(&self) -> bool {
        matches!(self, Self::Git(_))
    }

    pub(crate) fn checked_out_branch(&self) -> Option<&str> {
        let Self::Git(git) = self else { return None };
        let b = git.parsed.current_branch.as_str();
        (!b.is_empty() && b != DETACHED_HEAD).then_some(b)
    }
}

/// No deadline for the watcher's `status`: a cold one over a worktree full of
/// untracked files can take minutes, and killing it would only make the
/// watcher's next refresh start the same scan over. The watcher runs one
/// compute per worktree at a time and drops it on shutdown, which kills it.
const WATCHER_STATUS_DEADLINE: GitReadDeadline = GitReadDeadline::Unbounded;

/// Compute worktree-level Git status once for `repo` so sibling features
/// sharing the checkout do not repeat `git status`, unpushed counting, remote
/// detection, or active operation probes.
pub(crate) async fn compute_worktree_base(repo: &Path) -> Result<WorktreeStatusBase, AppError> {
    if !crate::shared::git_context::has_git_metadata(repo).await? {
        return Ok(WorktreeStatusBase::NoGit);
    }
    let parsed = read_porcelain(repo, WATCHER_STATUS_DEADLINE).await?;
    let probes = probe_worktree(repo, &parsed).await?;
    Ok(WorktreeStatusBase::Git(GitWorktreeBase { parsed, probes }))
}

/// `git status --porcelain=v2` for `repo`, parsed.
///
/// Watcher hot path: every git spawn in this module goes through
/// `run_git_background` so it can't race a user-initiated rebase/commit for
/// `.git/index.lock`. See `run_git_background` docs. `deadline` is the
/// caller's: none for the watcher, a stall guard for a request.
pub(super) async fn read_porcelain(
    repo: &Path,
    deadline: GitReadDeadline,
) -> Result<ParsedPorcelain, AppError> {
    let porcelain = run_git_background_within(
        &["status", "--porcelain=v2", "-z", "-b", "--ahead-behind"],
        repo,
        deadline,
    )
    .await?;
    Ok(parse_porcelain_v2(&porcelain))
}

/// The worktree-level probes that follow `git status`, run concurrently.
pub(super) async fn probe_worktree(
    repo: &Path,
    parsed: &ParsedPorcelain,
) -> Result<WorktreeProbes, AppError> {
    let (ahead_of_remote, remote_info, operation) = tokio::join!(
        count_unpushed(repo, parsed),
        host::detect_origin_remote(repo),
        detect_active_git_operation(repo),
    );
    Ok(WorktreeProbes {
        ahead_of_remote: ahead_of_remote?,
        remote_info: remote_info?,
        operation: operation?,
    })
}

/// Count commits reachable from `HEAD` that haven't been published anywhere.
///
/// When an upstream is tracked, `branch.ab` is authoritative and matches
/// `git push`'s view exactly. Without one — typical for a freshly created
/// local branch that's never been pushed, or one whose upstream is `[gone]`
/// after the remote branch was deleted — `branch.ab` is missing from the
/// porcelain, and we fall back to `git rev-list --count HEAD --not
/// --remotes`. That's the count of commits reachable from `HEAD` but not from
/// any remote-tracking ref, i.e. exactly what a first
/// `git push -u origin HEAD` would publish.
///
/// An unborn branch has nothing to publish; any other failure is an error,
/// never a "0 to push" that would hide unpublished work.
pub(super) async fn count_unpushed(repo: &Path, parsed: &ParsedPorcelain) -> Result<u32, AppError> {
    if parsed.tracked_upstream().is_some() {
        return Ok(parsed.ahead);
    }
    let args = ["rev-list", "--count", "HEAD", "--not", "--remotes", "--"];
    let count = match run_git_background(&args, repo).await {
        Ok(count) => count,
        Err(error) => {
            return match head_is_unborn(repo).await {
                Ok(true) => Ok(0),
                // Git's own message says best why the count failed.
                Ok(false) | Err(_) => Err(error),
            };
        }
    };
    count
        .trim()
        .parse()
        .map_err(|_| AppError::git_command(format!("git rev-list --count printed {count:?}")))
}

#[cfg(test)]
mod tests {
    use super::super::test_git::repo_with_gone_upstream;
    use super::*;

    /// A cold `status` over a worktree full of untracked files can take
    /// minutes; a deadline would kill it and the watcher's next refresh would
    /// start it over, forever. An `fsmonitor` hook stands in for the slow
    /// scan; the paused clock makes any deadline fire at once.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn a_slow_status_is_never_cut_short() {
        use std::os::unix::fs::PermissionsExt as _;

        let repo = tempfile::tempdir().unwrap();
        let hook = repo.path().join("slow-fsmonitor.sh");
        std::fs::write(&hook, "#!/bin/sh\nsleep 1\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let hook = hook.to_string_lossy().into_owned();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "core.fsmonitor", &hook],
        ] {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(repo.path())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        }
        std::fs::write(repo.path().join("untracked.txt"), "x").unwrap();

        let parsed = read_porcelain(repo.path(), WATCHER_STATUS_DEADLINE)
            .await
            .unwrap();
        assert_eq!(parsed.current_branch, "main");
    }

    /// An unborn branch has nothing to publish; a repository Git cannot read
    /// is an error rather than "0 to push".
    #[tokio::test]
    async fn unpushed_count_tells_an_unborn_branch_from_a_failure() {
        let parsed = parse_porcelain_v2("");
        let repo = tempfile::tempdir().unwrap();
        crate::shared::git_cli::run_git(&["init", "-q"], repo.path())
            .await
            .unwrap();
        assert_eq!(count_unpushed(repo.path(), &parsed).await.unwrap(), 0);

        let not_repo = tempfile::tempdir().unwrap();
        assert!(count_unpushed(not_repo.path(), &parsed).await.is_err());
    }

    /// The remote branch was deleted: Git keeps the `branch.upstream` header
    /// but drops `branch.ab`, which must not read as "nothing to push".
    #[tokio::test]
    async fn a_gone_upstream_still_counts_unpublished_commits() {
        let root = tempfile::tempdir().unwrap();
        let repo = repo_with_gone_upstream(root.path());

        let parsed = read_porcelain(&repo, GitReadDeadline::Scan).await.unwrap();
        assert_eq!(parsed.upstream.as_deref(), Some("origin/feat"));
        assert_eq!(parsed.tracked_upstream(), None);
        assert_eq!(count_unpushed(&repo, &parsed).await.unwrap(), 2);
    }
}
