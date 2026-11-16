//! Worktree registration and filesystem-health checks.
//!
//! A feature's recorded `worktree_path` is the *session cwd*: the worktree
//! root for a project registered at a repository root, but
//! `<worktree root>/<subpath>` for a project registered in a monorepo
//! subdirectory (see `worktree_context::build_worktree_context`). Liveness
//! therefore compares against each registered root joined with the project's
//! subpath, never against the bare roots.

use std::path::{Path, PathBuf};

use crate::domain::git::models::WorktreeInfo;
use crate::error::AppError;

use super::worktree_ops::list_worktrees;

/// Registered worktree whose root equals `worktree_root` exactly. For removal
/// and other root-level operations; feature paths go through
/// [`registered_worktree_for_feature_path`].
pub async fn get_worktree_info(
    repo_path: &Path,
    worktree_root: &Path,
) -> Result<Option<WorktreeInfo>, AppError> {
    let roots = WorktreeRoots::new(list_worktrees(repo_path).await?);
    Ok(roots.find_copy(worktree_root, Path::new("")).cloned())
}

/// Registered worktree whose copy of `project_path` is `recorded_path`.
pub async fn registered_worktree_for_feature_path(
    project_path: &Path,
    recorded_path: &Path,
) -> Result<Option<WorktreeInfo>, AppError> {
    let roots = WorktreeRoots::new(list_worktrees(project_path).await?);
    let subpath = roots.project_subpath(project_path);
    Ok(roots.find_copy(recorded_path, &subpath).cloned())
}

/// Whether `recorded_path` is an existing directory inside a worktree
/// registered by the repository owning `project_path`. Filesystem presence
/// alone is insufficient because Git can detach worktree metadata before a
/// watcher-created residual directory is removed.
pub async fn is_live_worktree(project_path: &Path, recorded_path: &Path) -> Result<bool, AppError> {
    Ok(live_worktree_root(project_path, recorded_path)
        .await?
        .is_some())
}

/// Root of the live worktree holding `recorded_path`, or `None` when the
/// directory is gone or no longer registered.
pub async fn live_worktree_root(
    project_path: &Path,
    recorded_path: &Path,
) -> Result<Option<PathBuf>, AppError> {
    match tokio::fs::metadata(recorded_path).await {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AppError::internal(format!(
                "Failed to inspect worktree path: {error}"
            )))
        }
    }
    Ok(
        registered_worktree_for_feature_path(project_path, recorded_path)
            .await?
            .map(|worktree| PathBuf::from(worktree.path)),
    )
}

/// Registered worktrees with their roots canonicalized once, for matching
/// any number of paths against them.
pub struct WorktreeRoots {
    entries: Vec<(WorktreeInfo, PathBuf)>,
}

impl WorktreeRoots {
    pub fn new(worktrees: Vec<WorktreeInfo>) -> Self {
        let entries = worktrees
            .into_iter()
            .map(|worktree| {
                let root = canonical_dir(Path::new(&worktree.path));
                (worktree, root)
            })
            .collect();
        Self { entries }
    }

    /// `project_path` relative to the registered worktree that contains it
    /// (the deepest one, so a project inside a linked worktree resolves
    /// against that worktree). Empty for a project registered at a
    /// repository root, and when no registered worktree contains it.
    pub fn project_subpath(&self, project_path: &Path) -> PathBuf {
        let project = canonical_dir(project_path);
        self.entries
            .iter()
            .filter(|(worktree, _)| !worktree.is_bare)
            .filter_map(|(_, root)| project.strip_prefix(root).ok().map(Path::to_path_buf))
            .min_by_key(|subpath| subpath.components().count())
            .unwrap_or_default()
    }

    /// The worktree whose root joined with `subpath` is `path`.
    pub fn find_copy(&self, path: &Path, subpath: &Path) -> Option<&WorktreeInfo> {
        let path = canonical_dir(path);
        self.entries
            .iter()
            .find(|(_, root)| root.join(subpath) == path)
            .map(|(worktree, _)| worktree)
    }
}

/// Canonical spelling of a directory for equality checks (resolves symlinks;
/// `Path` equality already ignores a trailing separator), falling back to the
/// path as given when it does not exist.
pub fn canonical_dir(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn init_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        for args in [
            &["init"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
        ] {
            crate::shared::git_cli::run_git(args, path).await.unwrap();
        }
        std::fs::write(path.join("README.md"), "test").unwrap();
        crate::shared::git_cli::run_git(&["add", "README.md"], path)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(&["commit", "-m", "init"], path)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn liveness_requires_registration_with_the_owning_repository() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let worktree = root.path().join("worktree");
        let unrelated = root.path().join("unrelated");
        init_repo(&repo).await;
        init_repo(&unrelated).await;
        crate::shared::git_cli::run_git(
            &[
                "worktree",
                "add",
                "-b",
                "feature/test",
                worktree.to_str().unwrap(),
            ],
            &repo,
        )
        .await
        .unwrap();

        assert!(is_live_worktree(&repo, &worktree).await.unwrap());
        assert!(!is_live_worktree(&repo, &unrelated).await.unwrap());
        assert!(!is_live_worktree(&repo, &root.path().join("missing"))
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn liveness_accepts_a_monorepo_subdirectory_project() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        init_repo(&repo).await;
        let project = repo.join("packages/app");
        std::fs::create_dir_all(&project).unwrap();
        let worktree = root.path().join("worktree");
        crate::shared::git_cli::run_git(
            &[
                "worktree",
                "add",
                "-b",
                "feature/sub",
                worktree.to_str().unwrap(),
            ],
            &repo,
        )
        .await
        .unwrap();
        let session_cwd = worktree.join("packages/app");
        std::fs::create_dir_all(&session_cwd).unwrap();

        assert!(is_live_worktree(&project, &session_cwd).await.unwrap());
        let live_root = live_worktree_root(&project, &session_cwd)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(canonical_dir(&live_root), canonical_dir(&worktree));
        // The worktree root itself is not the project's copy.
        assert!(!is_live_worktree(&project, &worktree).await.unwrap());
        // A residual directory under the main checkout is not a live worktree.
        let residual = repo.join("other/packages/app");
        std::fs::create_dir_all(&residual).unwrap();
        assert!(!is_live_worktree(&project, &residual).await.unwrap());
        // The project directory itself is the main worktree's copy.
        assert!(is_live_worktree(&project, &project).await.unwrap());
    }

    #[test]
    fn project_subpath_uses_the_deepest_containing_worktree() {
        let info = |path: &str| WorktreeInfo {
            path: path.into(),
            branch: "main".into(),
            head: String::new(),
            is_bare: false,
        };
        let roots = WorktreeRoots::new(vec![info("/repo"), info("/repo/.worktrees/x")]);
        assert_eq!(
            roots.project_subpath(Path::new("/repo/.worktrees/x/pkg")),
            PathBuf::from("pkg")
        );
        assert_eq!(
            roots.project_subpath(Path::new("/repo/packages/app")),
            PathBuf::from("packages/app")
        );
        assert_eq!(roots.project_subpath(Path::new("/repo")), PathBuf::new());
        assert_eq!(
            roots.project_subpath(Path::new("/elsewhere")),
            PathBuf::new()
        );
    }
}
