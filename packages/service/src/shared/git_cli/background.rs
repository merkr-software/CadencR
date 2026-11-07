use std::path::Path;

use crate::error::AppError;

use super::{run_raw, safe_path_args, safe_ref_args, sanitize_git_stderr, validate_positionals};

/// Run a **periodic / read-style** git command with `--no-optional-locks`
/// so it can't race a concurrent user-initiated mutation (`git rebase`,
/// `git commit`, etc.) for `.git/index.lock`.
///
/// Default-on `git status` (and `git diff`) refresh the index stat cache,
/// briefly creating `.git/index.lock`. When the watcher fires observational
/// reads during a terminal mutation, both processes can otherwise race for
/// that lock.
///
/// Do not use this for state-changing commands (`commit`, `push`, `rebase`,
/// `merge`, `fetch`, `stash`, etc.); those need normal Git locking semantics.
pub async fn run_git_background(args: &[&str], cwd: &Path) -> Result<String, AppError> {
    run_raw(&prepend_no_optional_locks(args), cwd).await
}

/// Resolve a ref without optional locks while distinguishing an absent ref
/// from an actual repository or spawn failure.
pub async fn git_ref_resolves_background(reference: &str, cwd: &Path) -> Result<bool, AppError> {
    validate_positionals(&[reference])?;
    let args = prepend_no_optional_locks(&["rev-parse", "--verify", "--quiet", reference]);
    let output = super::git_command()
        .args(&args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| AppError::GitCommandError(format!("Failed to spawn git: {error}")))?;
    if output.status.success() {
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.code() == Some(1) && stderr.trim().is_empty() {
        return Ok(false);
    }
    // A background probe failing is plumbing, not a refusal the user asked
    // for: it stays an internal (masked, reported) error.
    Err(AppError::GitCommandError(format!(
        "git {} failed: {}",
        args.join(" "),
        sanitize_git_stderr(stderr.trim())
    )))
}

/// Read-only counterpart to `run_git_safe`. It preserves pathspec validation
/// and the `--` separator while disabling Git's optional index refresh.
pub async fn run_git_safe_background(
    subcommand_args: &[&str],
    flags: &[&str],
    positionals: &[&str],
    cwd: &Path,
) -> Result<String, AppError> {
    validate_positionals(positionals)?;
    let safe_args = safe_path_args(subcommand_args, flags, positionals);
    let args = prepend_no_optional_locks(&safe_args);
    run_raw(&args, cwd).await
}

/// Read-only counterpart to `run_git_safe_refs`. Ref-like positionals remain
/// injection-guarded while optional index refreshes stay disabled.
pub async fn run_git_safe_refs_background(
    subcommand_args: &[&str],
    flags: &[&str],
    positionals: &[&str],
    cwd: &Path,
) -> Result<String, AppError> {
    validate_positionals(positionals)?;
    let safe_args = safe_ref_args(subcommand_args, flags, positionals);
    let args = prepend_no_optional_locks(&safe_args);
    run_raw(&args, cwd).await
}

fn prepend_no_optional_locks<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut prefixed = Vec::with_capacity(args.len() + 1);
    prefixed.push("--no-optional-locks");
    prefixed.extend_from_slice(args);
    prefixed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_reads_prepend_no_optional_locks() {
        assert_eq!(
            prepend_no_optional_locks(&["status", "--porcelain=v2", "-b"]),
            vec!["--no-optional-locks", "status", "--porcelain=v2", "-b"]
        );
        assert_eq!(prepend_no_optional_locks(&[]), vec!["--no-optional-locks"]);
    }

    #[test]
    fn background_safe_args_keep_validation_boundaries() {
        assert_eq!(
            prepend_no_optional_locks(&safe_path_args(&["diff", "HEAD"], &[], &["src/main.rs"],)),
            vec!["--no-optional-locks", "diff", "HEAD", "--", "src/main.rs"]
        );
        assert_eq!(
            prepend_no_optional_locks(&safe_ref_args(&["diff"], &[], &["main...HEAD"])),
            vec!["--no-optional-locks", "diff", "main...HEAD"]
        );
    }

    #[tokio::test]
    async fn ref_probe_distinguishes_missing_ref_from_repository_error() {
        let repo = tempfile::tempdir().unwrap();
        let status = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(!git_ref_resolves_background("HEAD", repo.path())
            .await
            .unwrap());

        let not_repo = tempfile::tempdir().unwrap();
        let error = git_ref_resolves_background("HEAD", not_repo.path())
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::GitCommandError(_)), "{error:?}");
    }
}
