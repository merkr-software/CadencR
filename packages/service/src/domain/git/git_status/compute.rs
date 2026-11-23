use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::{git_ref_resolves_background, run_git_background};

use super::parsing::ParsedPorcelain;
use super::worktree_base::{probe_worktree, read_porcelain, GitWorktreeBase, WorktreeStatusBase};
use super::{GitStatusSnapshot, SharedFeatureRef};
use crate::domain::git::host::{self, GitHost, RemoteInfo};
use crate::domain::git::workflow_service::resolve_configured_update_target;

#[derive(Clone, Debug)]
pub(crate) struct ResolvedTargetMetrics {
    target_divergence: TargetDivergence,
    update_target: String,
    update_divergence: TargetDivergence,
}

/// Resolve divergence metrics once per distinct target / update-target ref.
pub(crate) async fn resolve_targets_for_base(
    repo: &Path,
    base: &WorktreeStatusBase,
    distinct_targets: &[String],
) -> HashMap<String, Result<ResolvedTargetMetrics, AppError>> {
    let WorktreeStatusBase::Git(git) = base else {
        return HashMap::new();
    };
    resolve_targets(repo, &git.parsed, distinct_targets).await
}

async fn resolve_targets(
    repo: &Path,
    parsed: &ParsedPorcelain,
    distinct_targets: &[String],
) -> HashMap<String, Result<ResolvedTargetMetrics, AppError>> {
    let current_ref = format!("refs/heads/{}", parsed.current_branch);
    let (update_targets, target_divs) = tokio::join!(
        futures::future::join_all(distinct_targets.iter().map(|target| {
            let current_ref = &current_ref;
            async move {
                let update_target = resolve_update_target_for(repo, parsed, current_ref, target);
                (target.clone(), update_target.await)
            }
        })),
        futures::future::join_all(
            distinct_targets
                .iter()
                .filter(|target| upstream_divergence(parsed, target).is_none())
                .map(|target| async move {
                    (
                        target.clone(),
                        resolve_target_divergence(repo, target).await,
                    )
                })
        ),
    );

    let mut divergences: HashMap<String, Result<TargetDivergence, AppError>> =
        target_divs.into_iter().collect();

    let extra_refs: HashSet<String> = update_targets
        .iter()
        .filter_map(|(_, update_result)| update_result.as_ref().ok())
        .filter(|target| {
            upstream_divergence(parsed, target).is_none()
                && !divergences.contains_key(target.as_str())
        })
        .cloned()
        .collect();
    if !extra_refs.is_empty() {
        divergences.extend(
            futures::future::join_all(extra_refs.into_iter().map(|ref_name| async move {
                let result = resolve_target_divergence(repo, &ref_name).await;
                (ref_name, result)
            }))
            .await,
        );
    }

    update_targets
        .into_iter()
        .map(|(target, update_result)| {
            let entry = assemble_target_metrics(parsed, &target, update_result, &divergences);
            (target, entry)
        })
        .collect()
}

fn assemble_target_metrics(
    parsed: &ParsedPorcelain,
    target: &str,
    update_result: Result<String, AppError>,
    divergences: &HashMap<String, Result<TargetDivergence, AppError>>,
) -> Result<ResolvedTargetMetrics, AppError> {
    let update_target = update_result?;
    let target_divergence = upstream_divergence(parsed, target)
        .map_or_else(|| lookup_divergence(divergences, target), Ok)?;
    let update_divergence =
        shortcut_update_divergence(parsed, target, &update_target, target_divergence)
            .map_or_else(|| lookup_divergence(divergences, &update_target), Ok)?;
    Ok(ResolvedTargetMetrics {
        target_divergence,
        update_target,
        update_divergence,
    })
}

