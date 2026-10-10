use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::{git_ref_resolves_background, run_git_background};

use super::parsing::{self, parse_porcelain_v2};
use super::{GitStatusSnapshot, SharedFeatureRef};
use crate::domain::git::host::{self, GitHost, RemoteInfo};
use crate::domain::git::workflow_service::{
    detect_active_git_operation, resolve_configured_update_target,
};

/// Build a degraded snapshot for cases where we can't actually probe the
/// worktree (path is missing, worktree is still being created, etc). The
/// frontend treats every action as disabled because every count is `0` and
/// `has_remote` is `false` — but the chip / button still get a determinate
/// shape to render instead of staying stuck on "Loading…".
fn empty_snapshot(feature_id: i64, target_branch: &str) -> GitStatusSnapshot {
    GitStatusSnapshot {
        feature_id,
        current_branch: String::new(),
        target_branch: target_branch.to_string(),
        uncommitted_count: 0,
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        ahead_of_remote: 0,
        behind_remote: 0,
        ahead_of_target: 0,
        behind_target: 0,
        target_resolved: false,
        update_target_branch: None,
        ahead_of_update_target: 0,
        behind_update_target: 0,
        update_target_resolved: false,
        conflict_count: 0,
        operation: None,
        has_remote: false,
        host: None,
        compare_url: None,
        action_label: None,
        shared_with: Vec::<SharedFeatureRef>::new(),
        computed_at: chrono::Utc::now().timestamp_millis(),
    }
}

/// Same contract as `compute_status` but degrades to `empty_snapshot` instead
/// of bubbling a `GIT_COMMAND_ERROR` when `repo` is missing or has no Git metadata. Use
/// this from request handlers and the watcher subscribe path so a stale
/// `worktree_path` setting doesn't spam the error log on every poll.
pub async fn compute_status_or_empty(
    repo: &Path,
    feature_id: i64,
    target_branch: &str,
) -> Result<GitStatusSnapshot, AppError> {
    if !crate::shared::git_context::has_git_metadata(repo).await? {
        return Ok(empty_snapshot(feature_id, target_branch));
    }
    compute_status(repo, feature_id, target_branch).await
}

