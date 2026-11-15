//! Commit-log queries: `get_commit_log`, `get_recent_commits`, plus the
//! `is_pushed` painting via `git rev-list HEAD --not --remotes`.

use std::collections::HashSet;
use std::path::Path;

use crate::domain::git::models::CommitLogEntry;
use crate::error::AppError;
use crate::shared::git_cli::run_git;

use super::util::run_git_quiet;

const LOG_RS: char = '\x1e';

fn parse_git_log(output: &str) -> Vec<CommitLogEntry> {
    if output.trim().is_empty() {
        return vec![];
    }

    let mut commits = vec![];
    for entry in output.trim().split(LOG_RS).filter(|s| !s.is_empty()) {
        let lines: Vec<&str> = entry.trim().lines().collect();
        if lines.len() < 5 {
            continue;
        }
        commits.push(CommitLogEntry {
            sha: lines[0].to_string(),
            short_sha: lines[1].to_string(),
            message: lines[2].to_string(),
            author: lines[3].to_string(),
            date: lines[4].to_string(),
            body: lines[5..].join("\n").trim().to_string(),
            is_pushed: true,
        });
    }
    commits
}

/// Set of SHAs reachable from any of `revs` but not from any remote-tracking
/// ref — i.e. the commits that haven't been pushed *anywhere*. Returns `None`
/// only on a hard git error (broken repo, no HEAD); a clean repo with no remotes
/// at all reports `Some(<every commit on revs>)` and the caller correctly
/// flags them all as unpushed.
///
/// **Why not `origin/{branch}..HEAD`?** That older approach made two
/// assumptions that broke for real users:
///   1. the remote is named `origin`,
///   2. the remote branch has the same name as the local branch.
///
/// Both fail under perfectly normal setups (a second remote, an upstream
/// configured under a different name, a freshly-initialized branch that
/// shares commits with `origin/main` because it was branched off it). When
/// either assumption broke, the call to `rev-list origin/<branch>..HEAD`
/// either errored (we returned `None` → every commit painted as unpushed)
/// or computed the wrong delta (commits stayed orange after a successful
/// push, even across an app restart — the bug the user reported).
///
/// `git rev-list <revs> --not --remotes` answers the actual question
/// (regardless of remote name or branch-name mapping) and matches the
/// behavior `count_unpushed` in `git_status` already uses for the
/// no-upstream snapshot path. **Argument order matters**: `--not` flips
/// the polarity of every ref token that *follows*, so `revs` must come
/// first (positive) and `--remotes` after `--not` (negative).
///
/// `revs` is every revision the caller is about to paint — the feature's own
/// tip rather than always `HEAD` (so a feature reading a branch it no longer
/// has checked out still gets that branch's split), plus any other tip whose
/// commits appear in the same view.
pub(super) async fn get_unpushed_shas(repo_path: &Path, revs: &[&str]) -> Option<HashSet<String>> {
    let mut args = vec!["rev-list"];
    args.extend_from_slice(revs);
    args.extend_from_slice(&["--not", "--remotes"]);
    match run_git(&args, repo_path).await {
        Ok(stdout) => Some(
            stdout
                .trim()
                .lines()
                .filter(|l| !l.is_empty())
                .map(|s| s.to_string())
                .collect(),
        ),
        // Hard git error: broken repo / no HEAD. Returning `None` paints
        // every commit as unpushed — pessimistic but honest, since we
        // genuinely couldn't determine the answer.
        Err(_) => None,
    }
}

fn apply_pushed_status(commits: &mut [CommitLogEntry], unpushed: Option<&HashSet<String>>) {
    for c in commits.iter_mut() {
        c.is_pushed = match unpushed {
            None => false,
            Some(set) => !set.contains(&c.sha),
        };
    }
}