/// A shared ref's divergence for one feature; its failure keeps its own
/// variant (a rejected ref stays a 4xx, a git failure a masked 500).
fn lookup_divergence(
    divergences: &HashMap<String, Result<TargetDivergence, AppError>>,
    ref_name: &str,
) -> Result<TargetDivergence, AppError> {
    match divergences.get(ref_name) {
        Some(result) => result.clone(),
        None => Err(AppError::internal(format!(
            "missing divergence for ref {ref_name}"
        ))),
    }
}

async fn resolve_update_target_for(
    repo: &Path,
    parsed: &ParsedPorcelain,
    current_ref: &str,
    target_branch: &str,
) -> Result<String, AppError> {
    if parsed.behind > 0 {
        if let Some(upstream) = parsed.tracked_upstream() {
            return Ok(upstream.to_string());
        }
    }
    resolve_configured_update_target(repo, current_ref, target_branch).await
}

/// Assemble a per-feature [`GitStatusSnapshot`] from a shared worktree base
/// and its resolved target metrics. Pure CPU, no Git spawns.
pub(crate) fn build_snapshot(
    base: &WorktreeStatusBase,
    feature_id: i64,
    target_branch: &str,
    metrics: Option<&ResolvedTargetMetrics>,
) -> GitStatusSnapshot {
    match (base, metrics) {
        (WorktreeStatusBase::Git(git), Some(m)) => {
            assemble_snapshot(feature_id, target_branch, git, m)
        }
        _ => empty_snapshot(feature_id, target_branch),
    }
}

fn assemble_snapshot(
    feature_id: i64,
    target_branch: &str,
    git: &GitWorktreeBase,
    metrics: &ResolvedTargetMetrics,
) -> GitStatusSnapshot {
    let (parsed, probes) = (&git.parsed, &git.probes);
    let (host, compare_url, action_label) = derive_provider_fields(
        probes.remote_info.as_ref(),
        target_branch,
        &parsed.current_branch,
    );
    GitStatusSnapshot {
        current_branch: parsed.current_branch.clone(),
        uncommitted_count: parsed.staged_count + parsed.unstaged_count + parsed.untracked_count,
        staged_count: parsed.staged_count,
        unstaged_count: parsed.unstaged_count,
        untracked_count: parsed.untracked_count,
        ahead_of_remote: probes.ahead_of_remote,
        behind_remote: parsed.behind,
        ahead_of_target: metrics.target_divergence.ahead,
        behind_target: metrics.target_divergence.behind,
        target_resolved: metrics.target_divergence.resolved,
        update_target_branch: Some(metrics.update_target.clone()),
        ahead_of_update_target: metrics.update_divergence.ahead,
        behind_update_target: metrics.update_divergence.behind,
        update_target_resolved: metrics.update_divergence.resolved,
        conflict_count: parsed.conflict_count,
        operation: probes.operation,
        has_remote: probes.remote_info.is_some(),
        host,
        compare_url,
        action_label,
        ..empty_snapshot(feature_id, target_branch)
    }
}

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
        thread_branches: Vec::new(),
        computed_at: chrono::Utc::now().timestamp_millis(),
    }
}

/// Same contract as `compute_status` but degrades to `empty_snapshot` instead
/// of bubbling a `GIT_COMMAND_ERROR` when `repo` is missing or has no Git
/// metadata. Use this from request handlers and the watcher subscribe path so
/// a stale `worktree_path` setting doesn't spam the error log on every poll.
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
/// it. Caller decides whether to surface stale data. Same probes as the
/// watcher's shared base plus one target, run concurrently.
async fn compute_status(
    repo: &Path,
    feature_id: i64,
    target_branch: &str,
) -> Result<GitStatusSnapshot, AppError> {
    let parsed = read_porcelain(repo).await?;
    let targets = [target_branch.to_string()];
    let (mut metrics, probes) = tokio::join!(
        resolve_targets(repo, &parsed, &targets),
        probe_worktree(repo, &parsed),
    );
    let metrics = metrics.remove(target_branch).unwrap_or_else(|| {
        Err(AppError::internal(format!(
            "missing metrics for target {target_branch}"
        )))
    })?;
    let git = GitWorktreeBase {
        parsed,
        probes: probes?,
    };
    Ok(assemble_snapshot(feature_id, target_branch, &git, &metrics))
}

