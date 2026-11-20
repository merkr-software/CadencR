use std::path::Path;

use crate::error::AppError;

use super::{git_failure, run_raw_observer, safe_path_args, safe_ref_args, validate_positionals};

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
/// `merge`, `fetch`, `stash`, etc.); those need normal Git locking semantics
/// and must not be killed when their caller is cancelled.
pub async fn run_git_background(args: &[&str], cwd: &Path) -> Result<String, AppError> {
    run_raw_observer(&prepend_no_optional_locks(args), cwd).await
}

/// Resolve a ref without optional locks while distinguishing an absent ref
/// from an actual repository or spawn failure.
pub async fn git_ref_resolves_background(reference: &str, cwd: &Path) -> Result<bool, AppError> {
    validate_positionals(&[reference])?;
    let args = ["rev-parse", "--verify", "--quiet", reference];
    Ok(run_git_probe_background(&args, cwd).await?.is_some())
}

/// Run a background Git query whose "nothing there" answer is exit status 1
/// with an empty stderr: `config --get`, `symbolic-ref --quiet`,
/// `show-ref --verify --quiet`, `rev-parse --verify --quiet`. That answer is
/// `Ok(None)`; every other failure is an error, so a broken repository or a
/// missing `git` never reads as an absent value. Callers guard any
/// user-controlled positional first.
pub async fn run_git_probe_background(
    args: &[&str],
    cwd: &Path,
) -> Result<Option<String>, AppError> {
    let args = prepend_no_optional_locks(args);
    let output = super::git_command()
        .kill_on_drop(true)
        .args(&args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| AppError::git_command(format!("Failed to spawn git: {error}")))?;
    if output.status.success() {
        return Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.code() == Some(1) && stderr.trim().is_empty() {
        return Ok(None);
    }
    // The same user-facing (path-redacted) error any other Git read reports:
    // the view that asked shows why, instead of an opaque internal error.
    Err(git_failure(&args, &stderr))
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
    run_raw_observer(&args, cwd).await
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
    run_raw_observer(&args, cwd).await
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

    /// Exit 1 without a message is the probes' "absent"; the same probe in a
    /// directory that is no repository must fail instead of reading as absent.
    #[tokio::test]
    async fn probe_separates_an_absent_value_from_a_failure() {
        let repo = tempfile::tempdir().unwrap();
        let status = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        assert!(status.success());
        let symref = ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"];
        assert_eq!(
            run_git_probe_background(&symref, repo.path())
                .await
                .unwrap(),
            None
        );
        let config = ["config", "--get", "core.bare"];
        assert_eq!(
            run_git_probe_background(&config, repo.path())
                .await
                .unwrap()
                .as_deref(),
            Some("false\n")
        );

        let not_repo = tempfile::tempdir().unwrap();
        let error = run_git_probe_background(&symref, not_repo.path())
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::GitRejected(_)), "{error:?}");
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
        assert!(matches!(error, AppError::GitRejected(_)), "{error:?}");
    }
}
