use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::run_git_background;

use super::parsing::{self, parse_porcelain_v2};
use super::{GitStatusSnapshot, SharedFeatureRef};
use crate::domain::git::host::{self, GitHost, RemoteInfo};

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
        has_remote: false,
        host: None,
        compare_url: None,
        action_label: None,
        shared_with: Vec::<SharedFeatureRef>::new(),
        computed_at: chrono::Utc::now().timestamp_millis(),
    }
}

/// Same contract as `compute_status` but degrades to `empty_snapshot` instead
/// of bubbling a `GIT_COMMAND_ERROR` when `repo` doesn't exist on disk. Use
/// this from request handlers and the watcher subscribe path so a stale
/// `worktree_path` setting doesn't spam the error log on every poll.
pub async fn compute_status_or_empty(
    repo: &Path,
    feature_id: i64,
    target_branch: &str,
) -> Result<GitStatusSnapshot, AppError> {
    if !repo.exists() {
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
    let porcelain =
        run_git_background(&["status", "--porcelain=v2", "-b", "--ahead-behind"], repo).await?;
    let parsed = parse_porcelain_v2(&porcelain);
    let ahead_of_remote = count_unpushed(repo, &parsed).await;
    let ahead_of_target = count_ahead(repo, target_branch).await;
    let remote_info = resolve_remote_info(repo).await;
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
        ahead_of_target,
        has_remote,
        host,
        compare_url,
        action_label,
        shared_with: Vec::new(),
        computed_at: chrono::Utc::now().timestamp_millis(),
    })
}

/// `git rev-list --count {target}..HEAD`. Returns `0` if the ref doesn't
/// resolve (e.g. configured target was deleted) — the caller still gets a
/// well-formed snapshot rather than a 500.
async fn count_ahead(repo: &Path, target_branch: &str) -> u32 {
    let range = format!("{target_branch}..HEAD");
    match run_git_background(&["rev-list", "--count", &range], repo).await {
        Ok(out) => out.trim().parse().unwrap_or(0),
        Err(_) => 0,
    }
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
    if parsed.has_upstream {
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
    let url = run_git_background(&["config", "--get", "remote.origin.url"], repo)
        .await
        .ok()?;
    host::detect_remote(url.trim())
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
            (Some(info.host.clone()), url, Some(label))
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
        assert_eq!(label.as_deref(), Some("Open PR"));
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
    }

    #[tokio::test]
    async fn compute_status_or_empty_returns_empty_when_path_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let snap = compute_status_or_empty(&missing, 1, "main").await.unwrap();
        assert_eq!(snap.current_branch, "");
        assert_eq!(snap.uncommitted_count, 0);
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
        assert_eq!(snap.action_label.as_deref(), Some("Open PR"));
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
