//! Registration and filesystem checks for an explicitly assigned linked checkout.

use std::path::{Path, PathBuf};

use axum::http::StatusCode;

use crate::domain::git::commands;
use crate::error::AppError;

pub(crate) const WORKTREE_UNAVAILABLE: &str = "WORKTREE_UNAVAILABLE";

pub(crate) fn worktree_unavailable() -> AppError {
    AppError::coded(
        StatusCode::CONFLICT,
        WORKTREE_UNAVAILABLE,
        "The feature's worktree is no longer available",
    )
}

/// Check that the linked Git directory names this worktree in return. A stale
/// registration remains listed even if its marker is removed or redirected.
pub(crate) async fn require_linked_checkout(cwd: &Path, root: &Path) -> Result<PathBuf, AppError> {
    let git_file = root.join(".git");
    let (directory, marker) = tokio::try_join!(worktree_metadata(root), worktree_link(&git_file))?;
    if directory.is_some_and(|metadata| metadata.is_dir()) {
        let git_dir = owned_git_dir(root, &git_file, marker.as_deref())
            .await?
            .ok_or_else(worktree_unavailable)?;
        if cwd == root {
            return Ok(git_dir);
        }
        // The selected project can be a subdirectory of a monorepo.
        let (cwd, root) = tokio::try_join!(linked_path(cwd), linked_path(root))?;
        if cwd
            .zip(root)
            .is_some_and(|(cwd, root)| cwd.starts_with(root))
        {
            return Ok(git_dir);
        }
    }
    Err(worktree_unavailable())
}

async fn owned_git_dir(
    root: &Path,
    marker: &Path,
    contents: Option<&str>,
) -> Result<Option<PathBuf>, AppError> {
    let Some(location) = contents.and_then(|value| value.strip_prefix("gitdir: ")) else {
        return Ok(None);
    };
    let git_dir = root.join(location);
    let owner = worktree_link(&git_dir.join("gitdir")).await?;
    match owner {
        Some(owner) if same_directory_spelling(&git_dir.join(&owner), marker).await => {
            linked_path(&git_dir).await
        }
        _ => Ok(None),
    }
}

async fn worktree_link(path: &Path) -> Result<Option<String>, AppError> {
    match tokio::fs::read_to_string(path).await {
        Ok(link) => Ok(Some(link.trim_end_matches(['\n', '\r']).to_owned())),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound
                    | std::io::ErrorKind::NotADirectory
                    | std::io::ErrorKind::IsADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(AppError::internal(format!(
            "Failed to read the feature's worktree link: {error}"
        ))),
    }
}
async fn worktree_metadata(path: &Path) -> Result<Option<std::fs::Metadata>, AppError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(AppError::internal(format!(
            "Failed to inspect the feature's worktree: {error}"
        ))),
    }
}

pub(super) async fn linked_path(path: &Path) -> Result<Option<PathBuf>, AppError> {
    match tokio::fs::canonicalize(path).await {
        Ok(path) => Ok(Some(path)),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(AppError::internal(format!(
            "Failed to resolve the feature's worktree: {error}"
        ))),
    }
}

pub(crate) fn is_worktree_unavailable(error: &AppError) -> bool {
    matches!(
        error,
        AppError::Coded {
            code: WORKTREE_UNAVAILABLE,
            ..
        }
    )
}

pub(super) async fn registered_linked_root(
    project: &Path,
    recorded: &Path,
    actual: &Path,
) -> Result<Option<PathBuf>, AppError> {
    let Some(project) = linked_path(project).await? else {
        return Ok(None);
    };
    if project == actual || !crate::shared::git_context::has_git_metadata(&project).await? {
        return Ok(None);
    }
    let entries = commands::list_worktrees(&project).await?;
    let roots = tokio::task::spawn_blocking(move || commands::WorktreeRoots::new(entries))
        .await
        .map_err(|error| {
            AppError::internal(format!("Failed to inspect registered worktrees: {error}"))
        })?;
    let subpath = roots.project_subpath_canonical(&project);
    let Some(entry) = roots.find_copy_canonical(actual, &subpath) else {
        return Ok(None);
    };
    let root = PathBuf::from(&entry.path);
    // Match the recorded root by name and allow spelling aliases in its
    // parent (for example /var on macOS). Never follow a redirected root.
    let Some(recorded_root) = recorded.ancestors().nth(subpath.components().count()) else {
        return Ok(None);
    };
    if !same_directory_spelling(&root, recorded_root).await {
        return Ok(None);
    }
    Ok(Some(root))
}

pub(super) async fn same_directory_spelling(first: &Path, second: &Path) -> bool {
    if first == second {
        return true;
    }
    if first.file_name() != second.file_name() {
        return false;
    }
    let Some((a, b)) = first.parent().zip(second.parent()) else {
        return false;
    };
    let (a, b) = tokio::join!(tokio::fs::canonicalize(a), tokio::fs::canonicalize(b));
    matches!((a, b), (Ok(a), Ok(b)) if a == b)
}
