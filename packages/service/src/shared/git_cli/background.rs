use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use crate::error::AppError;

use super::redact::redact_paths;
use super::{
    bytes_to_string_lossy, git_command, git_failure, safe_path_args, safe_ref_args,
    validate_positionals,
};

mod io;
pub use io::{
    run_git_background_bounded, run_git_background_head_bytes, run_git_background_with_stdin,
    run_git_safe_background_bounded, run_git_safe_refs_background_bounded, BoundedGitOutput,
};

/// Hard wall-clock ceiling for observational / read-only background Git calls.
/// Mutations (`commit`, `push`, `fetch`, `rebase`, `merge`) use the non-background
/// helpers and are not bound by this timeout.
const BACKGROUND_GIT_TIMEOUT: Duration = Duration::from_secs(30);

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
    let args = prepend_no_optional_locks(args);
    run_checked_background(&args, cwd).await
}

/// Spawn a read-only Git command with `--no-optional-locks`, `kill_on_drop(true)`,
/// and [`BACKGROUND_GIT_TIMEOUT`], returning its raw [`Output`] even on non-zero
/// exit (for commands like `merge-base --is-ancestor` whose exit code is a verdict).
pub async fn run_git_output_background(args: &[&str], cwd: &Path) -> Result<Output, AppError> {
    let args = prepend_no_optional_locks(args);
    output_background(&args, cwd, BACKGROUND_GIT_TIMEOUT).await
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
    let output = output_background(&args, cwd, BACKGROUND_GIT_TIMEOUT).await?;
    if output.status.success() {
        return Ok(Some(bytes_to_string_lossy(output.stdout)));
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
    run_checked_background(&args, cwd).await
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
    run_checked_background(&args, cwd).await
}

/// Whether `HEAD` is the unborn branch of a repository with no commit yet,
/// proven rather than inferred from a failed lookup: `rev-parse --verify
/// --quiet HEAD` exits 1 without a word both for an unborn branch and for a
/// branch whose ref file holds garbage. Unborn means `HEAD` is a symbolic ref
/// to a branch that does not exist at all; a branch ref that exists but cannot
/// be read is reported by `for-each-ref` ("ignoring broken ref") and is not.
/// Callers ask only once `HEAD` failed to resolve.
pub async fn head_is_unborn(cwd: &Path) -> Result<bool, AppError> {
    let Some(target) = run_git_probe_background(&["symbolic-ref", "--quiet", "HEAD"], cwd).await?
    else {
        // A detached `HEAD` always names an object, broken or not.
        return Ok(false);
    };
    let target = target.trim();
    validate_positionals(&[target])?;
    let args = prepend_no_optional_locks(&["for-each-ref", "--format=%(refname)", target]);
    let output = output_background(&args, cwd, BACKGROUND_GIT_TIMEOUT).await?;
    if !output.status.success() {
        return Err(git_failure(&args, &String::from_utf8_lossy(&output.stderr)));
    }
    Ok(output.stdout.trim_ascii().is_empty() && output.stderr.trim_ascii().is_empty())
}

/// Whether `HEAD` names a commit: `false` only for a proven unborn branch (see
/// [`head_is_unborn`]); a `HEAD` that resolves to nothing for any other reason
/// is an error.
pub async fn head_commit_exists(cwd: &Path) -> Result<bool, AppError> {
    if git_ref_resolves_background("HEAD", cwd).await? {
        return Ok(true);
    }
    if head_is_unborn(cwd).await? {
        return Ok(false);
    }
    Err(AppError::git_rejected(
        "HEAD does not name a commit: the branch it points to cannot be read",
    ))
}

async fn run_checked_background(args: &[&str], cwd: &Path) -> Result<String, AppError> {
    let output = output_background(args, cwd, BACKGROUND_GIT_TIMEOUT).await?;
    if !output.status.success() {
        return Err(git_failure(args, &String::from_utf8_lossy(&output.stderr)));
    }
    Ok(bytes_to_string_lossy(output.stdout))
}

/// Read-only / observational Git command that terminates its child if the
/// caller's future is dropped or times out.
pub(super) fn background_git_command() -> tokio::process::Command {
    let mut command = git_command();
    command.kill_on_drop(true);
    command
}

async fn output_background(
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<Output, AppError> {
    let future = background_git_command()
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output();
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| timeout_error(args, timeout))?
        .map_err(|error| AppError::git_command(format!("Failed to spawn git: {error}")))
}

fn timeout_error(args: &[&str], timeout: Duration) -> AppError {
    AppError::git_command(format!(
        "git {} timed out after {} seconds",
        redact_paths(&args.join(" ")),
        timeout.as_secs()
    ))
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

    fn git(args: &[&str], cwd: &Path) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    /// An unborn branch is proven; a branch ref holding garbage reads exactly
    /// like one to `rev-parse --verify --quiet HEAD` and must not pass for it.
    #[tokio::test]
    async fn an_unborn_branch_is_proven_not_inferred_from_a_failed_lookup() {
        let repo = tempfile::tempdir().unwrap();
        git(&["init", "-q"], repo.path());
        git(&["symbolic-ref", "HEAD", "refs/heads/topic"], repo.path());
        assert!(head_is_unborn(repo.path()).await.unwrap());
        assert!(!head_commit_exists(repo.path()).await.unwrap());

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
                "i",
            ],
            repo.path(),
        );
        assert!(head_commit_exists(repo.path()).await.unwrap());

        std::fs::write(repo.path().join(".git/refs/heads/topic"), "invalid\n").unwrap();
        assert!(!git_ref_resolves_background("HEAD", repo.path())
            .await
            .unwrap());
        assert!(!matches!(head_is_unborn(repo.path()).await, Ok(true)));
        assert!(head_commit_exists(repo.path()).await.is_err());
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

    #[tokio::test]
    async fn background_git_command_kills_child_on_drop() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let repo = tempfile::tempdir().unwrap();
        git(&["init", "-q", "-b", "main"], repo.path());
        git(
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "seed",
            ],
            repo.path(),
        );

        let mut child = background_git_command()
            .args(["cat-file", "--batch-check=%(objectname)"])
            .current_dir(repo.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        drop(child);

        // The child was killed on drop, so writing may hit EPIPE and stdout yields EOF.
        let _write = stdin.write_all(b"HEAD\n").await;
        drop(stdin);
        let mut out = Vec::new();
        stdout.read_to_end(&mut out).await.unwrap();
        assert!(
            out.is_empty(),
            "background child should be killed on drop, got {:?}",
            String::from_utf8_lossy(&out)
        );
    }
}
