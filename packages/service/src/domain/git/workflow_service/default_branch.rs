//! Default-branch resolution for destructive safety checks.
//!
//! GitHub stores a default branch server-side, but Git exposes the same
//! practical signal through the remote `HEAD` symbolic ref. We resolve that
//! local cache first, then fall back to common local branch names for offline
//! and local-only repositories.

use std::path::Path;

use crate::domain::git::commands;
use crate::domain::git::refs::normalize_branch_identity;
use crate::error::AppError;

use super::{local_branch_exists, remote_branch_exists};

/// Resolve the protected default branch as a local branch identity.
///
/// `origin/HEAD` usually points at `refs/remotes/origin/main`; callers compare
/// deletion candidates against the normalized short name (`main`) so a local
/// branch cannot be deleted just because the default was discovered remotely.
pub async fn resolve_default_branch(repo: &Path) -> Result<String, AppError> {
    if !crate::shared::git_context::has_git_metadata(repo).await? {
        return Ok("main".to_string());
    }
    resolve_default_branch_verified(repo).await
}

/// Like [`resolve_default_branch`], for callers that already verified Git
/// metadata (e.g. via `require_git_metadata`).
pub(crate) async fn resolve_default_branch_verified(repo: &Path) -> Result<String, AppError> {
    if let Some(branch) = resolve_origin_head(repo).await? {
        return Ok(branch);
    }

    for candidate in &["origin/main", "origin/master"] {
        if remote_branch_exists(repo, candidate).await? {
            return Ok(normalize_branch_identity(candidate).to_string());
        }
    }

    for candidate in &["main", "master"] {
        if local_branch_exists(repo, candidate).await? {
            return Ok((*candidate).to_string());
        }
    }

    Ok("main".to_string())
}

/// Return true when two branch labels identify the same local branch.
pub fn same_branch_identity(left: &str, right: &str) -> bool {
    normalize_branch_identity(left) == normalize_branch_identity(right)
}

/// The branch `origin/HEAD` points at, or `None` when the repository has no
/// such symbolic ref (no `origin`, or a clone that never recorded it).
async fn resolve_origin_head(repo: &Path) -> Result<Option<String>, AppError> {
    let remote_head = commands::origin_head(repo).await?;
    Ok(remote_head
        .map(|head| normalize_branch_identity(&head).to_string())
        .filter(|branch| !branch.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_default_branch_refs_to_local_identity() {
        assert_eq!(normalize_branch_identity("refs/heads/main"), "main");
        assert_eq!(
            normalize_branch_identity("refs/remotes/origin/main"),
            "main"
        );
        assert_eq!(normalize_branch_identity("origin/main"), "main");
        assert_eq!(normalize_branch_identity("feature/a"), "feature/a");
    }

    #[test]
    fn matches_remote_and_local_default_branch_labels() {
        assert!(same_branch_identity("origin/main", "main"));
        assert!(same_branch_identity(
            "refs/remotes/origin/main",
            "refs/heads/main"
        ));
        assert!(!same_branch_identity("origin/main", "feature/main"));
    }
}
