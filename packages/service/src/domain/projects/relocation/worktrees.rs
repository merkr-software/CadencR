//! Linked git worktrees of a repository whose folder moved.
//!
//! Each linked worktree finds its repository through an absolute path in its
//! `.git` file. Once the repository moves, git no longer recognises those
//! worktrees ("not a git repository") and Cadencr would fall back to running
//! their conversations in the main checkout; `git worktree repair` rewrites
//! the links both ways.

use std::path::{Path, PathBuf};

use crate::domain::git::commands::list_worktrees;
use crate::shared::git_cli::run_git;
use crate::shared::path_rebase::{rebase, same_folder};

/// The linked worktrees git records for the repository now at `repo`, where
/// they are now: worktrees that lived inside the moved folder moved with it.
pub(super) async fn linked_worktrees(repo: &Path, from: &Path) -> Result<Vec<PathBuf>, String> {
    if !repo.join(".git").is_dir() {
        // Not a repository root (no git, or a project inside a repository):
        // nothing links to this folder.
        return Ok(Vec::new());
    }
    let listing = list_worktrees(repo)
        .await
        .map_err(|error| format!("could not list the git worktrees: {error}"))?;
    Ok(listing
        .into_iter()
        .filter(|worktree| !worktree.is_bare)
        .map(|worktree| PathBuf::from(worktree.path))
        .filter(|path| !same_folder(path, repo) && path != from)
        .map(|path| rebase(&path, from, repo).unwrap_or(path))
        .collect())
}

/// Point `worktrees` and the repository at `repo` back at each other. Git
/// stops at the first worktree whose folder is gone and skips the rest, so
/// only existing folders are passed; the missing ones are reported.
pub(super) async fn repair(repo: &Path, worktrees: &[PathBuf]) -> Vec<String> {
    let (present, missing): (Vec<&PathBuf>, Vec<&PathBuf>) =
        worktrees.iter().partition(|path| path.is_dir());
    let mut notes: Vec<String> = missing
        .iter()
        .map(|path| format!("The git worktree {} no longer exists", path.display()))
        .collect();
    if present.is_empty() {
        return notes;
    }
    let paths: Vec<String> = present
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let mut args = vec!["worktree", "repair"];
    args.extend(paths.iter().map(String::as_str));
    if let Err(error) = run_git(&args, repo).await {
        notes.push(format!(
            "git could not reconnect the worktrees to {}: {error}. Run `git worktree repair` there.",
            repo.display()
        ));
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(args: &[&str], cwd: &Path) {
        run_git(args, cwd).await.unwrap();
    }

    async fn repository_with_worktree(root: &Path) -> (PathBuf, PathBuf) {
        let repo = root.join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&["init", "-q"], &repo).await;
        git(
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
            &repo,
        )
        .await;
        let worktree = root.join("worktrees/feat");
        git(
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat",
                &worktree.to_string_lossy(),
            ],
            &repo,
        )
        .await;
        (repo, worktree)
    }

    #[tokio::test]
    async fn a_moved_repository_gets_its_worktrees_back() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (repo, worktree) = repository_with_worktree(&root).await;
        let moved = root.join("renamed");
        std::fs::rename(&repo, &moved).unwrap();
        assert!(
            run_git(&["status"], &worktree).await.is_err(),
            "the link is broken"
        );

        let worktrees = linked_worktrees(&moved, &repo).await.unwrap();
        let notes = repair(&moved, &worktrees).await;

        assert_eq!(worktrees, std::slice::from_ref(&worktree));
        assert!(notes.is_empty(), "{notes:?}");
        git(&["status"], &worktree).await;
    }

    #[tokio::test]
    async fn a_worktree_folder_that_is_gone_is_reported_not_fatal() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");

        let notes = repair(&repo, &[root.path().join("gone")]).await;

        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("no longer exists"));
    }

    #[tokio::test]
    async fn a_folder_without_git_has_no_worktrees() {
        let root = tempfile::tempdir().unwrap();

        let worktrees = linked_worktrees(root.path(), Path::new("/old"))
            .await
            .unwrap();

        assert!(worktrees.is_empty());
    }
}