/// Get commit log for a feature branch relative to a base branch.
///
/// `head_rev` is the feature's own tip — `HEAD` only when its branch is the one
/// checked out at `worktree_path`. See `service::resolve_feature_revision`.
pub async fn get_commit_log(
    worktree_path: &Path,
    base_branch: &str,
    head_rev: &str,
) -> Result<Vec<CommitLogEntry>, AppError> {
    let range = format!("{base_branch}..{head_rev}");
    let format_arg = "\x1e%H%n%h%n%s%n%an%n%ai%n%b".to_string();
    let stdout = run_git_quiet(
        &[
            "log",
            &range,
            &format!("--format={format_arg}"),
            "--reverse",
        ],
        worktree_path,
    )
    .await;

    let mut commits = parse_git_log(&stdout);
    let unpushed = get_unpushed_shas(worktree_path, &[head_rev]).await;
    apply_pushed_status(&mut commits, unpushed.as_ref());
    Ok(commits)
}

/// Get recent commits on `rev` — the feature's own branch, which is `HEAD` only
/// when that branch is the one checked out at `repo_path`.
pub async fn get_recent_commits(
    repo_path: &Path,
    limit: i64,
    rev: &str,
) -> Result<Vec<CommitLogEntry>, AppError> {
    let format_arg = "\x1e%H%n%h%n%s%n%an%n%ai%n%b".to_string();
    let limit_arg = format!("-{limit}");
    let stdout = run_git_quiet(
        &["log", rev, &format!("--format={format_arg}"), &limit_arg],
        repo_path,
    )
    .await;

    let mut commits = parse_git_log(&stdout);
    let unpushed = get_unpushed_shas(repo_path, &[rev]).await;
    apply_pushed_status(&mut commits, unpushed.as_ref());
    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_commit_log() {
        let output = "\x1eabc123full\nabc123\nfix bug\nJohn Doe\n2024-01-01 12:00:00 +0000\nsome body text\n";
        let commits = parse_git_log(output);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].sha, "abc123full");
        assert_eq!(commits[0].short_sha, "abc123");
        assert_eq!(commits[0].message, "fix bug");
        assert_eq!(commits[0].author, "John Doe");
        assert_eq!(commits[0].date, "2024-01-01 12:00:00 +0000");
        assert_eq!(commits[0].body, "some body text");
    }

    #[test]
    fn test_parse_commit_log_empty() {
        assert!(parse_git_log("").is_empty());
        assert!(parse_git_log("  \n  ").is_empty());
    }

    /// End-to-end fixture: a feature branch whose remote-tracking ref does
    /// **not** match its local name (the common, real-world setup that broke
    /// the old `origin/{branch}..HEAD` query). Set `refs/remotes/origin/main`
    /// to the same SHA as `HEAD` and assert that `get_unpushed_shas` reports
    /// the commit as already on a remote — `is_pushed` flips to true.
    #[tokio::test]
    async fn get_unpushed_shas_recognizes_pushed_commit_under_any_remote_ref() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run_git(&["init", "-q"], path).await.unwrap();
        run_git(&["config", "user.email", "t@example.com"], path)
            .await
            .unwrap();
        run_git(&["config", "user.name", "T"], path).await.unwrap();
        run_git(&["config", "commit.gpgsign", "false"], path)
            .await
            .unwrap();

        // One commit on the local branch.
        tokio::fs::write(path.join("a.txt"), "hi\n").await.unwrap();
        run_git(&["add", "a.txt"], path).await.unwrap();
        run_git(&["commit", "-q", "-m", "first"], path)
            .await
            .unwrap();
        let head = run_git(&["rev-parse", "HEAD"], path).await.unwrap();
        let head = head.trim().to_string();

        // No remote-tracking ref yet → every commit is unpushed.
        let unpushed = get_unpushed_shas(path, &["HEAD"]).await.unwrap();
        assert!(
            unpushed.contains(&head),
            "with no remote refs, HEAD should be reported as unpushed"
        );

        // Simulate a successful push by writing the remote-tracking ref to
        // HEAD's SHA. Crucially, the remote ref name (`origin/main`) does
        // NOT match the local branch (`master` or `main` depending on git
        // defaults — either way, we don't rely on that mapping anymore).
        run_git(&["update-ref", "refs/remotes/origin/main", &head], path)
            .await
            .unwrap();

        let unpushed = get_unpushed_shas(path, &["HEAD"]).await.unwrap();
        assert!(
            !unpushed.contains(&head),
            "after a remote-tracking ref reaches HEAD, the commit must be \
             reported as pushed regardless of local/remote name mapping"
        );
    }
}