/// The divergence `branch.ab` already reports when `ref_name` is the tracked
/// upstream; `None` otherwise, including for a `[gone]` upstream, which Git
/// can no longer count against.
fn upstream_divergence(parsed: &ParsedPorcelain, ref_name: &str) -> Option<TargetDivergence> {
    (parsed.tracked_upstream() == Some(ref_name)).then_some(TargetDivergence {
        ahead: parsed.ahead,
        behind: parsed.behind,
        resolved: true,
    })
}

fn shortcut_update_divergence(
    parsed: &ParsedPorcelain,
    target: &str,
    update_target: &str,
    target_divergence: TargetDivergence,
) -> Option<TargetDivergence> {
    upstream_divergence(parsed, update_target)
        .or_else(|| (update_target == target).then_some(target_divergence))
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
    if !git_ref_resolves_background(&format!("{target_branch}^{{commit}}"), repo).await? {
        return Ok(TargetDivergence::default());
    }
    let range = format!("HEAD...{target_branch}");
    let counts =
        run_git_background(&["rev-list", "--left-right", "--count", &range, "--"], repo).await?;
    let unexpected = || {
        AppError::git_command(format!(
            "git rev-list --left-right --count printed {counts:?}"
        ))
    };
    let mut parts = counts.split_whitespace().map(str::parse::<u32>);
    let (Some(Ok(ahead)), Some(Ok(behind))) = (parts.next(), parts.next()) else {
        return Err(unexpected());
    };
    Ok(TargetDivergence {
        ahead,
        behind,
        resolved: true,
    })
}

/// Bundle the provider-derived fields. `compare_url` is `None` when:
///   * there's no remote at all, OR
///   * the remote's host is `Other` (`host::compare_url` refuses to guess).
///
/// `action_label` is set whenever we have *any* remote so the frontend has a
/// label to render even when the action itself is disabled.
fn derive_provider_fields(
    info: Option<&RemoteInfo>,
    target: &str,
    head: &str,
) -> (Option<GitHost>, Option<String>, Option<String>) {
    info.map_or((None, None, None), |info| {
        (
            Some(info.host),
            host::compare_url(info, target, head),
            Some(host::pr_label(&info.host).to_string()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_git::{init_repo, repo_with_gone_upstream, run_git};
    use super::super::DETACHED_HEAD;
    use super::*;

    #[test]
    fn a_detached_head_has_no_checked_out_branch() {
        let mut snapshot = empty_snapshot(1, "main");
        snapshot.current_branch = DETACHED_HEAD.to_string();
        assert_eq!(snapshot.checked_out_branch(), None);
        snapshot.current_branch = "feature/a".to_string();
        assert_eq!(snapshot.checked_out_branch().as_deref(), Some("feature/a"));
    }

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

    #[test]
    fn a_shared_divergence_failure_keeps_its_variant() {
        let divergences = HashMap::from([(
            "-bad".to_string(),
            Err(AppError::BadRequest("refused positional".into())),
        )]);
        assert!(matches!(
            lookup_divergence(&divergences, "-bad"),
            Err(AppError::BadRequest(message)) if message == "refused positional"
        ));
    }

    /// Comparing against an upstream whose remote branch was deleted is
    /// "not resolved", not "in sync".
    #[tokio::test]
    async fn a_gone_upstream_target_is_unresolved_rather_than_zero_divergence() {
        let root = tempfile::tempdir().unwrap();
        let repo = repo_with_gone_upstream(root.path());

        let snap = compute_status(&repo, 1, "origin/feat").await.unwrap();

        assert!(!snap.target_resolved, "{snap:?}");
    }
}
