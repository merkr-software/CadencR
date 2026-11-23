use std::ops::ControlFlow;
use std::path::Path;

use crate::error::AppError;

use super::super::{git_failure, safe_path_args, safe_ref_args, validate_positionals};
use super::child::{capture, stream_stdout, Captured};
use super::{prepend_no_optional_locks, GitReadDeadline};

/// Outcome of a bounded read-only Git capture.
#[derive(Debug, PartialEq, Eq)]
pub enum BoundedGitOutput {
    Bytes(Vec<u8>),
    ExceededLimit,
}

/// Run a read-only Git command with `--no-optional-locks`, feeding `stdin_bytes`
/// under [`GitReadDeadline::Scan`].
pub async fn run_git_background_with_stdin(
    args: &[&str],
    cwd: &Path,
    stdin_bytes: &[u8],
) -> Result<String, AppError> {
    let args = prepend_no_optional_locks(args);
    super::run_checked_background_with_stdin(&args, cwd, Some(stdin_bytes), GitReadDeadline::Scan)
        .await
}

/// Run a read-only Git command with `--no-optional-locks`, capturing at most
/// `max_bytes` of output under [`GitReadDeadline::Scan`].
pub async fn run_git_background_bounded(
    args: &[&str],
    cwd: &Path,
    max_bytes: usize,
) -> Result<BoundedGitOutput, AppError> {
    let args = prepend_no_optional_locks(args);
    run_bounded_background(&args, cwd, max_bytes).await
}

/// Read-only bounded counterpart to `run_git_safe_background`.
pub async fn run_git_safe_background_bounded(
    subcommand_args: &[&str],
    flags: &[&str],
    positionals: &[&str],
    cwd: &Path,
    max_bytes: usize,
) -> Result<BoundedGitOutput, AppError> {
    validate_positionals(positionals)?;
    let safe_args = safe_path_args(subcommand_args, flags, positionals);
    let args = prepend_no_optional_locks(&safe_args);
    run_bounded_background(&args, cwd, max_bytes).await
}

/// Read-only bounded counterpart to `run_git_safe_refs_background`.
pub async fn run_git_safe_refs_background_bounded(
    subcommand_args: &[&str],
    flags: &[&str],
    positionals: &[&str],
    cwd: &Path,
    max_bytes: usize,
) -> Result<BoundedGitOutput, AppError> {
    validate_positionals(positionals)?;
    let safe_args = safe_ref_args(subcommand_args, flags, positionals);
    let args = prepend_no_optional_locks(&safe_args);
    run_bounded_background(&args, cwd, max_bytes).await
}

/// Read at most `max_bytes` from stdout of a read-only Git command with
/// `--no-optional-locks`, terminating the child as soon as the prefix is read.
/// Used to sniff binary markers on large blobs without loading the whole blob.
pub async fn run_git_background_head_bytes(
    args: &[&str],
    cwd: &Path,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    let mut head = Vec::with_capacity(max_bytes);
    run_git_background_stream(args, cwd, max_bytes, |chunk| {
        head.extend_from_slice(chunk);
        ControlFlow::Continue(())
    })
    .await?;
    Ok(head)
}

/// Hand at most `max_bytes` of a read-only Git command's stdout to `on_chunk`
/// as it arrives, without holding it in memory. Git (and what it started) is
/// killed as soon as `on_chunk` breaks or `max_bytes` were read; a Git that
/// reached the end of its output must exit successfully. Bound by
/// [`GitReadDeadline::Scan`].
pub async fn run_git_background_stream(
    args: &[&str],
    cwd: &Path,
    max_bytes: usize,
    on_chunk: impl FnMut(&[u8]) -> ControlFlow<()>,
) -> Result<(), AppError> {
    let args = prepend_no_optional_locks(args);
    let deadline = GitReadDeadline::Scan.limit();
    stream_stdout(&args, cwd, max_bytes, deadline, on_chunk).await
}

async fn run_bounded_background(
    args: &[&str],
    cwd: &Path,
    max_bytes: usize,
) -> Result<BoundedGitOutput, AppError> {
    match capture(args, cwd, None, max_bytes, GitReadDeadline::Scan.limit()).await? {
        Captured::Output(output) if output.status.success() => {
            Ok(BoundedGitOutput::Bytes(output.stdout))
        }
        Captured::Output(output) => {
            Err(git_failure(args, &String::from_utf8_lossy(&output.stderr)))
        }
        Captured::StdoutExceeded => Ok(BoundedGitOutput::ExceededLimit),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(dir: &Path) {
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
        ] {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        }
    }

    #[tokio::test]
    async fn bounded_capture_reports_limit_exceeded_without_failing() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("big.txt"), "a".repeat(16 * 1024)).unwrap();
        let status = std::process::Command::new("git")
            .args(["add", "big.txt"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(status.success());
        let status = std::process::Command::new("git")
            .args(["commit", "-qm", "big"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(status.success());

        let outcome = run_git_background_bounded(&["show", "HEAD:big.txt"], dir.path(), 4096)
            .await
            .unwrap();
        assert_eq!(outcome, BoundedGitOutput::ExceededLimit);

        let head =
            run_git_background_head_bytes(&["cat-file", "blob", "HEAD:big.txt"], dir.path(), 64)
                .await
                .unwrap();
        assert_eq!(head.len(), 64);
        assert!(head.iter().all(|&b| b == b'a'));
    }

    #[tokio::test]
    async fn a_stream_stops_early_and_still_reports_a_failed_git() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("big.txt"), "b".repeat(200 * 1024)).unwrap();
        for args in [&["add", "big.txt"][..], &["commit", "-qm", "big"]] {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .status()
                .unwrap();
            assert!(status.success());
        }
        let mut seen = 0;
        run_git_background_stream(
            &["cat-file", "blob", "HEAD:big.txt"],
            dir.path(),
            usize::MAX,
            |chunk| {
                seen += chunk.len();
                ControlFlow::Break(())
            },
        )
        .await
        .unwrap();
        assert!(seen > 0 && seen < 200 * 1024, "{seen}");

        let error = run_git_background_stream(
            &["cat-file", "blob", "HEAD:absent.txt"],
            dir.path(),
            usize::MAX,
            |_| ControlFlow::Continue(()),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::GitRejected(_)), "{error:?}");
    }
}
