//! Shared Cadencr worktree path construction.
//!
//! All service entry points that create Cadencr-managed git worktrees should
//! use this module so the on-disk layout stays consistent.

use std::path::{Path, PathBuf};

use crate::shared::app_paths;

/// Return the default root for Cadencr-managed worktrees. On Linux this lands
/// under `$XDG_DATA_HOME/cadencr/worktrees` (default
/// `~/.local/share/cadencr/worktrees`); on macOS it stays at
/// `~/.cadencr/worktrees`. See `app_paths` for the platform rules.
pub fn default_worktrees_root() -> Result<PathBuf, String> {
    app_paths::worktrees_dir()
}

/// Replace branch path separators with a single filesystem component.
pub fn worktree_name_for_branch(branch: &str) -> String {
    branch.replace('/', "-")
}

/// Resolve `<worktrees-root>/{project}/{safe-branch}` and return it as a
/// string. Creates the project parent directory; the leaf directory is left
/// for `git worktree add` to create.
pub async fn compute_worktree_path(project_name: &str, branch: &str) -> Result<String, String> {
    let root = default_worktrees_root()?;
    let worktree_name = worktree_name_for_branch(branch);
    let path = build_contained_worktree_path(&root, project_name, &worktree_name).await?;
    Ok(path.to_string_lossy().to_string())
}

/// Build `{root}/{project_name}/{worktree_name}` and verify the canonical
/// parent remains under the canonical root.
pub async fn build_contained_worktree_path(
    root: &Path,
    project_name: &str,
    worktree_name: &str,
) -> Result<PathBuf, String> {
    validate_project_name(project_name)?;
    validate_worktree_name(worktree_name)?;

    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| format!("Failed to create worktree root: {e}"))?;

    let parent = root.join(project_name);
    tokio::fs::create_dir_all(&parent)
        .await
        .map_err(|e| format!("Failed to create parent dir: {e}"))?;

    let canon_parent = parent
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize worktree parent dir: {e}"))?;
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize worktree root: {e}"))?;
    if !canon_parent.starts_with(&canon_root) {
        return Err(format!(
            "Resolved worktree parent escapes worktrees root: {}",
            canon_parent.display()
        ));
    }

    Ok(canon_parent.join(worktree_name))
}

fn validate_project_name(project_name: &str) -> Result<(), String> {
    if project_name.is_empty()
        || project_name == "."
        || project_name == ".."
        || project_name.contains('/')
        || project_name.contains('\\')
    {
        return Err(format!(
            "refusing to build worktree path for unsafe project name: {project_name:?}"
        ));
    }
    Ok(())
}

fn validate_worktree_name(worktree_name: &str) -> Result<(), String> {
    if worktree_name.is_empty()
        || worktree_name == "."
        || worktree_name == ".."
        || worktree_name.contains('/')
        || worktree_name.contains('\\')
    {
        return Err(format!(
            "refusing to build worktree path for unsafe worktree name: {worktree_name:?}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_slashes_become_worktree_name_dashes() {
        assert_eq!(
            worktree_name_for_branch("feature/my-branch-abcd"),
            "feature-my-branch-abcd"
        );
    }

    #[tokio::test]
    async fn path_uses_project_and_safe_worktree_under_root() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree_name = worktree_name_for_branch("feature/my-branch-abcd");
        let result = build_contained_worktree_path(tmp.path(), "proj", &worktree_name)
            .await
            .unwrap();
        let canon_root = tokio::fs::canonicalize(tmp.path()).await.unwrap();
        assert_eq!(
            result,
            canon_root.join("proj").join("feature-my-branch-abcd")
        );
    }

    #[tokio::test]
    async fn rejects_dangerous_project_names() {
        let tmp = tempfile::tempdir().unwrap();
        for project_name in ["../escape", "nested/project", "nested\\project"] {
            let err = build_contained_worktree_path(tmp.path(), project_name, "branch")
                .await
                .unwrap_err();
            assert!(err.contains("unsafe project name"), "{err}");
        }
    }

    #[tokio::test]
    async fn rejects_parent_symlink_that_escapes_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("proj")).unwrap();
            let err = build_contained_worktree_path(&root, "proj", "branch")
                .await
                .unwrap_err();
            assert!(err.contains("escapes worktrees root"), "{err}");
        }
    }
}
