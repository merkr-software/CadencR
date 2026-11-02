//! Run a one-shot command with a hard timeout and a bounded output capture, so
//! a hung or chatty program can neither stall nor flood the service.

use std::process::Output;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// Failure fragment; callers prefix it with the command they ran, e.g.
/// "provider model discovery " + "timed out after 10 seconds".
#[derive(Debug, Clone)]
pub struct BoundedCommandError(String);

impl BoundedCommandError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for BoundedCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for BoundedCommandError {}

/// What to do when a stream outgrows [`MAX_OUTPUT_BYTES`].
#[derive(Clone, Copy)]
enum Overflow {
    /// Kill the command and fail past this many bytes: the caller needs the
    /// whole output.
    Fail(usize),
    /// Keep only the last [`MAX_OUTPUT_BYTES`]: the caller shows the end.
    KeepTail,
}

/// Spawn `command` (stdout and stderr must be piped) and collect its output.
/// The child is killed on timeout or when either stream exceeds 1 MiB.
///
/// The child leads its own process group and the whole group is killed: a
/// command run through `sh -c` is usually a launcher, and killing only the
/// shell would leave the test runner or installer it started running.
pub async fn capture_bounded(
    command: tokio::process::Command,
    timeout: Duration,
) -> Result<Output, BoundedCommandError> {
    capture(command, timeout, Overflow::Fail(MAX_OUTPUT_BYTES)).await
}

/// [`capture_bounded`] for a command whose complete output is legitimately
/// larger than 1 MiB, like a CLI printing its whole plugin catalog as JSON.
pub async fn capture_bounded_up_to(
    command: tokio::process::Command,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Output, BoundedCommandError> {
    capture(command, timeout, Overflow::Fail(max_bytes)).await
}

/// [`capture_bounded`] for output that is only read from the end, like a
/// failing test run: a stream past 1 MiB keeps its last 1 MiB instead of
/// failing the command.
pub async fn capture_tail(
    command: tokio::process::Command,
    timeout: Duration,
) -> Result<Output, BoundedCommandError> {
    capture(command, timeout, Overflow::KeepTail).await
}

async fn capture(
    mut command: tokio::process::Command,
    timeout: Duration,
    overflow: Overflow,
) -> Result<Output, BoundedCommandError> {
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| BoundedCommandError::new(format!("could not start: {error}")))?;
    // `wait` clears the child's id when a launcher exits before its descendants.
    #[cfg(unix)]
    let process_group = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| BoundedCommandError::new("stdout was unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| BoundedCommandError::new("stderr was unavailable"))?;
    let mut stdout_task = tokio::spawn(read_bounded(stdout, overflow));
    let mut stderr_task = tokio::spawn(read_bounded(stderr, overflow));

    let capture = async {
        let wait = async {
            child
                .wait()
                .await
                .map_err(|error| BoundedCommandError::new(format!("failed to wait: {error}")))
        };
        let stdout = async {
            (&mut stdout_task).await.map_err(|error| {
                BoundedCommandError::new(format!("stdout reader failed: {error}"))
            })?
        };
        let stderr = async {
            (&mut stderr_task).await.map_err(|error| {
                BoundedCommandError::new(format!("stderr reader failed: {error}"))
            })?
        };
        tokio::try_join!(wait, stdout, stderr)
    };
    let error = match tokio::time::timeout(timeout, capture).await {
        Ok(Ok((status, stdout, stderr))) => {
            return Ok(Output {
                status,
                stdout,
                stderr,
            })
        }
        Ok(Err(error)) => error,
        Err(_) => {
            let seconds = timeout.as_secs();
            let unit = if seconds == 1 { "second" } else { "seconds" };
            BoundedCommandError::new(format!("timed out after {seconds} {unit}"))
        }
    };
    #[cfg(unix)]
    if let Some(pid) = process_group {
        // Safety: a bare kill(2) on the child's own group; ESRCH only means the
        // group is already gone.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    // The child may already have exited; the error being reported is the one
    // that matters.
    let _ = child.kill().await;
    stdout_task.abort();
    stderr_task.abort();
    Err(error)
}

async fn read_bounded(
    mut reader: impl AsyncRead + Unpin,
    overflow: Overflow,
) -> Result<Vec<u8>, BoundedCommandError> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|error| BoundedCommandError::new(format!("could not read output: {error}")))?;
        if count == 0 {
            break;
        }
        if let Overflow::Fail(limit) = overflow {
            if bytes.len().saturating_add(count) > limit {
                return Err(BoundedCommandError::new(format!(
                    "output exceeded {limit} bytes"
                )));
            }
        }
        bytes.extend_from_slice(&buffer[..count]);
        // Trimmed in batches, so a long stream costs amortized O(1) per byte.
        if matches!(overflow, Overflow::KeepTail) && bytes.len() > 2 * MAX_OUTPUT_BYTES {
            bytes.drain(..bytes.len() - MAX_OUTPUT_BYTES);
        }
    }
    if matches!(overflow, Overflow::KeepTail) {
        let excess = bytes.len().saturating_sub(MAX_OUTPUT_BYTES);
        bytes.drain(..excess);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{capture_bounded, capture_tail, read_bounded, Overflow, MAX_OUTPUT_BYTES};
    use std::process::Stdio;
    use std::time::Duration;

    #[tokio::test]
    async fn bounded_reader_rejects_output_immediately_after_the_limit() {
        let bytes = vec![b'x'; MAX_OUTPUT_BYTES + 1];
        let error = read_bounded(
            std::io::Cursor::new(bytes),
            Overflow::Fail(MAX_OUTPUT_BYTES),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("exceeded"));
    }

    #[tokio::test]
    async fn a_tail_capture_keeps_the_end_of_a_long_stream() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "yes x | head -c 3000000; echo END; exit 1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = capture_tail(command, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(output.stdout.len(), MAX_OUTPUT_BYTES);
        assert!(output.stdout.ends_with(b"END\n"));
    }

    #[tokio::test]
    async fn captures_both_streams_and_times_out() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "echo out; echo err >&2"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = capture_bounded(command, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output.stdout, b"out\n");
        assert_eq!(output.stderr, b"err\n");

        let mut slow = tokio::process::Command::new("/bin/sh");
        slow.args(["-c", "sleep 5"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let error = capture_bounded(slow, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_timeout_kills_what_the_shell_started() {
        for launcher_action in ["wait", "exit 0"] {
            let directory = tempfile::tempdir().unwrap();
            let pid_file = directory.path().join("child.pid");
            let mut command = tokio::process::Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    &format!("sleep 30 & echo $! > \"$1\"; {launcher_action}"),
                    "bounded-command-test",
                ])
                .arg(&pid_file)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let error = capture_bounded(command, Duration::from_millis(500))
                .await
                .unwrap_err();
            assert!(error.to_string().contains("timed out"));

            let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            // The orphaned `sleep` is reaped by init asynchronously.
            let mut alive = true;
            for _ in 0..40 {
                alive = unsafe { libc::kill(pid, 0) } == 0;
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if alive {
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
            assert!(
                !alive,
                "the grandchild survived the timeout with launcher action `{launcher_action}`"
            );
        }
    }

    #[tokio::test]
    async fn a_one_second_timeout_reads_in_the_singular() {
        let mut slow = tokio::process::Command::new("/bin/sh");
        slow.args(["-c", "sleep 5"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let error = capture_bounded(slow, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(
            error.to_string().ends_with("timed out after 1 second"),
            "{error}"
        );
    }
}
