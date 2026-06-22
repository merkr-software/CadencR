use std::path::{Path, PathBuf};

use crate::shared::git_cli::run_git;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeContext {
    pub source_root: PathBuf,
    pub worktree_root: PathBuf,
    pub session_cwd: PathBuf,
}

pub async fn resolve_source_git_root(project_dir: &Path) -> Result<PathBuf, String> {
    let output = run_git(&["rev-parse", "--show-toplevel"], project_dir)
        .await
        .map_err(|error| format!("failed to resolve git root: {error}"))?;
    let root = PathBuf::from(output.trim());
    canonicalize_existing(&root)
}

pub fn build_worktree_context(
    source_root: &Path,
    selected_project_path: &Path,
    worktree_root: &Path,
) -> Result<WorktreeContext, String> {
    let source_root = canonicalize_existing(source_root)?;
    let selected = canonicalize_existing(selected_project_path)?;
    let subpath = selected.strip_prefix(&source_root).map_err(|_| {
        format!(
            "selected project path {} is not inside git root {}",
            selected.display(),
            source_root.display()
        )
    })?;
    let worktree_root = canonicalize_existing(worktree_root)?;
    let session_cwd = if subpath.as_os_str().is_empty() {
        worktree_root.clone()
    } else {
        worktree_root.join(subpath)
    };

    Ok(WorktreeContext {
        source_root,
        worktree_root,
        session_cwd,
    })
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|error| {
        format!(
            "failed to canonicalize worktree context path {}: {error}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn init_repo(path: &Path) {
        tokio::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .current_dir(path)
            .status()
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn resolves_root_level_config_and_selected_subpath_session_cwd() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        let selected = repo.path().join("packages/app");
        tokio::fs::create_dir_all(&selected).await.unwrap();
        tokio::fs::create_dir_all(repo.path().join(".claude/skills/root-skill"))
            .await
            .unwrap();
        tokio::fs::write(
            repo.path().join(".claude/skills/root-skill/SKILL.md"),
            "root skill",
        )
        .await
        .unwrap();
        let worktree_root = tempfile::tempdir().unwrap();

        let source_root = resolve_source_git_root(&selected).await.unwrap();
        let context =
            build_worktree_context(&source_root, &selected, worktree_root.path()).unwrap();

        assert_eq!(context.source_root, repo.path().canonicalize().unwrap());
        assert_eq!(
            context.worktree_root,
            worktree_root.path().canonicalize().unwrap()
        );
        assert_eq!(
            context.session_cwd,
            worktree_root
                .path()
                .canonicalize()
                .unwrap()
                .join("packages/app")
        );
        crate::domain::agents::providers::notify_worktree_created_for_all_providers(
            &context.source_root,
            &context.worktree_root,
        )
        .await
        .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(
                context
                    .worktree_root
                    .join(".claude/skills/root-skill/SKILL.md")
            )
            .await
            .unwrap(),
            "root skill"
        );
    }

    #[test]
    fn build_worktree_context_rejects_selected_path_outside_git_root() {
        let source = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();

        let error = build_worktree_context(source.path(), selected.path(), worktree.path())
            .expect_err("selected path should be rejected");

        assert!(error.contains("is not inside git root"));
    }
}
