//! Cheap context guard for optional Git observations, not repository validation.

use std::path::Path;

use crate::error::AppError;

/// Plain folders need no Git subprocess at all. Discover metadata in canonical
/// ancestors so subdirectories, symlinks and linked worktrees (`.git` files)
/// work too. Existing but broken metadata is deliberately NOT treated as absent:
/// the subsequent Git operation must still surface corruption/ownership errors.
pub async fn has_git_metadata(path: &Path) -> Result<bool, AppError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || inspect_git_metadata(&path))
        .await
        .map_err(|error| AppError::internal(format!("Git context inspection failed: {error}")))?
}

/// Safety checks must reject unavailable repositories, never infer a clean or absent branch.
pub async fn require_git_metadata(path: &Path) -> Result<(), AppError> {
    if has_git_metadata(path).await? {
        Ok(())
    } else {
        Err(AppError::git_command(format!(
            "No Git metadata found for {}",
            path.display()
        )))
    }
}

fn inspect_git_metadata(path: &Path) -> Result<bool, AppError> {
    let canonical = match std::fs::canonicalize(path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(context_error(error)),
    };
    for ancestor in canonical.ancestors() {
        if metadata_exists(&ancestor.join(".git"))? {
            return Ok(true);
        }
        // Bare repositories still have Git metadata; do not hide their real
        // "operation must be run in a work tree" errors as an ordinary folder.
        if metadata_exists(&ancestor.join("HEAD"))?
            && metadata_exists(&ancestor.join("objects"))?
            && metadata_exists(&ancestor.join("refs"))?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn metadata_exists(path: &Path) -> Result<bool, AppError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(context_error(error)),
    }
}

#[track_caller]
fn context_error(error: std::io::Error) -> AppError {
    AppError::internal(format!("Failed to inspect Git context: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn plain_and_missing_directories_have_no_git_metadata() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!has_git_metadata(dir.path()).await.unwrap());
        assert!(!has_git_metadata(&dir.path().join("missing")).await.unwrap());
    }

    #[tokio::test]
    async fn metadata_is_discovered_in_parents_without_validating_it() {
        let dir = tempfile::tempdir().unwrap();
        let child = dir.path().join("src/nested");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(dir.path().join(".git"), "gitdir: missing-metadata").unwrap();
        assert!(has_git_metadata(&child).await.unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_subdirectories_use_the_real_ancestors() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(repo.join("src"), &link).unwrap();
        assert!(has_git_metadata(&link).await.unwrap());
    }
}
