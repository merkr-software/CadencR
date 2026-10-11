use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::Command;

use crate::error::AppError;

mod reference;
pub use reference::git_ref_resolves_readonly;

const MAX_OUTPUT_BYTES: u64 = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(3);

pub async fn run_git_readonly_bounded(args: &[&str], cwd: &Path) -> Result<String, AppError> {
    run_with_timeout(args, cwd, TIMEOUT).await
}

async fn run_with_timeout(
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<String, AppError> {
    let bytes = run_with_input()
        .args(args)
        .cwd(cwd)
        .timeout(timeout)
        .call()
        .await?;
    String::from_utf8(bytes)
        .map(|value| value.trim().to_string())
        .map_err(|_| failure("Git returned non-UTF-8 output"))
}

#[bon::builder]
async fn run_with_input(
    args: &[&str],
    cwd: &Path,
    #[builder(default = TIMEOUT)] timeout: Duration,
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, AppError> {
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_GLOBAL")
        .env_remove("GIT_CONFIG_SYSTEM")
        .env_remove("GIT_EXEC_PATH")
        .env_remove("GIT_GRAFT_FILE")
        .env_remove("GIT_NAMESPACE")
        .env_remove("GIT_REPLACE_REF_BASE")
        .env_remove("GIT_SHALLOW_FILE")
        .env_remove("GIT_TEMPLATE_DIR")
        .current_dir(cwd)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if stdin.is_some() {
        // The protocol denylist also protects Git versions predating NO_LAZY_FETCH.
        command
            .stdin(std::process::Stdio::piped())
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_ALLOW_PROTOCOL", "");
    }
    let mut child = command
        .spawn()
        .map_err(|error| failure(format!("cannot start Git: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failure("cannot capture Git stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| failure("cannot capture Git stderr"))?;
    let stdin_pipe = child.stdin.take();
    let collect = async move {
        let mut stdout = stdout;
        let mut stderr = stderr;
        let (stdin_result, stdout_result, stderr_result, status_result) = tokio::join!(
            async {
                if let (Some(mut pipe), Some(bytes)) = (stdin_pipe, stdin) {
                    pipe.write_all(bytes).await?;
                }
                Ok::<(), std::io::Error>(())
            },
            collect_bounded(&mut stdout),
            collect_bounded(&mut stderr),
            child.wait(),
        );
        stdin_result.map_err(|error| failure(format!("cannot write Git stdin: {error}")))?;
        let (stdout_bytes, stdout_too_large) =
            stdout_result.map_err(|error| failure(format!("cannot read Git stdout: {error}")))?;
        let (_, stderr_too_large) =
            stderr_result.map_err(|error| failure(format!("cannot read Git stderr: {error}")))?;
        let status =
            status_result.map_err(|error| failure(format!("cannot wait for Git: {error}")))?;
        if stdout_too_large || stderr_too_large {
            return Err(failure("Git output exceeded 64 KiB"));
        }
        if !status.success() {
            return Err(failure("Git repository inspection failed"));
        }
        Ok(stdout_bytes)
    };
    tokio::time::timeout(timeout, collect)
        .await
        .map_err(|_| failure("Git repository inspection timed out"))?
}

async fn collect_bounded<R: tokio::io::AsyncRead + Unpin>(
    stream: &mut R,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut kept = Vec::new();
    let mut too_large = false;
    let mut chunk = [0_u8; 8192];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok((kept, too_large));
        }
        let remaining = (MAX_OUTPUT_BYTES as usize).saturating_sub(kept.len());
        kept.extend_from_slice(&chunk[..read.min(remaining)]);
        too_large |= read > remaining;
    }
}

fn failure(message: impl Into<String>) -> AppError {
    AppError::BadRequest(message.into())
}

#[cfg(test)]
mod tests {
    use std::process::Command as StdCommand;

    use super::*;

    pub(super) fn git(root: &Path, args: &[&str]) {
        assert!(StdCommand::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .unwrap()
            .success());
    }

    pub(super) fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        std::fs::write(dir.path().join("tracked"), "content").unwrap();
        git(dir.path(), &["add", "tracked"]);
        git(
            dir.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-qm",
                "initial",
            ],
        );
        dir
    }

    #[tokio::test]
    async fn reads_clean_repository_and_rejects_git_failure() {
        let repo = repository();
        assert_eq!(
            run_git_readonly_bounded(&["status", "--porcelain"], repo.path())
                .await
                .unwrap(),
            ""
        );
        assert!(
            run_git_readonly_bounded(&["rev-parse", "--verify", "missing"], repo.path())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rejects_output_larger_than_the_bound() {
        let repo = repository();
        std::fs::write(repo.path().join("large"), vec![b'x'; 64 * 1024 + 1]).unwrap();
        git(repo.path(), &["add", "large"]);
        git(
            repo.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-qm",
                "large",
            ],
        );
        assert!(
            run_git_readonly_bounded(&["show", "HEAD:large"], repo.path())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn bounded_collector_drains_overflow_without_retaining_it() {
        let bytes = vec![b'x'; MAX_OUTPUT_BYTES as usize + 19];
        let mut stream = bytes.as_slice();
        let (kept, too_large) = collect_bounded(&mut stream).await.unwrap();
        assert_eq!(kept.len(), MAX_OUTPUT_BYTES as usize);
        assert!(too_large);
        assert!(stream.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdin_runner_timeout_covers_pipes_inherited_by_a_descendant() {
        let repo = repository();
        git(
            repo.path(),
            &["config", "alias.hold-pipe", "!sh -c 'sleep 1 &'"],
        );
        let started = std::time::Instant::now();
        let error = run_with_input()
            .args(&["hold-pipe"])
            .cwd(repo.path())
            .stdin(b"HEAD\n".as_slice())
            .timeout(Duration::from_millis(100))
            .call()
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_covers_pipes_inherited_by_a_descendant() {
        let repo = repository();
        git(
            repo.path(),
            &["config", "alias.hold-pipe", "!sh -c 'sleep 1 &'"],
        );
        let started = std::time::Instant::now();
        assert!(
            run_with_timeout(&["hold-pipe"], repo.path(), Duration::from_millis(100))
                .await
                .is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