/// Compute a fresh snapshot for `repo`. `target_branch` is whatever the
/// frontend (or the resolved fallback chain) decided; we just compare against
/// it. Caller decides whether to surface stale data.
async fn compute_status(
    repo: &Path,
    feature_id: i64,
    target_branch: &str,
) -> Result<GitStatusSnapshot, AppError> {
    // Watcher hot path: every git spawn here goes through
    // `run_git_background` so this code path can't race a user-initiated
    // rebase/commit for `.git/index.lock`. See `run_git_background` docs.
    let porcelain = run_git_background(
        &["status", "--porcelain=v2", "-z", "-b", "--ahead-behind"],
        repo,
    )
    .await?;
    let parsed = parse_porcelain_v2(&porcelain);
    let current_ref = format!("refs/heads/{}", parsed.current_branch);
    let update_target = async {
        if parsed.behind > 0 {
            if let Some(upstream) = parsed.upstream.as_ref() {
                return Ok::<String, AppError>(upstream.clone());
            }
        }
        resolve_configured_update_target(repo, &current_ref, target_branch).await
    };
    let (ahead_of_remote, target_divergence, update_target, remote_info, operation) = tokio::join!(
        count_unpushed(repo, &parsed),
        resolve_target_divergence(repo, target_branch),
        update_target,
        resolve_remote_info(repo),
        detect_active_git_operation(repo),
    );
    let target_divergence = target_divergence?;
    let update_target = update_target?;
    let update_divergence = if parsed.upstream.as_deref() == Some(update_target.as_str()) {
        TargetDivergence {
            ahead: parsed.ahead,
            behind: parsed.behind,
            resolved: true,
        }
    } else if update_target == target_branch {
        target_divergence
    } else {
        resolve_target_divergence(repo, &update_target).await?
    };
    let operation = operation?;
    let has_remote = remote_info.is_some();
    let (host, compare_url, action_label) =
        derive_provider_fields(remote_info.as_ref(), target_branch, &parsed.current_branch);

    Ok(GitStatusSnapshot {
        feature_id,
        current_branch: parsed.current_branch,
        target_branch: target_branch.to_string(),
        uncommitted_count: parsed.staged_count + parsed.unstaged_count + parsed.untracked_count,
        staged_count: parsed.staged_count,
        unstaged_count: parsed.unstaged_count,
        untracked_count: parsed.untracked_count,
        ahead_of_remote,
        behind_remote: parsed.behind,
        ahead_of_target: target_divergence.ahead,
        behind_target: target_divergence.behind,
        target_resolved: target_divergence.resolved,
        update_target_branch: Some(update_target),
        ahead_of_update_target: update_divergence.ahead,
        behind_update_target: update_divergence.behind,
        update_target_resolved: update_divergence.resolved,
        conflict_count: parsed.conflict_count,
        operation,
        has_remote,
        host,
        compare_url,
        action_label,
        shared_with: Vec::new(),
        computed_at: chrono::Utc::now().timestamp_millis(),
    })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct TargetDivergence {
    ahead: u32,
    behind: u32,
    resolved: bool,
}

/// Resolve the configured target independently from its divergence. A valid
/// target at zero commits is still resolved; a missing target degrades to
/// zero counts without being mistaken for equality with `HEAD`.
async fn resolve_target_divergence(
    repo: &Path,
    target_branch: &str,
) -> Result<TargetDivergence, AppError> {
    crate::shared::git_cli::guard_positionals(&[target_branch])?;
    let commit = format!("{target_branch}^{{commit}}");
    if !git_ref_resolves_background(&commit, repo).await? {
        return Ok(TargetDivergence::default());
    }

    let range = format!("HEAD...{target_branch}");
    let counts = run_git_background(&["rev-list", "--left-right", "--count", &range], repo).await?;
    let mut counts = counts.split_whitespace();
    Ok(TargetDivergence {
        ahead: counts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        behind: counts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        resolved: true,
    })
}

/// Count commits reachable from `HEAD` that haven't been published anywhere.
///
/// When an upstream is configured, `branch.ab` is authoritative and matches
/// `git push`'s view exactly. Without an upstream — typical for a freshly
/// created local branch that's never been pushed — `branch.ab` is missing
/// from the porcelain, and we fall back to `git rev-list --count HEAD --not
/// --remotes`. That's the count of commits reachable from `HEAD` but
/// not from any remote-tracking ref, i.e. exactly what a first
/// `git push -u origin HEAD` would publish.
async fn count_unpushed(repo: &Path, parsed: &parsing::ParsedPorcelain) -> u32 {
    if parsed.upstream.is_some() {
        return parsed.ahead;
    }
    run_git_background(&["rev-list", "--count", "HEAD", "--not", "--remotes"], repo)
        .await
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Read `remote.origin.url` and feed it to `host::detect_remote`. Returns
/// `None` when there's no `origin` remote (fresh repo, detached clone, etc).
async fn resolve_remote_info(repo: &Path) -> Option<RemoteInfo> {
    host::detect_origin_remote(repo).await
}

/// Bundle the provider-derived fields. `compare_url` is `None` when:
///   * there's no remote at all, OR
///   * the remote's host is `Other` (`host::compare_url` refuses to guess).
/// `action_label` is set whenever we have *any* remote so the frontend has a
/// label to render even when the action itself is disabled.
fn derive_provider_fields(
    info: Option<&RemoteInfo>,
    target: &str,
    head: &str,
) -> (Option<GitHost>, Option<String>, Option<String>) {
    match info {
        Some(info) => {
            let url = host::compare_url(info, target, head);
            let label = host::pr_label(&info.host).to_string();
            (Some(info.host), url, Some(label))
        }
        None => (None, None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_fields_none_when_no_remote() {
        let (host, url, label) = derive_provider_fields(None, "main", "feat");
        assert!(host.is_none());
        assert!(url.is_none());
        assert!(label.is_none());
    }

    #[test]
    fn provider_fields_set_for_github() {
        let info = host::detect_remote("git@github.com:owner/repo.git").unwrap();
        let (h, url, label) = derive_provider_fields(Some(&info), "main", "feat");
        assert_eq!(h, Some(GitHost::GitHub));
        assert_eq!(label.as_deref(), Some("Open pull request"));
        assert!(url.unwrap().contains("compare/main...feat"));
    }

    #[test]
    fn provider_fields_url_is_none_for_other_host() {
        let info = host::detect_remote("https://example.com/foo/bar.git").unwrap();
        let (h, url, label) = derive_provider_fields(Some(&info), "main", "feat");
        assert_eq!(h, Some(GitHost::Other));
        assert!(url.is_none());
        assert_eq!(label.as_deref(), Some("Open compare"));
    }

    #[test]
    fn empty_snapshot_has_blank_branch_and_zero_counts() {
        let snap = empty_snapshot(7, "main");
        assert_eq!(snap.feature_id, 7);
        assert_eq!(snap.current_branch, "");
        assert_eq!(snap.target_branch, "main");
        assert_eq!(snap.uncommitted_count, 0);
        assert!(!snap.has_remote);
        assert!(snap.compare_url.is_none());
        let json = serde_json::to_value(&snap).unwrap();
        assert!(json.get("behind_target").is_none());
        assert!(json.get("target_resolved").is_none());
        assert!(json.get("conflict_count").is_none());
        assert!(json.get("operation").is_none());
    }

    #[tokio::test]
    async fn compute_status_or_empty_returns_empty_when_path_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let snap = compute_status_or_empty(&missing, 1, "main").await.unwrap();
        assert_eq!(snap.current_branch, "");
        assert_eq!(snap.uncommitted_count, 0);
    }

    #[tokio::test]
    async fn compute_status_or_empty_skips_git_for_plain_folders() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not a repository").unwrap();
        let snap = compute_status_or_empty(dir.path(), 1, "main")
            .await
            .unwrap();
        assert_eq!(snap.current_branch, "");
        assert_eq!(snap.uncommitted_count, 0);
        assert!(!snap.has_remote);
    }

    #[tokio::test]
    async fn compute_status_or_empty_preserves_broken_repository_errors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".git"), "gitdir: missing").unwrap();
        assert!(compute_status_or_empty(dir.path(), 1, "main")
            .await
            .is_err());
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", dir)
            .output()
            .expect("git spawn");
        assert!(
            out.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        run_git(dir, &["init", "-q", "-b", "main"]);
        run_git(dir, &["config", "user.email", "t@t"]);
        run_git(dir, &["config", "user.name", "Test"]);
        run_git(dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        run_git(dir, &["add", "seed.txt"]);
        run_git(dir, &["commit", "-q", "-m", "seed"]);
    }

    #[tokio::test]
    async fn compute_status_clean_repo() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let snap = compute_status(dir.path(), 42, "main").await.unwrap();
        assert_eq!(snap.feature_id, 42);
        assert_eq!(snap.current_branch, "main");
        assert_eq!(snap.target_branch, "main");
        assert_eq!(snap.uncommitted_count, 0);
        assert_eq!(snap.staged_count, 0);
        assert_eq!(snap.unstaged_count, 0);
        assert_eq!(snap.untracked_count, 0);
        assert_eq!(snap.ahead_of_target, 0);
        assert_eq!(snap.behind_target, 0);
        assert!(snap.target_resolved);
        assert_eq!(snap.conflict_count, 0);
        assert_eq!(snap.operation, None);
        assert!(!snap.has_remote, "no remote configured in fresh init");
        assert!(snap.compare_url.is_none());
        assert!(snap.shared_with.is_empty());
    }

    #[tokio::test]
    async fn compute_status_counts_staged_unstaged_untracked() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        run_git(dir.path(), &["add", "a.txt"]);
        run_git(dir.path(), &["commit", "-q", "-m", "add a"]);
        std::fs::write(dir.path().join("seed.txt"), "modified\n").unwrap();
        run_git(dir.path(), &["add", "seed.txt"]);
        std::fs::write(dir.path().join("a.txt"), "a-changed\n").unwrap();
        std::fs::write(dir.path().join("untracked.txt"), "u\n").unwrap();

        let snap = compute_status(dir.path(), 1, "main").await.unwrap();
        assert_eq!(snap.staged_count, 1);
        assert_eq!(snap.unstaged_count, 1);
        assert_eq!(snap.untracked_count, 1);
        assert_eq!(
            snap.uncommitted_count,
            snap.staged_count + snap.unstaged_count + snap.untracked_count
        );
    }

    #[tokio::test]
    async fn compute_status_ahead_of_target_uses_rev_list() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        run_git(dir.path(), &["checkout", "-q", "-b", "feat"]);
        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        run_git(dir.path(), &["add", "."]);
        run_git(dir.path(), &["commit", "-q", "-m", "c1"]);
        std::fs::write(dir.path().join("b.txt"), "b\n").unwrap();
        run_git(dir.path(), &["add", "."]);
        run_git(dir.path(), &["commit", "-q", "-m", "c2"]);

        let snap = compute_status(dir.path(), 1, "main").await.unwrap();
        assert_eq!(snap.current_branch, "feat");
        assert_eq!(snap.ahead_of_target, 2);
        assert_eq!(snap.behind_target, 0);
        assert!(snap.target_resolved);
    }

    #[tokio::test]
    async fn compute_status_reports_two_sided_target_divergence() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        run_git(dir.path(), &["branch", "feat"]);
        std::fs::write(dir.path().join("target.txt"), "target\n").unwrap();
        run_git(dir.path(), &["add", "target.txt"]);
        run_git(dir.path(), &["commit", "-q", "-m", "target"]);
        run_git(dir.path(), &["checkout", "-q", "feat"]);
        std::fs::write(dir.path().join("feature.txt"), "feature\n").unwrap();
        run_git(dir.path(), &["add", "feature.txt"]);
        run_git(dir.path(), &["commit", "-q", "-m", "feature"]);

        let snap = compute_status(dir.path(), 1, "main").await.unwrap();

        assert_eq!(snap.ahead_of_target, 1);
        assert_eq!(snap.behind_target, 1);
        assert!(snap.target_resolved);
    }

    #[tokio::test]
    async fn unresolved_target_is_distinct_from_zero_divergence() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());

        let snap = compute_status(dir.path(), 1, "missing-target")
            .await
            .unwrap();

        assert_eq!(snap.ahead_of_target, 0);
        assert_eq!(snap.behind_target, 0);
        assert!(!snap.target_resolved);
    }

    #[tokio::test]
    async fn compute_status_counts_unique_unmerged_paths() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        run_git(dir.path(), &["checkout", "-q", "-b", "other"]);
        std::fs::write(dir.path().join("seed.txt"), "other\n").unwrap();
        run_git(dir.path(), &["commit", "-qam", "other"]);
        run_git(dir.path(), &["checkout", "-q", "main"]);
        std::fs::write(dir.path().join("seed.txt"), "main\n").unwrap();
        run_git(dir.path(), &["commit", "-qam", "main"]);
        let merge = std::process::Command::new("git")
            .args(["merge", "other"])
            .current_dir(dir.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", dir.path())
            .output()
            .unwrap();
        assert!(!merge.status.success());

        let snap = compute_status(dir.path(), 1, "main").await.unwrap();

        assert_eq!(snap.conflict_count, 1);
        assert_eq!(
            snap.operation,
            Some(crate::domain::git::models::GitOperationKind::Merge)
        );
    }

    #[tokio::test]
    async fn compute_status_populates_provider_fields_when_remote_set() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        run_git(
            dir.path(),
            &["remote", "add", "origin", "git@github.com:owner/repo.git"],
        );
        let snap = compute_status(dir.path(), 1, "main").await.unwrap();
        assert!(snap.has_remote);
        assert_eq!(snap.host, Some(GitHost::GitHub));
        assert!(snap
            .compare_url
            .as_deref()
            .unwrap()
            .contains("compare/main...main"));
        assert_eq!(snap.action_label.as_deref(), Some("Open pull request"));
    }

    #[tokio::test]
    async fn ahead_of_remote_uses_not_remotes_fallback_when_no_upstream() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let remote_dir = tempfile::tempdir().unwrap();
        run_git(remote_dir.path(), &["init", "-q", "--bare"]);
        run_git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        );
        run_git(dir.path(), &["push", "-q", "origin", "main"]);

        run_git(dir.path(), &["checkout", "-q", "-b", "feat"]);
        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        run_git(dir.path(), &["add", "."]);
        run_git(dir.path(), &["commit", "-q", "-m", "c1"]);

        let snap = compute_status(dir.path(), 1, "main").await.unwrap();
        assert_eq!(snap.current_branch, "feat");
        assert_eq!(snap.ahead_of_remote, 1);
    }

    #[tokio::test]
    async fn current_upstream_drives_the_update_source_and_divergence() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        run_git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://example.com/repository.git",
            ],
        );
        run_git(dir.path(), &["checkout", "-q", "-b", "feat"]);
        run_git(dir.path(), &["config", "branch.feat.remote", "origin"]);
        run_git(
            dir.path(),
            &["config", "branch.feat.merge", "refs/heads/feat"],
        );
        run_git(dir.path(), &["checkout", "-q", "-b", "remote-feat"]);
        std::fs::write(dir.path().join("remote.txt"), "remote\n").unwrap();
        run_git(dir.path(), &["add", "remote.txt"]);
        run_git(dir.path(), &["commit", "-q", "-m", "remote"]);
        run_git(
            dir.path(),
            &["update-ref", "refs/remotes/origin/feat", "remote-feat"],
        );
        run_git(dir.path(), &["checkout", "-q", "feat"]);
        run_git(dir.path(), &["branch", "-D", "remote-feat"]);

        let snap = compute_status(dir.path(), 1, "main").await.unwrap();
        assert_eq!(snap.behind_remote, 1);
        assert_eq!(snap.update_target_branch.as_deref(), Some("origin/feat"));
        assert_eq!(snap.ahead_of_update_target, 0);
        assert_eq!(snap.behind_update_target, 1);
        assert!(snap.update_target_resolved);
    }

    #[tokio::test]
    async fn ahead_of_target_uses_remote_ref_when_picked_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());

        run_git(dir.path(), &["checkout", "-q", "-b", "tmp_origin"]);
        std::fs::write(dir.path().join("upstream.txt"), "u\n").unwrap();
        run_git(dir.path(), &["add", "."]);
        run_git(dir.path(), &["commit", "-q", "-m", "upstream-only"]);
        let origin_oid = capture_git(dir.path(), &["rev-parse", "HEAD"]);
        run_git(
            dir.path(),
            &["update-ref", "refs/remotes/origin/main", origin_oid.trim()],
        );

        run_git(dir.path(), &["checkout", "-q", "main"]);
        run_git(dir.path(), &["branch", "-D", "tmp_origin"]);
        std::fs::write(dir.path().join("local_only.txt"), "l\n").unwrap();
        run_git(dir.path(), &["add", "."]);
        run_git(dir.path(), &["commit", "-q", "-m", "local-only"]);
        run_git(dir.path(), &["checkout", "-q", "-b", "feat"]);
        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        run_git(dir.path(), &["add", "."]);
        run_git(dir.path(), &["commit", "-q", "-m", "feat-c1"]);

        let snap_local = compute_status(dir.path(), 1, "main").await.unwrap();
        assert_eq!(snap_local.ahead_of_target, 1);
        let snap_remote = compute_status(dir.path(), 1, "origin/main").await.unwrap();
        assert_eq!(snap_remote.ahead_of_target, 2);

        run_git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://example.com/repository.git",
            ],
        );
        run_git(dir.path(), &["config", "branch.main.remote", "origin"]);
        run_git(
            dir.path(),
            &["config", "branch.main.merge", "refs/heads/main"],
        );
        let snap_tracked_local = compute_status(dir.path(), 1, "main").await.unwrap();
        assert_eq!(
            snap_tracked_local.update_target_branch.as_deref(),
            Some("origin/main")
        );
        assert_eq!(snap_tracked_local.ahead_of_update_target, 2);
        assert_eq!(snap_tracked_local.behind_update_target, 1);
        assert!(snap_tracked_local.update_target_resolved);
    }

    #[tokio::test]
    async fn linked_worktree_snapshot_reports_the_active_merge() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let linked = temp.path().join("linked");
        std::fs::create_dir(&main).unwrap();
        init_repo(&main);
        std::fs::write(main.join("conflict.txt"), "base\n").unwrap();
        run_git(&main, &["add", "conflict.txt"]);
        run_git(&main, &["commit", "-q", "-m", "base"]);
        run_git(&main, &["branch", "feature"]);
        run_git(
            &main,
            &["worktree", "add", "-q", linked.to_str().unwrap(), "feature"],
        );

        std::fs::write(main.join("conflict.txt"), "target\n").unwrap();
        run_git(&main, &["commit", "-qam", "target"]);
        std::fs::write(linked.join("conflict.txt"), "feature\n").unwrap();
        run_git(&linked, &["commit", "-qam", "feature"]);
        let merge = std::process::Command::new("git")
            .args(["merge", "main"])
            .current_dir(&linked)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &linked)
            .output()
            .unwrap();
        assert!(!merge.status.success());

        let snapshot = compute_status(&linked, 1, "main").await.unwrap();
        assert_eq!(
            snapshot.operation,
            Some(crate::domain::git::models::GitOperationKind::Merge)
        );
        assert_eq!(snapshot.conflict_count, 1);
    }

    fn capture_git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", dir)
            .output()
            .expect("git spawn");
        assert!(
            out.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[tokio::test]
    async fn compute_status_provider_url_none_for_unknown_host() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        run_git(
            dir.path(),
            &["remote", "add", "origin", "git@example.com:foo/bar.git"],
        );
        let snap = compute_status(dir.path(), 1, "main").await.unwrap();
        assert!(snap.has_remote);
        assert_eq!(snap.host, Some(GitHost::Other));
        assert!(snap.compare_url.is_none());
        assert_eq!(snap.action_label.as_deref(), Some("Open compare"));
    }
}
