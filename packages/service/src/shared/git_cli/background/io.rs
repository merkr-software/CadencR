use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use crate::error::AppError;
use crate::shared::bounded_command::capture_bounded_up_to;
use crate::shared::discard::cleanup;

use super::super::redact::redact_paths;
use super::super::{
    bytes_to_string_lossy, git_failure, safe_path_args, safe_ref_args, validate_positionals,
};
use super::{
    background_git_command, prepend_no_optional_locks, timeout_error, BACKGROUND_GIT_TIMEOUT,
};

/// Outcome of a bounded read-only Git capture.
#[derive(Debug, PartialEq, Eq)]
pub enum BoundedGitOutput {
    Bytes(Vec<u8>),
    ExceededLimit,
}

/// Run a read-only Git command with `--no-optional-locks`, feeding `stdin_bytes`
/// and enforcing [`BACKGROUND_GIT_TIMEOUT`].
pub async fn run_git_background_with_stdin(
    args: &[&str],
    cwd: &Path,
    stdin_bytes: &[u8],
) -> Result<String, AppError> {
    let args = prepend_no_optional_locks(args);
    output_background_with_stdin(&args, cwd, stdin_bytes, BACKGROUND_GIT_TIMEOUT).await
}

/// Run a read-only Git command with `--no-optional-locks`, capturing at most
/// `max_bytes` of output within [`BACKGROUND_GIT_TIMEOUT`].
pub async fn run_git_background_bounded(
    args: &[&str],
    cwd: &Path,
    max_bytes: usize,
) -> Result<BoundedGitOutput, AppError> {
    let args = prepend_no_optional_locks(args);
    run_bounded_background(&args, cwd, max_bytes, BACKGROUND_GIT_TIMEOUT).await
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
    run_bounded_background(&args, cwd, max_bytes, BACKGROUND_GIT_TIMEOUT).await
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
    run_bounded_background(&args, cwd, max_bytes, BACKGROUND_GIT_TIMEOUT).await
}

/// Read at most `max_bytes` from stdout of a read-only Git command with
/// `--no-optional-locks`, terminating the child as soon as the prefix is read.
/// Used to sniff binary markers on large blobs without loading the whole blob.
pub async fn run_git_background_head_bytes(
    args: &[&str],
    cwd: &Path,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    let args = prepend_no_optional_locks(args);
    let mut command = background_git_command();
    command
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| AppError::git_command(format!("Failed to spawn git: {error}")))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::git_command("Failed to capture git stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::git_command("Failed to capture git stderr"))?;

    let read_head = async {
        let mut buf = vec![0u8; max_bytes];
        let mut filled = 0;
        while filled < max_bytes {
            let count = stdout.read(&mut buf[filled..]).await.map_err(|error| {
                AppError::git_command(format!("Failed to read git stdout: {error}"))
            })?;
            if count == 0 {
                break;
            }
            filled += count;
        }
        buf.truncate(filled);
        if filled == max_bytes {
            drop(stdout);
            cleanup(child.kill().await, "stop git blob head probe");
            return Ok(buf);
        }
        let mut stderr_bytes = Vec::new();
        let (stderr_res, status_res) =
            tokio::join!(stderr.read_to_end(&mut stderr_bytes), child.wait());
        stderr_res.map_err(|error| {
            AppError::git_command(format!("Failed to read git stderr: {error}"))
        })?;
        let status = status_res
            .map_err(|error| AppError::git_command(format!("Failed to wait for git: {error}")))?;
        if !status.success() {
            return Err(git_failure(&args, &String::from_utf8_lossy(&stderr_bytes)));
        }
        Ok(buf)
    };

    tokio::time::timeout(BACKGROUND_GIT_TIMEOUT, read_head)
        .await
        .map_err(|_| timeout_error(&args, BACKGROUND_GIT_TIMEOUT))?
}

async fn output_background_with_stdin(
    args: &[&str],
    cwd: &Path,
    stdin_bytes: &[u8],
    timeout: Duration,
) -> Result<String, AppError> {
    let mut command = background_git_command();
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| AppError::git_command(format!("Failed to spawn git: {error}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::git_command("Failed to open git stdin"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::git_command("Failed to capture git stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::git_command("Failed to capture git stderr"))?;

    let collect = async {
        let write_stdin = async {
            let write = stdin.write_all(stdin_bytes).await;
            let shutdown = stdin.shutdown().await;
            drop(stdin);
            write.and(shutdown)
        };
        let mut stdout_bytes = Vec::new();
        let mut stderr_bytes = Vec::new();
        let (stdin_res, stdout_res, stderr_res, status_res) = tokio::join!(
            write_stdin,
            stdout.read_to_end(&mut stdout_bytes),
            stderr.read_to_end(&mut stderr_bytes),
            child.wait(),
        );
        let status = status_res
            .map_err(|error| AppError::git_command(format!("Failed to wait for git: {error}")))?;
        stderr_res.map_err(|error| {
            AppError::git_command(format!("Failed to read git stderr: {error}"))
        })?;
        if !status.success() {
            return Err(git_failure(args, &String::from_utf8_lossy(&stderr_bytes)));
        }
        stdin_res.map_err(|error| {
            AppError::git_command(format!("Failed to write git stdin: {error}"))
        })?;
        stdout_res.map_err(|error| {
            AppError::git_command(format!("Failed to read git stdout: {error}"))
        })?;
        Ok(bytes_to_string_lossy(stdout_bytes))
    };

    tokio::time::timeout(timeout, collect)
        .await
        .map_err(|_| timeout_error(args, timeout))?
}

async fn run_bounded_background(
    args: &[&str],
    cwd: &Path,
    max_bytes: usize,
    timeout: Duration,
) -> Result<BoundedGitOutput, AppError> {
    let mut command = background_git_command();
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match capture_bounded_up_to(command, timeout, max_bytes).await {
        Ok(output) => {
            if !output.status.success() {
                return Err(git_failure(args, &String::from_utf8_lossy(&output.stderr)));
            }
            Ok(BoundedGitOutput::Bytes(output.stdout))
        }
        Err(error) if error.is_output_exceeded() => Ok(BoundedGitOutput::ExceededLimit),
        Err(error) => Err(AppError::git_command(format!(
            "git {} failed: {error}",
            redact_paths(&args.join(" "))
        ))),
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

    #[cfg(unix)]
    #[tokio::test]
    async fn background_timeout_aborts_stuck_git_alias() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let status = std::process::Command::new("git")
            .args(["config", "alias.stall", "!sleep 10"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(status.success());

        let error = super::super::output_background(
            &["--no-optional-locks", "stall"],
            dir.path(),
            Duration::from_millis(150),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
    }
}
