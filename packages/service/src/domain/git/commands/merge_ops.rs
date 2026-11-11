//! `git merge-tree` / `git branch -d` orchestration.
//! Branch-resolution lives in [`super::merge`].

use std::path::Path;

use crate::domain::git::models::{MergeConflictResult, MergeResult};
use crate::error::AppError;
use crate::shared::git_cli::{
    git_output_error, run_git_background, run_git_output_with_env, run_git_safe_refs,
};

/// Check if merging source_branch into target_branch would produce conflicts.
///
/// Uses the modern two-argument form of `git merge-tree` (Git 2.38+) which
/// performs a real merge in-memory and exits with code 0 for clean merges or
/// code 1 for conflicts. The old three-argument form would false-positive on
/// identical changes present on both sides.
pub async fn check_merge_conflicts(
    repo_path: &Path,
    source_branch: &str,
    target_branch: &str,
) -> Result<MergeConflictResult, AppError> {
    crate::shared::git_cli::guard_positionals(&[target_branch, source_branch])?;
    // `--name-only -z --no-messages` makes the conflicted-file section a
    // NUL-separated path list instead of translated `CONFLICT (...)` prose,
    // and covers modify/delete and rename conflicts that have no
    // "Merge conflict in" line at all.
    let args = [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "-z",
        target_branch,
        source_branch,
    ];
    let output = run_git_output_with_env(&args, repo_path, &[]).await?;

    match output.status.code() {
        Some(0) => Ok(MergeConflictResult {
            has_conflicts: false,
            conflict_files: vec![],
        }),
        // Some Git versions also exit 1 for invalid input; a real conflict
        // always prints the merged tree's object ID first.
        Some(1) if starts_with_tree_oid(&output.stdout) => Ok(MergeConflictResult {
            has_conflicts: true,
            conflict_files: parse_merge_tree_conflicts(&output.stdout),
        }),
        // Anything else (unknown ref, unrelated histories, corrupt repo) is a
        // failure to compute the merge, not a conflict.
        _ => Err(git_output_error(&args, &output)),
    }
}

/// `merge-tree --write-tree --name-only -z` prints `<tree-oid>\0`, then one
/// `<path>\0` per conflicted file, then (messages aside) an empty record.
fn parse_merge_tree_conflicts(stdout: &[u8]) -> Vec<String> {
    stdout
        .split(|byte| *byte == 0)
        .skip(1)
        .take_while(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect()
}

fn starts_with_tree_oid(stdout: &[u8]) -> bool {
    let oid = stdout.split(|byte| *byte == 0).next().unwrap_or_default();
    matches!(oid.len(), 40 | 64) && oid.iter().all(u8::is_ascii_hexdigit)
}

/// Paths with unmerged index entries — the authoritative, locale-independent
/// conflict list for an in-progress merge, rebase, squash, or stash apply.
pub async fn unmerged_paths(repo_path: &Path) -> Result<Vec<String>, AppError> {
    let output = run_git_background(
        &["diff", "--name-only", "--diff-filter=U", "-z", "--"],
        repo_path,
    )
    .await?;
    Ok(crate::shared::git_z::paths(&output))
}

/// Return true when `branch_name` is fully contained in `target_branch`.
/// `merge-base --is-ancestor` exits 1 for "not an ancestor"; any other
/// failure (missing ref, broken repository) is an error, not a verdict.
pub async fn is_branch_merged(
    repo_path: &Path,
    branch_name: &str,
    target_branch: &str,
) -> Result<bool, AppError> {
    crate::shared::git_cli::guard_positionals(&[branch_name, target_branch])?;
    let args = ["merge-base", "--is-ancestor", branch_name, target_branch];
    let output = run_git_output_with_env(&args, repo_path, &[]).await?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git_output_error(&args, &output)),
    }
}

