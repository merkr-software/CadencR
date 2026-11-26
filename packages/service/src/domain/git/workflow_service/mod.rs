//! Service layer for the Git workflow overhaul endpoints.
//!
//! Split into sub-modules to stay under the 400-line cap:
//!
//! - [`branches`]: `GET /api/git/branches` and the worktree-attachment join.
//! - [`status`]: `GET /api/git/status`, `GET /api/git/compare-url`, plus the
//!   shared `enrich_snapshot` helper used by the file-watcher.
//! - [`target_branch`]: `PATCH /api/features/{id}/target-branch` and the
//!   `resolve_target_branch` fallback chain (also called by the watcher).
//! - [`commit_push`]: `POST /api/git/commit`, `GET /api/git/uncommitted-files`.
//! - [`push`]: `POST /api/git/push`, `POST /api/git/push-input` —
//!   PTY-streamed push with passphrase / yes-no prompt forwarding.
//! - [`merge`]: `POST /api/git/merge` — merge the feature branch into the
//!   configured local target branch with user-selected merge options.
//!
//! The public surface is preserved by re-exports; callers continue to use
//! `workflow_service::list_branches(...)`, `workflow_service::commit(...)`, etc.

mod branches;
pub mod checkout;
mod commit_push;
mod default_branch;
pub mod index;
mod merge;
mod merge_runner;
mod push;
mod status;
mod streaming;
mod target_branch;
mod update_branch;

pub use branches::list_branches;
pub(crate) use checkout::resolve_ref as resolve_checkout_ref;
pub use commit_push::{commit, get_uncommitted_files};
pub(crate) use default_branch::resolve_default_branch_verified;
pub use default_branch::{resolve_default_branch, same_branch_identity};
pub use merge::{merge_feature_branch, MergeFeatureBranchBody};
pub use push::{push, push_input};
pub(crate) use status::compute_feature_status;
pub use status::{enrich_snapshot, get_compare_url, get_git_status};
pub(crate) use target_branch::{branch_exists, resolve_target_branch_with_head};
pub use target_branch::{resolve_target_branch, update_target_branch};
pub(crate) use update_branch::resolve_configured_update_target;
pub use update_branch::{
    abort_update_branch, continue_update_branch, detect_active_git_operation, update_branch,
};

use std::path::{Component, Path};

use crate::app_state::AppState;
use crate::domain::git::mutation_guard::GitMutationGuardError;
use crate::error::AppError;
use crate::shared::git_cli::ref_exists_exactly;

#[track_caller]
pub(crate) fn mutation_guard_error(error: GitMutationGuardError) -> AppError {
    let message = error.to_string();
    match error {
        GitMutationGuardError::Busy { .. } => AppError::Conflict(message),
        GitMutationGuardError::InvalidWorktree { .. } => AppError::BadRequest(message),
        GitMutationGuardError::RegistryUnavailable => AppError::internal(message),
    }
}

pub(crate) fn validate_file_mutation_path(file_path: &str) -> Result<(), crate::error::AppError> {
    if file_path.is_empty() {
        return Err(crate::error::AppError::BadRequest(
            "file path must not be empty".into(),
        ));
    }
    if file_path.contains('\0')
        || file_path.ends_with(std::path::MAIN_SEPARATOR)
        || file_path
            .split(std::path::MAIN_SEPARATOR)
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        || Path::new(file_path).is_absolute()
        || Path::new(file_path)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(crate::error::AppError::BadRequest(format!(
            "refusing unsafe file path: {file_path:?}"
        )));
    }
    Ok(())
}

/// True when `refs/heads/<branch>` exists in `repo`, under exactly that name
/// (see [`ref_exists_exactly`]). Shared by the merge
/// and checkout flows so the predicate stays in one place. A repository Git
/// cannot read is an error, not a missing branch.
pub(crate) async fn local_branch_exists(repo: &Path, branch: &str) -> Result<bool, AppError> {
    ref_exists(repo, &format!("refs/heads/{branch}")).await
}

/// True when `refs/remotes/<branch>` resolves in `repo` (e.g. `origin/main`).
pub(crate) async fn remote_branch_exists(repo: &Path, branch: &str) -> Result<bool, AppError> {
    ref_exists(repo, &format!("refs/remotes/{branch}")).await
}

