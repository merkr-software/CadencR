//! The one spawner behind every background (read-only) Git call.
//!
//! Git rarely runs alone: an alias, a hook, a `textconv` driver or an
//! `fsmonitor` hook runs as its child. Each background Git therefore leads
//! its own process group, and a call that is abandoned — its deadline passed,
//! its output outgrew the cap, or its caller dropped the future — SIGKILLs
//! the whole group, not only `git`. A call that ran to completion leaves the
//! group alone, so a daemon Git started on purpose (`fsmonitor--daemon`)
//! survives the command that started it.
//!
//! Git is reaped only once its output pipes reached their end: until then an
//! abandoned leader stays a zombie that holds the group id, so the group kill
//! can never reach an unrelated group that reused it.

use std::ops::ControlFlow;
use std::path::Path;
use std::process::{ExitStatus, Output, Stdio};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWriteExt as _};
use tokio::process::{Child, ChildStderr};

use crate::error::AppError;
use crate::shared::bounded_command::{feed_capped, read_stream_capped, read_stream_tail};
use crate::shared::process_group::KillGroupOnDrop;

use super::super::{git_command, git_failure};
use super::timeout_error;

/// What a capture whose stdout has a cap produced.
pub(super) enum Captured {
    Output(Output),
    StdoutExceeded,
}

/// Read-only / observational Git command whose child dies with its caller's
/// future (`kill_on_drop`).
pub(super) fn background_git_command() -> tokio::process::Command {
    let mut command = git_command();
    command.kill_on_drop(true);
    command
}

fn spawn(
    args: &[&str],
    cwd: &Path,
    piped_stdin: bool,
) -> Result<(Child, KillGroupOnDrop), AppError> {
    let mut command = background_git_command();
    if let Some(env) = crate::shared::git_cli::linked_checkout_env(cwd)? {
        command.envs(env);
    }
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if piped_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    crate::shared::process_group::lead_new_process_group(&mut command);
    let child = command
        .spawn()
        .map_err(|error| AppError::git_command(format!("Failed to spawn git: {error}")))?;
    let group = KillGroupOnDrop::new(child.id());
    Ok((child, group))
}

fn pipe<T>(pipe: Option<T>, name: &str) -> Result<T, AppError> {
    pipe.ok_or_else(|| AppError::git_command(format!("Failed to capture git {name}")))
}

/// Why a capture stopped before Git exited.
enum Stop {
    StdoutExceeded,
    Failed(AppError),
}

