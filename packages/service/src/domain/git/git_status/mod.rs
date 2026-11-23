//! Snapshot computation for the live Git status view.
//!
//! `compute_status` issues a small, fixed set of `git` calls and returns a
//! `GitStatusSnapshot` shaped for the frontend. The snapshot is provider-
//! neutral: provider-specific fields (`host`, `compare_url`, `action_label`)
//! come from `super::host` so this module never branches on host identity
//! itself.
//!
//! Pure parsing of `git status --porcelain=v2` lives in [`parsing`] so the
//! per-line decoder can be unit-tested without spawning git.

mod compute;
mod parsing;
mod worktree_base;

/// Git fixtures shared by this module's tests.
#[cfg(test)]
mod test_git {
    use std::path::{Path, PathBuf};

    pub(super) fn run_git(dir: &Path, args: &[&str]) {
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

    /// A repository on `main` with one commit.
    pub(super) fn init_repo(dir: &Path) {
        run_git(dir, &["init", "-q", "-b", "main"]);
        run_git(dir, &["config", "user.email", "t@t"]);
        run_git(dir, &["config", "user.name", "Test"]);
        run_git(dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        run_git(dir, &["add", "seed.txt"]);
        run_git(dir, &["commit", "-q", "-m", "seed"]);
    }

    /// A repository under `root` on `feat`, whose upstream `origin/feat` was
    /// pushed and then deleted: Git keeps the `branch.upstream` header but
    /// drops `branch.ab`. Nothing of `feat` (2 commits) is on a remote.
    pub(super) fn repo_with_gone_upstream(root: &Path) -> PathBuf {
        let (repo, remote) = (root.join("repo"), root.join("remote.git"));
        std::fs::create_dir(&repo).unwrap();
        run_git(root, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        init_repo(&repo);
        for args in [
            &["remote", "add", "origin", remote.to_str().unwrap()][..],
            &["checkout", "-q", "-b", "feat"],
            &["push", "-q", "-u", "origin", "feat"],
            &["commit", "-q", "--allow-empty", "-m", "local"],
            &["push", "-q", "origin", "--delete", "feat"],
        ] {
            run_git(&repo, args);
        }
        repo
    }
}

pub use compute::compute_status_or_empty;
pub(crate) use compute::{build_snapshot, resolve_targets_for_base};
pub(crate) use worktree_base::{compute_worktree_base, WorktreeStatusBase};

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::host::GitHost;
use super::service::branch_identity;

/// What `git status` reports as the branch of a detached HEAD.
pub const DETACHED_HEAD: &str = "(detached)";
use super::linked_branches::ThreadBranch;
use super::models::GitOperationKind;

/// One-shot snapshot of the worktree's git state. Field semantics:
///
/// - `*_count` fields are derived from `git status --porcelain=v2`.
/// - `ahead_of_remote` is the count of commits reachable from `HEAD` that no
///   remote has yet — `branch.ab` ahead when an upstream is configured, or
///   `git rev-list --count --not --remotes HEAD` otherwise (which is exactly
///   what a first `git push -u origin HEAD` would publish).
/// - `behind_remote` comes from `branch.ab` and is `0` when no upstream is
///   configured (we can't be "behind" something that doesn't exist).
/// - `ahead_of_target` is `git rev-list --count {target}..HEAD` and
///   `behind_target` is `git rev-list --count HEAD..{target}`, using the
///   target ref **verbatim** as picked by the user — local `main` and
///   remote-tracking `origin/main` are different inputs and produce different
///   counts on purpose. Both are `0` if the ref doesn't resolve, while
///   `target_resolved` distinguishes that from genuine zero divergence.
/// - `update_target_branch` is the exact source the Update action will use.
///   Incoming commits on the checked-out branch's upstream win first; then an
///   incoming upstream of a configured local target wins; otherwise it is the
///   configured target verbatim. Its divergence fields are computed against
///   that resolved source without changing the configured comparison target.
/// - `host` / `compare_url` / `action_label` are populated only when a remote
///   exists. The frontend disables the open-PR button when `compare_url` is
///   `None`.
/// - `thread_branches` lists the conversation's branches; the current one
///   (first, `is_current`) can differ from `current_branch` when a
///   worktree-free conversation's branch is no longer checked out.
/// - `shared_with` lists OTHER features that point at the same worktree
///   directory (reuse-branch flow). Filled in by the caller via
///   `enrich_with_sharing` — `compute_status` itself leaves it empty.
/// - `computed_at` is unix milliseconds; the frontend store uses it to drop
///   incoming snapshots that are older than what's already cached, which
///   breaks the HTTP-vs-WebSocket race during worktree setup.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GitStatusSnapshot {
    pub feature_id: i64,
    pub current_branch: String,
    pub target_branch: String,
    pub uncommitted_count: u32,
    pub staged_count: u32,
    pub unstaged_count: u32,
    pub untracked_count: u32,
    pub ahead_of_remote: u32,
    pub behind_remote: u32,
    pub ahead_of_target: u32,
    /// Commits reachable from the configured target but not from `HEAD`.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub behind_target: u32,
    /// Whether the configured target resolved to a commit. This is distinct
    /// from a zero divergence count.
    #[serde(default, skip_serializing_if = "is_false")]
    pub target_resolved: bool,
    /// Exact ref selected as the source for Update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_target_branch: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub ahead_of_update_target: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub behind_update_target: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub update_target_resolved: bool,
    /// Number of unique unmerged paths in the current worktree.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub conflict_count: u32,
    /// Merge or rebase state retained for conflict recovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<GitOperationKind>,
    pub has_remote: bool,
    pub host: Option<GitHost>,
    pub compare_url: Option<String>,
    pub action_label: Option<String>,
    #[serde(default)]
    pub shared_with: Vec<SharedFeatureRef>,
    /// Every branch of the conversation, the current one first. Filled in
    /// by the caller via `enrich_snapshot`, like `shared_with`.
    #[serde(default)]
    pub thread_branches: Vec<ThreadBranch>,
    pub computed_at: i64,
}

impl GitStatusSnapshot {
    /// The branch checked out, or `None` for a detached HEAD.
    pub fn checked_out_branch(&self) -> Option<String> {
        if self.current_branch == DETACHED_HEAD {
            return None;
        }
        branch_identity(&self.current_branch)
    }
}

/// Lightweight pointer to another feature that shares the same worktree
/// directory. Surfaced in the header so the user knows their changes will
/// affect the donor feature's view too.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SharedFeatureRef {
    pub feature_id: i64,
    pub title: String,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !value
}