async fn ref_exists(repo: &Path, refname: &str) -> Result<bool, AppError> {
    ref_exists_exactly(refname, repo).await
}

/// Best-effort recompute + WS broadcast after a successful write. Errors are
/// logged and swallowed — the HTTP response already reported success and the
/// next fs event (or the next subscriber) will refresh the snapshot anyway.
pub(crate) async fn broadcast_after_write(state: &AppState, feature_id: i64) {
    if let Err(e) = crate::domain::git::watcher::recompute_and_broadcast(state, feature_id).await {
        tracing::warn!(
            feature_id,
            error = %e,
            "git status recompute after write failed (best-effort)"
        );
    }
}

/// Confirm the post-mutation refresh against the already-resolved worktree.
/// A failed recompute is delivered as the existing `git.status_error` WS
/// envelope, so the successful Git mutation is never turned into a retryable
/// HTTP failure and the frontend never fails stale without a visible warning.
pub(crate) async fn broadcast_after_write_at(state: &AppState, worktree_path: &Path) {
    state
        .git_watcher
        .confirm_after_write(worktree_path, state)
        .await;
}

#[cfg(test)]
mod path_tests {
    use super::validate_file_mutation_path;

    #[test]
    fn file_paths_preserve_literals_but_reject_revision_and_traversal_syntax() {
        assert!(validate_file_mutation_path("src/literal[conflict] -> file.rs").is_ok());
        for unsafe_path in [
            "",
            "../outside",
            "/absolute",
            "src//file.rs",
            "src/./file.rs",
        ] {
            assert!(
                validate_file_mutation_path(unsafe_path).is_err(),
                "{unsafe_path:?}"
            );
        }
    }
}

#[cfg(test)]
mod branch_exists_tests {
    use super::*;

    /// A missing branch is `false`; a directory Git cannot read is an error,
    /// where both used to read as "no such branch".
    #[tokio::test]
    async fn branch_probes_tell_a_missing_branch_from_a_failure() {
        let repo = tempfile::tempdir().unwrap();
        crate::shared::git_cli::run_git(&["init", "-q"], repo.path())
            .await
            .unwrap();
        assert!(!local_branch_exists(repo.path(), "main").await.unwrap());
        assert!(!remote_branch_exists(repo.path(), "origin/main")
            .await
            .unwrap());

        let not_repo = tempfile::tempdir().unwrap();
        assert!(local_branch_exists(not_repo.path(), "main").await.is_err());
        assert!(remote_branch_exists(not_repo.path(), "origin/main")
            .await
            .is_err());
    }

    /// Branch names compare exactly, loose or packed: on a case-insensitive
    /// filesystem a loose `feature/abc` used to answer for `Feature/ABC`.
    /// Prefixes and parent directories of a branch are not branches either.
    #[tokio::test]
    async fn branch_probes_compare_names_exactly_loose_or_packed() {
        let repo = tempfile::tempdir().unwrap();
        let run = |args: &'static [&'static str]| {
            let path = repo.path().to_path_buf();
            async move { crate::shared::git_cli::run_git(args, &path).await.unwrap() }
        };
        run(&["init", "-q", "-b", "main"]).await;
        run(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "i",
        ])
        .await;
        run(&["branch", "feature/abc"]).await;
        run(&["update-ref", "refs/remotes/origin/feature/abc", "HEAD"]).await;

        for packed in [false, true] {
            if packed {
                run(&["pack-refs", "--all"]).await;
            }
            assert!(local_branch_exists(repo.path(), "feature/abc")
                .await
                .unwrap());
            for other in [
                "Feature/ABC",
                "feature/ABC",
                "FEATURE/abc",
                "feature",
                "feature/ab",
            ] {
                assert!(
                    !local_branch_exists(repo.path(), other).await.unwrap(),
                    "{other:?} (packed: {packed})"
                );
            }
            assert!(remote_branch_exists(repo.path(), "origin/feature/abc")
                .await
                .unwrap());
            assert!(!remote_branch_exists(repo.path(), "origin/Feature/ABC")
                .await
                .unwrap());
        }
    }
}