/// Delete a local branch after the service layer has applied the target-branch
/// safety policy. `git branch -d` cannot enforce that policy: it checks the
/// branch's configured upstream (or the current `HEAD`) instead of the feature's
/// selected target branch.
pub async fn force_delete_branch(
    repo_path: &Path,
    branch_name: &str,
) -> Result<MergeResult, AppError> {
    match run_git_safe_refs(&["branch"], &["-D"], &[branch_name], repo_path).await {
        Ok(_) => Ok(MergeResult {
            success: true,
            error: None,
            conflict_files: None,
            warning: None,
        }),
        Err(e) => Ok(MergeResult {
            success: false,
            error: Some(e.to_string()),
            conflict_files: None,
            warning: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli::run_git;

    async fn commit_all(repo: &Path, message: &str) {
        run_git(&["add", "-A"], repo).await.unwrap();
        run_git(&["commit", "-q", "-m", message], repo)
            .await
            .unwrap();
    }

    /// `main` and `feat` diverge with a content conflict (`content.txt`), a
    /// modify/delete conflict (`gone.txt`), and a rename/rename conflict
    /// (`moved.txt`). Only the first ever printed "Merge conflict in".
    async fn diverged_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "test@example.com"][..],
            &["config", "user.name", "Test"][..],
            &["config", "commit.gpgsign", "false"][..],
        ] {
            run_git(args, repo).await.unwrap();
        }
        std::fs::write(repo.join("content.txt"), "base\n").unwrap();
        std::fs::write(repo.join("gone.txt"), "base\n").unwrap();
        std::fs::write(repo.join("moved.txt"), "rename me\n").unwrap();
        commit_all(repo, "base").await;
        run_git(&["checkout", "-q", "-b", "feat"], repo)
            .await
            .unwrap();
        std::fs::write(repo.join("content.txt"), "feat\n").unwrap();
        std::fs::remove_file(repo.join("gone.txt")).unwrap();
        run_git(&["mv", "moved.txt", "feat-name.txt"], repo)
            .await
            .unwrap();
        commit_all(repo, "feat").await;
        run_git(&["checkout", "-q", "main"], repo).await.unwrap();
        std::fs::write(repo.join("content.txt"), "main\n").unwrap();
        std::fs::write(repo.join("gone.txt"), "main edit\n").unwrap();
        run_git(&["mv", "moved.txt", "main-name.txt"], repo)
            .await
            .unwrap();
        commit_all(repo, "main").await;
        dir
    }

    #[tokio::test]
    async fn merge_preview_lists_content_modify_delete_and_rename_conflicts() {
        let dir = diverged_repo().await;

        let result = check_merge_conflicts(dir.path(), "feat", "main")
            .await
            .unwrap();

        assert!(result.has_conflicts);
        let mut files = result.conflict_files;
        files.sort();
        assert!(files.contains(&"content.txt".to_string()), "{files:?}");
        assert!(files.contains(&"gone.txt".to_string()), "{files:?}");
        assert!(
            files.iter().any(|file| file.ends_with("-name.txt")),
            "rename conflict must name a path: {files:?}"
        );
        assert!(
            files
                .iter()
                .all(|file| !file.contains("CONFLICT") && !file.contains(' ')),
            "paths only, never prose: {files:?}"
        );
    }

    #[tokio::test]
    async fn merge_preview_reports_failures_instead_of_phantom_conflicts() {
        let dir = diverged_repo().await;

        let error = check_merge_conflicts(dir.path(), "no-such-branch", "main")
            .await
            .unwrap_err();

        // A refusal the user can act on (the branch is unknown), not a preview.
        assert!(
            matches!(&error, AppError::GitRejected(rejection)
                if rejection.kind == crate::error::GitFailureKind::RefNotFound),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn merge_preview_reports_clean_merges() {
        let dir = diverged_repo().await;
        run_git(&["branch", "clean", "main"], dir.path())
            .await
            .unwrap();

        let result = check_merge_conflicts(dir.path(), "clean", "main")
            .await
            .unwrap();

        assert!(!result.has_conflicts);
        assert!(result.conflict_files.is_empty());
    }

    #[tokio::test]
    async fn unmerged_paths_follow_the_index_after_a_real_merge() {
        let dir = diverged_repo().await;
        assert!(run_git(&["merge", "--no-edit", "feat"], dir.path())
            .await
            .is_err());

        let mut paths = unmerged_paths(dir.path()).await.unwrap();
        paths.sort();

        assert!(paths.contains(&"content.txt".to_string()), "{paths:?}");
        assert!(paths.contains(&"gone.txt".to_string()), "{paths:?}");
    }

    #[tokio::test]
    async fn branch_merged_check_separates_verdicts_from_failures() {
        let dir = diverged_repo().await;
        let repo = dir.path();

        assert!(!is_branch_merged(repo, "feat", "main").await.unwrap());
        run_git(&["branch", "contained", "main~1"], repo)
            .await
            .unwrap();
        assert!(is_branch_merged(repo, "contained", "main").await.unwrap());
        assert!(is_branch_merged(repo, "feat", "no-such-branch")
            .await
            .is_err());
    }

    #[test]
    fn merge_tree_output_parsing_stops_at_the_section_terminator() {
        let stdout = b"0123abcd\0a.txt\0dir/b.txt\0\0ignored message\0";
        assert_eq!(
            parse_merge_tree_conflicts(stdout),
            vec!["a.txt".to_string(), "dir/b.txt".to_string()],
        );
        assert!(parse_merge_tree_conflicts(b"0123abcd\0").is_empty());
        assert!(starts_with_tree_oid(
            format!("{}\0a.txt\0", "a1".repeat(20)).as_bytes()
        ));
        assert!(!starts_with_tree_oid(b""));
        assert!(!starts_with_tree_oid(b"fatal: not a valid object\n"));
    }
}