async fn read_stdout(reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, Stop> {
    read_stream_capped(reader, limit, 0).await.map_err(|error| {
        if error.is_output_exceeded() {
            Stop::StdoutExceeded
        } else {
            Stop::Failed(AppError::git_command(format!(
                "Failed to read git stdout: {error}"
            )))
        }
    })
}

/// Git's diagnostics: its last 1 MiB, however much it prints.
async fn read_stderr(reader: ChildStderr) -> Result<Vec<u8>, AppError> {
    read_stream_tail(reader)
        .await
        .map_err(|error| AppError::git_command(format!("Failed to read git stderr: {error}")))
}

async fn reap(child: &mut Child, group: &mut KillGroupOnDrop) -> Result<ExitStatus, AppError> {
    let status = child
        .wait()
        .await
        .map_err(|error| AppError::git_command(format!("Failed to wait for git: {error}")))?;
    group.disarm();
    Ok(status)
}

async fn within<T>(
    args: &[&str],
    deadline: Option<Duration>,
    work: impl std::future::Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    match deadline {
        Some(limit) => tokio::time::timeout(limit, work)
            .await
            .map_err(|_| timeout_error(args, limit))?,
        None => work.await,
    }
}

/// Run `git <args>` to completion, feeding `stdin_bytes` and keeping at most
/// `stdout_limit` bytes of stdout. `deadline` is the wall-clock ceiling (none
/// when `None`). A non-zero exit is an [`Output`], for the caller to judge.
pub(super) async fn capture(
    args: &[&str],
    cwd: &Path,
    stdin_bytes: Option<&[u8]>,
    stdout_limit: usize,
    deadline: Option<Duration>,
) -> Result<Captured, AppError> {
    let (mut child, mut group) = spawn(args, cwd, stdin_bytes.is_some())?;
    let stdin = child.stdin.take();
    let stdout = pipe(child.stdout.take(), "stdout")?;
    let stderr = pipe(child.stderr.take(), "stderr")?;
    // Boxed: the read is nested deep inside request futures, whose layout
    // the compiler otherwise computes through every level.
    let work = Box::pin(async {
        // A write error (Git exited without reading everything) is judged
        // after the exit status, which explains it better.
        let write = async {
            Ok::<_, Stop>(match (stdin, stdin_bytes) {
                (Some(mut pipe), Some(bytes)) => {
                    let written = pipe.write_all(bytes).await;
                    written.and(pipe.shutdown().await)
                }
                _ => Ok(()),
            })
        };
        let stderr = async { read_stderr(stderr).await.map_err(Stop::Failed) };
        let (written, stdout, stderr) =
            match tokio::try_join!(write, read_stdout(stdout, stdout_limit), stderr) {
                Ok(parts) => parts,
                Err(Stop::StdoutExceeded) => return Ok(Captured::StdoutExceeded),
                Err(Stop::Failed(error)) => return Err(error),
            };
        let status = reap(&mut child, &mut group).await?;
        if status.success() {
            written.map_err(|error| {
                AppError::git_command(format!("Failed to write git stdin: {error}"))
            })?;
        }
        Ok(Captured::Output(Output {
            status,
            stdout,
            stderr,
        }))
    });
    within(args, deadline, work).await
}

/// [`capture`] without a stdout cap.
pub(super) async fn capture_all(
    args: &[&str],
    cwd: &Path,
    stdin_bytes: Option<&[u8]>,
    deadline: Option<Duration>,
) -> Result<Output, AppError> {
    match capture(args, cwd, stdin_bytes, usize::MAX, deadline).await? {
        Captured::Output(output) => Ok(output),
        // A `Vec` cannot hold more than `usize::MAX` bytes anyway.
        Captured::StdoutExceeded => Err(AppError::internal("an uncapped read exceeded its cap")),
    }
}

/// Hand stdout of `git <args>` to `on_chunk` as it arrives, at most
/// `max_bytes` of it. Git is killed (with its group) as soon as `on_chunk`
/// breaks or the cap is reached; only a Git that reached the end of its
/// output is held to its exit status.
pub(super) async fn stream_stdout(
    args: &[&str],
    cwd: &Path,
    max_bytes: usize,
    deadline: Option<Duration>,
    on_chunk: impl FnMut(&[u8]) -> ControlFlow<()>,
) -> Result<(), AppError> {
    let (mut child, mut group) = spawn(args, cwd, false)?;
    let stdout = pipe(child.stdout.take(), "stdout")?;
    let stderr = pipe(child.stderr.take(), "stderr")?;
    // Boxed: the read is nested deep inside request futures, whose layout
    // the compiler otherwise computes through every level.
    let work = Box::pin(async {
        // Both pipes are drained together, so a chatty stderr cannot stall
        // stdout; an early stop drops the stderr read with the rest.
        let feed = feed_capped(stdout, max_bytes, on_chunk);
        let stderr_read = read_stderr(stderr);
        tokio::pin!(feed, stderr_read);
        let mut stderr = None;
        let complete = loop {
            tokio::select! {
                fed = &mut feed => break fed.map_err(|error| {
                    AppError::git_command(format!("Failed to read git stdout: {error}"))
                })?,
                read = &mut stderr_read, if stderr.is_none() => stderr = Some(read?),
            }
        };
        if !complete {
            return Ok(());
        }
        let stderr = match stderr {
            Some(bytes) => bytes,
            None => stderr_read.await?,
        };
        let status = reap(&mut child, &mut group).await?;
        if !status.success() {
            return Err(git_failure(args, &String::from_utf8_lossy(&stderr)));
        }
        Ok(())
    });
    within(args, deadline, work).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::shared::test_processes::{wait_for_published_pid, KillOnDrop};

    /// A repository whose `stall` alias starts a `sleep` that outlives the
    /// shell, publishing its pid in `sleep.pid`.
    fn repo_with_stalling_alias(launcher_end: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("sleep.pid");
        let partial = dir.path().join("sleep.pid.partial");
        let alias = format!(
            "!sleep 30 & echo $! > '{}' && mv '{}' '{}'; {launcher_end}",
            partial.display(),
            partial.display(),
            pid_file.display()
        );
        for args in [&["init", "-q"][..], &["config", "alias.stall", &alias]] {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        }
        (dir, pid_file)
    }

    /// Init reaps the orphaned `sleep` asynchronously.
    async fn assert_gone(pid: libc::pid_t) {
        for _ in 0..250 {
            // Safety: signal 0 only probes whether the process exists.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the process git started outlived it");
    }

    /// Whatever ends the read — its deadline, or its caller dropping it — the
    /// processes Git started die with it, whether the launcher still waits
    /// for them or already exited (leaving them holding its pipes).
    /// The pid of the `sleep` the alias started, once the read was abandoned
    /// after `wait`: by its deadline, or by its caller dropping it.
    async fn abandon_stalled_read(launcher_end: &str, dropped: bool) {
        let (dir, pid_file) = repo_with_stalling_alias(launcher_end);
        let _cleanup = KillOnDrop::default().group_of_pid_in(&pid_file);
        // Generous: the alias must start its `sleep` first, even under load.
        let wait = Duration::from_secs(3);
        let deadline = (!dropped).then_some(wait);
        let read = capture(&["stall"], dir.path(), None, usize::MAX, deadline);
        if dropped {
            let read = tokio::time::timeout(wait, read).await;
            assert!(read.is_err(), "the alias should still be running");
        } else {
            let error = read.await.err().unwrap();
            assert!(error.to_string().contains("timed out"), "{error}");
        }
        let pid = wait_for_published_pid(&pid_file, Duration::from_secs(10))
            .await
            .expect("the alias published its sleep");
        assert_gone(pid).await;
    }

    /// Whatever ends the read — its deadline, or its caller dropping it — the
    /// processes Git started die with it, whether the launcher still waits
    /// for them or already exited (leaving them holding its pipes).
    #[tokio::test]
    async fn an_abandoned_read_kills_what_git_started() {
        futures::future::join_all(
            [
                ("wait", false),
                ("wait", true),
                ("exit 0", false),
                ("exit 0", true),
            ]
            .map(|(launcher_end, dropped)| abandon_stalled_read(launcher_end, dropped)),
        )
        .await;
    }
}
