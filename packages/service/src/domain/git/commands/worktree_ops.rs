//! `git worktree list/add/remove` orchestration plus the porcelain parsers.

use std::collections::HashMap;
use std::path::Path;

use crate::domain::git::models::WorktreeInfo;
use crate::error::AppError;
use crate::shared::git_cli::{run_git, run_git_safe, run_git_safe_refs};
use crate::shared::worktree_paths::compute_worktree_path;

/// List all worktrees for a repository.
pub async fn list_worktrees(repo_path: &Path) -> Result<Vec<WorktreeInfo>, AppError> {
    let stdout = run_git(&["worktree", "list", "--porcelain"], repo_path).await?;
    Ok(parse_worktree_list(&stdout))
}

fn parse_worktree_list(output: &str) -> Vec<WorktreeInfo> {
    let mut worktrees = vec![];
    let mut path = None;
    let mut head = String::new();
    let mut branch = String::new();
    let mut is_bare = false;

    for line in output.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // Push previous entry if exists
            if let Some(prev_path) = path.take() {
                worktrees.push(WorktreeInfo {
                    path: prev_path,
                    branch: if branch.is_empty() {
                        "(detached)".to_string()
                    } else {
                        std::mem::take(&mut branch)
                    },
                    head: std::mem::take(&mut head),
                    is_bare,
                });
                is_bare = false;
            }
            path = Some(p.to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.replace("refs/heads/", "");
        } else if line == "bare" {
            is_bare = true;
        } else if line.is_empty() {
            if let Some(p) = path.take() {
                worktrees.push(WorktreeInfo {
                    path: p,
                    branch: if branch.is_empty() {
                        "(detached)".to_string()
                    } else {
                        std::mem::take(&mut branch)
                    },
                    head: std::mem::take(&mut head),
                    is_bare,
                });
                is_bare = false;
            }
        }
    }

    // Push last entry
    if let Some(p) = path {
        worktrees.push(WorktreeInfo {
            path: p,
            branch: if branch.is_empty() {
                "(detached)".to_string()
            } else {
                branch
            },
            head,
            is_bare,
        });
    }

    worktrees
}

/// Get info for a specific worktree by path.
pub async fn get_worktree_info(
    repo_path: &Path,
    worktree_path: &Path,
) -> Result<Option<WorktreeInfo>, AppError> {
    let all = list_worktrees(repo_path).await?;
    // Canonicalize to handle macOS symlinks (/var -> /private/var)
    let canonical =
        std::fs::canonicalize(worktree_path).unwrap_or_else(|_| worktree_path.to_path_buf());
    let wt_str = canonical.to_string_lossy();
    Ok(all.into_iter().find(|w| {
        let w_canonical =
            std::fs::canonicalize(&w.path).unwrap_or_else(|_| std::path::PathBuf::from(&w.path));
        w_canonical.to_string_lossy() == wt_str.as_ref()
    }))
}

/// Create a git worktree with a new branch.
/// Places the worktree at ~/.cadencr/worktrees/<project_name>/<safe_branch>.
pub async fn create_worktree(
    repo_path: &Path,
    branch_name: &str,
    project_name: &str,
) -> Result<(String, String), AppError> {
    // Pre-flight: verify repo
    run_git(&["rev-parse", "--git-dir"], repo_path)
        .await
        .map_err(|_| {
            AppError::BadRequest(format!(
                "Not a git repository: {}. Ensure the project path points to a valid git repo.",
                repo_path.display()
            ))
        })?;

    // Pre-flight: validate branch name
    if branch_name.is_empty() || branch_name.contains(|c: char| " \t~^:?*[\\".contains(c)) {
        return Err(AppError::BadRequest(format!(
            "Invalid branch name: \"{branch_name}\""
        )));
    }

    let worktree_str = compute_worktree_path(project_name, branch_name)
        .await
        .map_err(AppError::BadRequest)?;
    let worktree_path = std::path::PathBuf::from(&worktree_str);

    // Check if directory already exists
    if worktree_path.exists() {
        let existing = list_worktrees(repo_path).await?;
        if existing.iter().any(|w| w.path == worktree_str) {
            return Ok((worktree_str, branch_name.to_string()));
        }
        return Err(AppError::BadRequest(format!(
            "Directory already exists but is not a worktree: {worktree_str}"
        )));
    }

    // Create parent directory
    if let Some(parent) = worktree_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to create directory: {e}")))?;
    }

    // Try with -b first; fall back without -b if branch already exists
    match run_git_safe_refs(
        &["worktree", "add"],
        &["-b", branch_name],
        &[&worktree_str],
        repo_path,
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            let err_msg = e.to_string();
            if err_msg.contains("already exists") {
                run_git_safe_refs(
                    &["worktree", "add"],
                    &[],
                    &[&worktree_str, branch_name],
                    repo_path,
                )
                .await?;
            } else {
                return Err(e);
            }
        }
    }

    Ok((worktree_str, branch_name.to_string()))
}

/// Remove a git worktree. Safe removal refuses dirty worktrees; force removal
/// passes Git's `--force` escape hatch for explicit user-confirmed cleanup.
pub async fn remove_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    force: bool,
) -> Result<(), AppError> {
    let wt_str = worktree_path.to_string_lossy().to_string();
    let flags: &[&str] = if force { &["--force"] } else { &[] };
    run_git_safe(&["worktree", "remove"], flags, &[&wt_str], repo_path).await?;
    Ok(())
}

