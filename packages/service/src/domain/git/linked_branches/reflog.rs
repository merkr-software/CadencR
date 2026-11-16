//! Branch checkouts read back from the `HEAD` reflog.
//!
//! The reflog is per worktree, timestamped, and written by every way of
//! switching (`git checkout`, `git switch`, `-b` / `-c` included), so it
//! answers "which branches did this directory visit between T1 and T2"
//! without having watched it live.

use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::run_git_background;

/// How far back one turn's lookup reads. A turn that switches branches more
/// often than this is not one whose every stop is worth listing.
const REFLOG_LIMIT: &str = "-n200";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkout {
    pub branch: String,
    /// Unix seconds.
    pub at: i64,
}

/// Local branches checked out in `repo` within `[since, until]` (unix
/// seconds), each once at its last visit, oldest first. Detached checkouts and branches deleted since are
/// left out: neither is something a conversation can come back to.
pub async fn checkouts_between(
    repo: &Path,
    since: i64,
    until: i64,
) -> Result<Vec<Checkout>, AppError> {
    let log = run_git_background(
        &[
            "reflog",
            "show",
            REFLOG_LIMIT,
            "--date=unix",
            "--format=%gd%x09%gs",
            "HEAD",
        ],
        repo,
    )
    .await?;
    let candidates = parse_checkouts(&log)
        .into_iter()
        .filter(|checkout| checkout.at >= since && checkout.at <= until)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(candidates);
    }
    let locals = crate::domain::git::commands::list_local_branches(repo).await?;
    // One entry per branch, at its last visit: all a sighting records.
    let mut latest = Vec::<Checkout>::new();
    for checkout in candidates {
        if locals.contains(&checkout.branch) {
            latest.retain(|seen| seen.branch != checkout.branch);
            latest.push(checkout);
        }
    }
    Ok(latest)
}

/// Parse `HEAD@{<unix>}\tcheckout: moving from <a> to <b>` lines, newest
/// first as git prints them, into checkouts oldest first.
fn parse_checkouts(log: &str) -> Vec<Checkout> {
    let mut checkouts = log
        .lines()
        .filter_map(|line| {
            let (selector, subject) = line.split_once('\t')?;
            let at = selector
                .strip_prefix("HEAD@{")?
                .strip_suffix('}')?
                .parse::<i64>()
                .ok()?;
            let moves = subject.strip_prefix("checkout: moving from ")?;
            // Branch names never contain spaces, so the last " to " is the
            // separator even when the source is a full commit sha.
            let (_, branch) = moves.rsplit_once(" to ")?;
            let branch = branch.trim();
            (!branch.is_empty() && branch != "HEAD").then(|| Checkout {
                branch: branch.to_string(),
                at,
            })
        })
        .collect::<Vec<_>>();
    checkouts.reverse();
    checkouts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_checkouts_oldest_first_and_skips_other_entries() {
        let log = "HEAD@{30}\tcheckout: moving from 257b7de to fix/x\n\
                   HEAD@{20}\tcheckout: moving from main to HEAD\n\
                   HEAD@{15}\tcommit: wip\n\
                   HEAD@{10}\tcheckout: moving from main to feature/a\n\
                   HEAD@{5}\tcommit (initial): i\n";
        assert_eq!(
            parse_checkouts(log),
            vec![
                Checkout {
                    branch: "feature/a".into(),
                    at: 10
                },
                Checkout {
                    branch: "fix/x".into(),
                    at: 30
                },
            ]
        );
    }

    async fn git(dir: &Path, args: &[&str]) {
        let status = tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .await
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[tokio::test]
    async fn reads_branches_visited_in_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
            &["commit", "--allow-empty", "-q", "-m", "init"],
            &["checkout", "-q", "-b", "fix/x"],
            &["switch", "-q", "-c", "gone"],
            &["checkout", "-q", "--detach"],
            &["checkout", "-q", "main"],
            &["branch", "-q", "-D", "gone"],
        ] {
            git(repo, args).await;
        }
        let now = chrono::Utc::now().timestamp();
        let branches = checkouts_between(repo, now - 60, now + 60)
            .await
            .unwrap()
            .into_iter()
            .map(|checkout| checkout.branch)
            .collect::<Vec<_>>();
        assert_eq!(branches, vec!["fix/x", "main"]);
        assert!(checkouts_between(repo, 0, 1).await.unwrap().is_empty());
    }
}
