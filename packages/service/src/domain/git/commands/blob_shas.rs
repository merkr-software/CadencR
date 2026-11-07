//! `get_file_blob_shas`: collect blob SHAs for every file that's changed
//! in the working copy or relative to the feature's base branch. Used by the
//! diff viewer to key its per-file caches and to retire review comments.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::error::AppError;
use crate::shared::git_cli::{
    git_ref_resolves_background, run_git, run_git_background, run_git_output_with_env, run_git_safe,
};

/// Non-empty lines of a `--name-only` style listing.
fn name_lines(output: &str) -> HashSet<String> {
    output
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Files changed on the branch since it forked from `base_branch`. A base
/// that shares no history with `HEAD` has no branch changes; a missing base
/// and every other Git failure are errors.
async fn branch_changed_files(
    worktree_path: &Path,
    base_branch: &str,
    has_head: bool,
) -> Result<HashSet<String>, AppError> {
    if !has_head {
        return Ok(HashSet::new());
    }
    // A base that cannot be resolved would make every committed file look
    // gone; refuse instead so the viewer pauses comment retirement.
    if !git_ref_resolves_background(base_branch, worktree_path).await? {
        return Err(AppError::Conflict(format!(
            "Base branch '{base_branch}' does not exist; set the feature's target branch"
        )));
    }
    let output =
        run_git_output_with_env(&["merge-base", "HEAD", base_branch], worktree_path, &[]).await?;
    let merge_base = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match output.status.code() {
        Some(0) if !merge_base.is_empty() => {}
        // Exit 1 with no output: no common ancestor.
        Some(1) if merge_base.is_empty() => return Ok(HashSet::new()),
        _ => {
            return Err(AppError::GitCommandError(format!(
                "git merge-base HEAD {base_branch} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }
    Ok(name_lines(
        &run_git_background(&["diff", &merge_base, "HEAD", "--name-only"], worktree_path).await?,
    ))
}

/// Get blob SHAs for all changed files (worktree + branch changes).
///
/// Listing failures are errors, never an empty map: the diff viewer treats a
/// file missing from this map as changed, and auto-deletes the review
/// comments anchored to it. A listed file that exists neither in the working
/// tree nor in `HEAD` is deleted, and is left out on purpose.
pub async fn get_file_blob_shas(
    feature_path: &Path,
    base_branch: &str,
) -> Result<HashMap<String, String>, AppError> {
    // Paths are keyed relative to the repository root, like the changed-file
    // list review comments are anchored to. A monorepo project's feature path
    // is a subdirectory, where `ls-files` and `hash-object` would otherwise
    // resolve paths relative to it.
    let top = run_git_background(&["rev-parse", "--show-toplevel"], feature_path).await?;
    let repo_root = std::path::PathBuf::from(top.trim());
    let worktree_path = repo_root.as_path();
    // An unborn branch has no HEAD to diff against; its tracked changes are
    // exactly what is staged.
    let has_head = git_ref_resolves_background("HEAD", worktree_path).await?;
    let changed_args: &[&str] = if has_head {
        &["diff", "HEAD", "--name-only"]
    } else {
        &["diff", "--cached", "--name-only"]
    };
    let (changed_out, untracked_out, branch_changed) = tokio::try_join!(
        run_git_background(changed_args, worktree_path),
        run_git_background(
            &["ls-files", "--others", "--exclude-standard"],
            worktree_path
        ),
        branch_changed_files(worktree_path, base_branch, has_head),
    )?;
    let changed_files = name_lines(&changed_out);
    let untracked_files = name_lines(&untracked_out);

    let all_files: HashSet<String> = changed_files
        .union(&untracked_files)
        .cloned()
        .collect::<HashSet<_>>()
        .union(&branch_changed)
        .cloned()
        .collect();

    let mut result = HashMap::new();
    for file_path in all_files {
        // A file name starting with `-` would be parsed as a flag; skip it.
        if crate::shared::git_cli::guard_positionals(&[file_path.as_str()]).is_err() {
            continue;
        }
        // Try hash-object first, then rev-parse HEAD:path
        let sha = match run_git_safe(&["hash-object"], &[], &[&file_path], worktree_path).await {
            Ok(stdout) => stdout.trim().to_string(),
            Err(_) => {
                let rev_arg = format!("HEAD:{file_path}");
                match run_git(&["rev-parse", &rev_arg], worktree_path).await {
                    Ok(stdout) => stdout.trim().to_string(),
                    Err(_) => continue,
                }
            }
        };
        if !sha.is_empty() {
            result.insert(file_path, sha);
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(args: &[&str], cwd: &Path) {
        run_git(args, cwd).await.unwrap();
    }

    /// Repo whose base branch is `develop` (no `main`/`master`), with a
    /// feature branch that committed `feature.txt`.
    async fn repo_on_develop() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        git(&["init", "-q", "-b", "develop"], path).await;
        git(&["config", "user.email", "test@example.com"], path).await;
        git(&["config", "user.name", "Test"], path).await;
        git(&["config", "commit.gpgsign", "false"], path).await;
        std::fs::write(path.join("base.txt"), "base").unwrap();
        git(&["add", "base.txt"], path).await;
        git(&["commit", "-qm", "base"], path).await;
        git(&["checkout", "-qb", "feature/x"], path).await;
        std::fs::write(path.join("feature.txt"), "work").unwrap();
        git(&["add", "feature.txt"], path).await;
        git(&["commit", "-qm", "work"], path).await;
        dir
    }

    #[tokio::test]
    async fn a_committed_file_stays_listed_against_a_non_main_base() {
        // A file the agent committed leaves `git diff HEAD`; only the branch
        // diff keeps it in the map, so its review comments are not retired.
        let repo = repo_on_develop().await;
        let shas = get_file_blob_shas(repo.path(), "develop").await.unwrap();
        assert!(shas.contains_key("feature.txt"), "{shas:?}");
        assert!(!shas.contains_key("base.txt"));
    }

    #[tokio::test]
    async fn a_missing_base_branch_is_refused_not_an_empty_branch_diff() {
        let repo = repo_on_develop().await;
        assert!(matches!(
            get_file_blob_shas(repo.path(), "main").await,
            Err(AppError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn a_subdirectory_feature_path_keys_files_from_the_repository_root() {
        let repo = repo_on_develop().await;
        let app = repo.path().join("packages/app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("new.ts"), "untracked").unwrap();
        std::fs::write(repo.path().join("feature.txt"), "edited").unwrap();

        let shas = get_file_blob_shas(&app, "develop").await.unwrap();

        assert!(shas.contains_key("packages/app/new.ts"), "{shas:?}");
        let edited = run_git(&["hash-object", "feature.txt"], repo.path())
            .await
            .unwrap();
        assert_eq!(
            shas.get("feature.txt").map(String::as_str),
            Some(edited.trim())
        );
    }

    #[tokio::test]
    async fn listing_failures_are_errors_not_an_empty_map() {
        let not_a_repo = tempfile::tempdir().unwrap();
        assert!(get_file_blob_shas(not_a_repo.path(), "main").await.is_err());
    }
}