/// Parse `git worktree list --porcelain` and return a map of
/// `branch_name → worktree_path`. Bare-repo blocks (no `branch` line, or
/// `bare`) are skipped. The `refs/heads/` prefix is stripped from the
/// branch ref. Used by the reuse-branch flow to detect whether a branch
/// is already attached to an existing worktree.
pub async fn list_worktree_branches(
    repo: &Path,
) -> Result<HashMap<String, std::path::PathBuf>, AppError> {
    let output = run_git(&["worktree", "list", "--porcelain"], repo).await?;
    Ok(parse_worktree_branches(&output))
}

fn parse_worktree_branches(output: &str) -> HashMap<String, std::path::PathBuf> {
    let mut out: HashMap<String, std::path::PathBuf> = HashMap::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch: Option<String> = None;
    let mut is_bare = false;

    for line in output.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if !is_bare {
                if let (Some(p), Some(b)) = (cur_path.take(), cur_branch.take()) {
                    let short = b.strip_prefix("refs/heads/").unwrap_or(&b).to_string();
                    out.insert(short, std::path::PathBuf::from(p));
                }
            }
            cur_path = None;
            cur_branch = None;
            is_bare = false;
        } else if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = Some(b.to_string());
        } else if line == "bare" {
            is_bare = true;
        }
    }
    out
}

/// Check if a worktree has uncommitted or untracked changes.
pub async fn has_uncommitted_changes(worktree_path: &Path) -> Result<bool, AppError> {
    match run_git(&["status", "--porcelain"], worktree_path).await {
        Ok(stdout) => Ok(!stdout.trim().is_empty()),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_worktree_list_porcelain() {
        let output = "worktree /home/user/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /home/user/wt1\nHEAD def456\nbranch refs/heads/feature/test\n\n";
        let worktrees = parse_worktree_list(output);
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0].path, "/home/user/repo");
        assert_eq!(worktrees[0].branch, "main");
        assert_eq!(worktrees[0].head, "abc123");
        assert!(!worktrees[0].is_bare);
        assert_eq!(worktrees[1].path, "/home/user/wt1");
        assert_eq!(worktrees[1].branch, "feature/test");
        assert_eq!(worktrees[1].head, "def456");
    }

    #[test]
    fn test_parse_worktree_list_bare() {
        let output = "worktree /home/user/repo.git\nHEAD abc123\nbare\n\n";
        let worktrees = parse_worktree_list(output);
        assert_eq!(worktrees.len(), 1);
        assert!(worktrees[0].is_bare);
    }

    #[test]
    fn parse_worktree_branches_extracts_branch_to_path() {
        let output = "\
worktree /home/u/repo
HEAD abc123
branch refs/heads/main

worktree /home/u/wt1
HEAD def456
branch refs/heads/feature/test

";
        let map = parse_worktree_branches(output);
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("main").unwrap().to_string_lossy(), "/home/u/repo");
        assert_eq!(
            map.get("feature/test").unwrap().to_string_lossy(),
            "/home/u/wt1"
        );
    }

    #[test]
    fn parse_worktree_branches_skips_bare_block() {
        let output = "\
worktree /home/u/repo.git
HEAD abc123
bare

worktree /home/u/wt1
HEAD def456
branch refs/heads/feat

";
        let map = parse_worktree_branches(output);
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("feat"));
    }

    #[test]
    fn parse_worktree_branches_skips_detached_block() {
        // Detached worktrees have no `branch` line — they should not show up
        // in the branch→path map.
        let output = "\
worktree /home/u/wt
HEAD abc123
detached

";
        let map = parse_worktree_branches(output);
        assert!(map.is_empty());
    }

    #[test]
    fn test_parse_worktree_list_detached() {
        let output = "worktree /home/user/wt\nHEAD abc123\ndetached\n\n";
        let worktrees = parse_worktree_list(output);
        assert_eq!(worktrees.len(), 1);
        assert_eq!(worktrees[0].branch, "(detached)");
    }

    #[tokio::test]
    async fn remove_worktree_requires_force_for_dirty_tree() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let wt = dir.path().join("wt");
        std::fs::create_dir(&repo).unwrap();
        crate::shared::git_cli::run_git(&["init"], &repo)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(&["config", "user.email", "test@example.com"], &repo)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(&["config", "user.name", "Test"], &repo)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(&["config", "commit.gpgsign", "false"], &repo)
            .await
            .unwrap();
        std::fs::write(repo.join("README.md"), "hello").unwrap();
        crate::shared::git_cli::run_git(&["add", "README.md"], &repo)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(&["commit", "-m", "init"], &repo)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(
            &[
                "worktree",
                "add",
                "-b",
                "feature/dirty",
                wt.to_str().unwrap(),
            ],
            &repo,
        )
        .await
        .unwrap();
        std::fs::write(wt.join("dirty.txt"), "dirty").unwrap();

        let safe = remove_worktree(&repo, &wt, false).await;
        assert!(safe.is_err());

        remove_worktree(&repo, &wt, true).await.unwrap();
        assert!(!wt.exists());
    }
}
