//! File-content fetchers used by the diff viewer (single + batch) and
//! `ls-files` listing.

use std::path::Path;

use crate::domain::git::file_size::classify_content;
use crate::domain::git::models::FileContentBatchItem;
use crate::error::AppError;
use crate::shared::git_cli::run_git_safe_refs;

use super::util::run_git_quiet;

/// Get file content at a given ref, or from working tree if ref is None.
pub async fn get_file_content(
    worktree_path: &Path,
    file_path: &str,
    ref_spec: Option<&str>,
) -> Result<String, AppError> {
    match ref_spec {
        None => {
            // Read from working tree — validate against path traversal
            let full_path = worktree_path.join(file_path);
            let canonical_wt = worktree_path
                .canonicalize()
                .map_err(|e| AppError::BadRequest(format!("Invalid worktree path: {e}")))?;
            let canonical_file = full_path
                .canonicalize()
                .map_err(|_| AppError::BadRequest("File not found".into()))?;
            if !canonical_file.starts_with(&canonical_wt) {
                return Err(AppError::BadRequest("Path traversal not allowed".into()));
            }
            Ok(tokio::fs::read_to_string(&canonical_file)
                .await
                .unwrap_or_default())
        }
        Some(r) => {
            let show_arg = format!("{r}:{file_path}");
            Ok(
                run_git_safe_refs(&["show"], &[], &[&show_arg], worktree_path)
                    .await
                    .unwrap_or_default(),
            )
        }
    }
}

/// Get file content for multiple files (batch).
///
/// We fetch both sides of every file (same per-file cost as the original
/// implementation) and then derive size + binary + large flags from the
/// returned content. For binary files or files whose largest side meets
/// `LARGE_FILE_BYTES`, content is omitted from the response — the frontend
/// renders a placeholder and pulls the content via the single-file endpoint
/// on opt-in. Deriving metadata from the already-fetched content avoids
/// adding extra git calls per file (which was making the batch slow and
/// produced visible empty blocks while the diff view loaded).
pub async fn get_file_content_batch(
    git_path: &Path,
    file_paths: &[String],
    old_ref: &str,
    new_ref: Option<&str>,
) -> Result<Vec<FileContentBatchItem>, AppError> {
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }

    use futures::stream::{self, StreamExt};

    let git_path = git_path.to_path_buf();
    let old_ref = old_ref.to_string();
    let new_ref = new_ref.map(|s| s.to_string());

    let items: Vec<FileContentBatchItem> = stream::iter(file_paths.to_vec())
        .map(|file_path| {
            let git_path = git_path.clone();
            let old_ref = old_ref.clone();
            let new_ref = new_ref.clone();
            async move {
                let (old, new) = tokio::join!(
                    get_file_content(&git_path, &file_path, Some(&old_ref)),
                    get_file_content(&git_path, &file_path, new_ref.as_deref()),
                );
                classify_content(
                    file_path,
                    old.unwrap_or_default(),
                    new.unwrap_or_default(),
                    /* keep_large_content */ false,
                )
            }
        })
        .buffer_unordered(20)
        .collect()
        .await;

    Ok(items)
}

/// List files in the worktree the user might want to open from Cmd+P:
/// every git-tracked file, plus any env files (`.env`, `.env.local`,
/// `local.env`, ...) that are usually gitignored. Agents do most of the
/// editing inside Cadencr, but humans still need to reach env files by
/// hand, so this endpoint deliberately steps around `.gitignore` for the
/// env-file allowlist while leaving every other untracked path alone.
pub async fn list_files(worktree_path: &Path) -> Result<Vec<String>, AppError> {
    let stdout = run_git_quiet(&["ls-files"], worktree_path).await;
    let mut files: Vec<String> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect();

    // The env-file scan touches the filesystem; do it off the runtime
    // thread to keep the handler non-blocking.
    let wt = worktree_path.to_path_buf();
    let env_files: Vec<String> =
        tokio::task::spawn_blocking(move || crate::shared::env_file::find_env_files(&wt))
            .await
            .map_err(|e| AppError::Internal(format!("Blocking task failed: {e}")))?;

    let mut seen: std::collections::HashSet<String> = files.iter().cloned().collect();
    for rel in env_files {
        if seen.insert(rel.clone()) {
            files.push(rel);
        }
    }
    // Re-sort so the union is stable; `git ls-files` output is already
    // sorted, but appending env files preserves order only when none are
    // new, so we sort defensively.
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(args: &[&str], cwd: &Path) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("git available");
        assert!(status.success(), "git {args:?} failed");
    }

    #[tokio::test]
    async fn list_files_includes_gitignored_env_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        git(&["init", "-q", "-b", "main"], root);
        git(&["config", "user.email", "test@example.com"], root);
        git(&["config", "user.name", "Test"], root);
        git(&["config", "commit.gpgsign", "false"], root);
        git(&["config", "tag.gpgsign", "false"], root);
        std::fs::write(root.join(".gitignore"), ".env*\n").unwrap();
        std::fs::write(root.join("README.md"), "# hi").unwrap();
        std::fs::write(root.join("src.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join(".env"), "FOO=bar").unwrap();
        std::fs::write(root.join(".env.local"), "FOO=local").unwrap();
        std::fs::write(root.join("local.env"), "FOO=user").unwrap();
        std::fs::write(root.join("development.env"), "FOO=dev").unwrap();
        std::fs::write(root.join("untracked.txt"), "ignored junk").unwrap();
        git(&["add", ".gitignore", "README.md", "src.rs"], root);
        git(&["commit", "-q", "-m", "init"], root);

        let listed = list_files(root).await.expect("list_files");

        // Tracked files still appear.
        assert!(listed.iter().any(|p| p == "README.md"));
        assert!(listed.iter().any(|p| p == "src.rs"));
        assert!(listed.iter().any(|p| p == ".gitignore"));
        // Env files appear even though gitignored.
        assert!(
            listed.iter().any(|p| p == ".env"),
            "missing .env: {listed:?}"
        );
        assert!(listed.iter().any(|p| p == ".env.local"));
        // Plain-suffix env files appear too (these typically aren't gitignored,
        // but git ls-files wouldn't list them if untracked).
        assert!(listed.iter().any(|p| p == "local.env"));
        assert!(listed.iter().any(|p| p == "development.env"));
        // We must not start listing every untracked file — only env files.
        assert!(
            !listed.iter().any(|p| p == "untracked.txt"),
            "untracked non-env file leaked through: {listed:?}",
        );
    }
}
