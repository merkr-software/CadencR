//! Run a one-shot command with a hard timeout and a bounded output capture, so
//! a hung or chatty program can neither stall nor flood the service.

use crate::shared::discard::cleanup;
use crate::shared::process_group::KillGroupOnDrop;
use std::io::ErrorKind;
use std::process::Output;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

mod streams;
pub(crate) use streams::{feed_capped, read_stream_capped, read_stream_tail};

const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// One of a command's output streams.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoundedCommandErrorKind {
    Other,
    /// The command could not be started.
    Spawn(ErrorKind),
    /// Writing its input failed (other than the command closing it).
    Stdin,
    OutputExceeded(OutputStream),
    TimedOut,
}

/// Failure fragment; callers prefix it with the command they ran, e.g.
/// "provider model discovery " + "timed out after 10 seconds".
#[derive(Debug, Clone)]
pub struct BoundedCommandError {
    message: String,
    kind: BoundedCommandErrorKind,
}

impl BoundedCommandError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::with_kind(message, BoundedCommandErrorKind::Other)
    }

    fn with_kind(message: impl Into<String>, kind: BoundedCommandErrorKind) -> Self {
        Self {
            message: message.into(),
            kind,
        }
    }

    pub fn is_output_exceeded(&self) -> bool {
        self.exceeded_stream().is_some()
    }

    /// The stream that outgrew its limit.
    pub fn exceeded_stream(&self) -> Option<OutputStream> {
        match self.kind {
            BoundedCommandErrorKind::OutputExceeded(stream) => Some(stream),
            _ => None,
        }
    }

    /// The command was killed for outliving its deadline.
    pub fn is_timed_out(&self) -> bool {
        self.kind == BoundedCommandErrorKind::TimedOut
    }

    /// Why the command could not be started, when it could not.
    pub fn spawn_error_kind(&self) -> Option<ErrorKind> {
        match self.kind {
            BoundedCommandErrorKind::Spawn(kind) => Some(kind),
            _ => None,
        }
    }

    /// Writing the command's input failed.
    pub fn is_stdin_failure(&self) -> bool {
        self.kind == BoundedCommandErrorKind::Stdin
    }
}

impl std::fmt::Display for BoundedCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for BoundedCommandError {}

/// What to do when a stream outgrows its limit.
#[derive(Clone, Copy)]
enum Overflow {
    /// Kill the command and fail past this many bytes: the caller needs the
    /// whole output.
    Fail(usize),
    /// Keep only the last [`MAX_OUTPUT_BYTES`]: the caller shows the end.
    KeepTail,
}

/// A command fed `stdin` and read back whole, for [`capture_with_input`].
#[derive(bon::Builder)]
pub(crate) struct InputCapture<'a> {
    timeout: Duration,
    /// Written to the command's piped stdin, which is then closed. A command
    /// that exits without reading all of it is not an error.
    stdin: &'a [u8],
    #[builder(default = MAX_OUTPUT_BYTES)]
    max_stdout_bytes: usize,
    #[builder(default = MAX_OUTPUT_BYTES)]
    max_stderr_bytes: usize,
    /// Expected stdout size, reserved up front.
    #[builder(default)]
    stdout_capacity: usize,
}

/// How [`capture`] feeds and bounds one run.
struct Plan<'a> {
    timeout: Duration,
    stdin: Option<&'a [u8]>,
    stdout: Overflow,
    stderr: Overflow,
    stdout_capacity: usize,
}

impl Plan<'_> {
    fn output(timeout: Duration, overflow: Overflow) -> Self {
        Self {
            timeout,
            stdin: None,
            stdout: overflow,
            stderr: overflow,
            stdout_capacity: 0,
        }
    }
}

/// Spawn `command` (stdout and stderr must be piped) and collect its output.
/// The child is killed on timeout or when either stream exceeds 1 MiB.
///
/// The child leads its own process group and the whole group is killed: a
/// command run through `sh -c` is usually a launcher, and killing only the
/// shell would leave the test runner or installer it started running. The
/// group is killed too when the capture is dropped before it completes (a
/// request handler whose client went away).
pub async fn capture_bounded(
    command: tokio::process::Command,
    timeout: Duration,
) -> Result<Output, BoundedCommandError> {
    capture_bounded_with_spawn(command, timeout, |_| ()).await
}

/// Like bounded capture, with a guard held from successful spawn through
/// output collection and cleanup.
pub(crate) async fn capture_bounded_with_spawn<G>(
    command: tokio::process::Command,
    timeout: Duration,
    register: impl FnOnce(u32) -> G,
) -> Result<Output, BoundedCommandError> {
    let plan = Plan::output(timeout, Overflow::Fail(MAX_OUTPUT_BYTES));
    capture(command, plan, register).await
}

/// [`capture_bounded`] for a command whose complete output is legitimately
/// larger than 1 MiB, like a CLI printing its whole plugin catalog as JSON.
pub async fn capture_bounded_up_to(
    command: tokio::process::Command,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Output, BoundedCommandError> {
    capture(
        command,
        Plan::output(timeout, Overflow::Fail(max_bytes)),
        |_| (),
    )
    .await
}

/// [`capture_bounded`] for output that is only read from the end, like a
/// failing test run: a stream past 1 MiB keeps its last 1 MiB instead of
/// failing the command.
pub async fn capture_tail(
    command: tokio::process::Command,
    timeout: Duration,
) -> Result<Output, BoundedCommandError> {
    capture(command, Plan::output(timeout, Overflow::KeepTail), |_| ()).await
}

/// [`capture_bounded`] for a filter: `input.stdin` goes to the command's
/// stdin (which must be piped), written while its output is read so neither
/// side's pipe buffer can deadlock the other.
pub(crate) async fn capture_with_input(
    command: tokio::process::Command,
    input: InputCapture<'_>,
) -> Result<Output, BoundedCommandError> {
    let plan = Plan {
        timeout: input.timeout,
        stdin: Some(input.stdin),
        stdout: Overflow::Fail(input.max_stdout_bytes),
        stderr: Overflow::Fail(input.max_stderr_bytes),
        stdout_capacity: input.stdout_capacity,
    };
    capture(command, plan, |_| ()).await
}

async fn capture<G>(
    mut command: tokio::process::Command,
    plan: Plan<'_>,
    register: impl FnOnce(u32) -> G,
) -> Result<Output, BoundedCommandError> {
    #[cfg(unix)]
    crate::shared::process_group::lead_new_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| {
        BoundedCommandError::with_kind(
            format!("could not start: {error}"),
            BoundedCommandErrorKind::Spawn(error.kind()),
        )
    })?;
    let _registration = child.id().map(register);
    // `wait` clears the child's id when a launcher exits before its
    // descendants, so the group is known from here on.
    let mut group = KillGroupOnDrop::new(child.id());
    let stdin = match plan.stdin {
        Some(bytes) => Some((
            child.stdin.take().ok_or_else(|| {
                BoundedCommandError::with_kind(
                    "stdin was unavailable",
                    BoundedCommandErrorKind::Stdin,
                )
            })?,
            bytes,
        )),
        None => None,
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| BoundedCommandError::new("stdout was unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| BoundedCommandError::new("stderr was unavailable"))?;

    let capture = async {
        let wait = async {
            child
                .wait()
                .await
                .map_err(|error| BoundedCommandError::new(format!("failed to wait: {error}")))
        };
        let feed = async {
            match stdin {
                Some((pipe, bytes)) => write_input(pipe, bytes).await,
                None => Ok(()),
            }
        };
        let stdout = read_bounded(
            stdout,
            OutputStream::Stdout,
            plan.stdout,
            plan.stdout_capacity,
        );
        let stderr = read_bounded(stderr, OutputStream::Stderr, plan.stderr, 0);
        tokio::try_join!(wait, stdout, stderr, feed)
    };
    let error = match tokio::time::timeout(plan.timeout, capture).await {
        Ok(Ok((status, stdout, stderr, ()))) => {
            group.disarm();
            return Ok(Output {
                status,
                stdout,
                stderr,
            });
        }
        Ok(Err(error)) => error,
        Err(_) => {
            let seconds = plan.timeout.as_secs();
            let unit = if seconds == 1 { "second" } else { "seconds" };
            BoundedCommandError::with_kind(
                format!("timed out after {seconds} {unit}"),
                BoundedCommandErrorKind::TimedOut,
            )
        }
    };
    group.kill();
    // The child may already have exited; the error being reported is the one
    // that matters.
    cleanup(child.kill().await, "kill the timed-out command");
    Err(error)
}

/// Write all of `bytes` and close the pipe. A command may exit without
/// reading its whole input (a formatter rejecting a syntax error): the broken
/// pipe that follows is its exit status's business, not a failure here.
async fn write_input(
    mut pipe: tokio::process::ChildStdin,
    bytes: &[u8],
) -> Result<(), BoundedCommandError> {
    let written = match pipe.write_all(bytes).await {
        Ok(()) => pipe.shutdown().await,
        Err(error) => Err(error),
    };
    match written {
        Err(error) if error.kind() != ErrorKind::BrokenPipe => Err(BoundedCommandError::with_kind(
            format!("could not write its input: {error}"),
            BoundedCommandErrorKind::Stdin,
        )),
        _ => Ok(()),
    }
}

async fn read_bounded(
    mut reader: impl AsyncRead + Unpin,
    stream: OutputStream,
    overflow: Overflow,
    initial_capacity: usize,
) -> Result<Vec<u8>, BoundedCommandError> {
    let initial_capacity = match overflow {
        Overflow::Fail(limit) => initial_capacity.min(limit),
        Overflow::KeepTail => initial_capacity,
    };
    let mut bytes = Vec::with_capacity(initial_capacity);
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
                return Err(BoundedCommandError::with_kind(
                    format!("output exceeded {limit} bytes"),
                    BoundedCommandErrorKind::OutputExceeded(stream),
                ));
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
    use super::{
        capture_bounded, capture_bounded_with_spawn, capture_tail, capture_with_input,
        read_bounded, InputCapture, OutputStream, Overflow, MAX_OUTPUT_BYTES,
    };
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    fn filter(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    #[cfg(unix)]
    use crate::shared::test_processes::{wait_for_published_pid, wait_until_gone, KillOnDrop};

    /// Whether the process group `pgid` leads still holds a live process,
    /// once its killed members had up to 10 s to go.
    #[cfg(unix)]
    async fn group_survives(pgid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while crate::shared::process_group::process_group_alive(pgid) {
            if Instant::now() > deadline {
                crate::shared::process_group::signal_process_group(pgid, libc::SIGKILL).unwrap();
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    #[tokio::test]
    async fn bounded_reader_rejects_output_immediately_after_the_limit() {
        let bytes = vec![b'x'; MAX_OUTPUT_BYTES + 1];
        let error = read_bounded(
            std::io::Cursor::new(bytes),
            OutputStream::Stderr,
            Overflow::Fail(MAX_OUTPUT_BYTES),
            0,
        )
        .await
        .unwrap_err();
        assert!(error.is_output_exceeded());
        assert_eq!(error.exceeded_stream(), Some(OutputStream::Stderr));
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
        assert!(!error.is_output_exceeded());
        assert!(error.is_timed_out());
        assert!(error.to_string().contains("timed out"));
    }

    /// Judged on the whole process group, known from spawn, rather than on
    /// a pid the shell may not have written yet when the timeout fires.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_timeout_kills_what_the_shell_started() {
        for launcher_action in ["wait", "exit 0"] {
            let mut command = tokio::process::Command::new("/bin/sh");
            command
                .args(["-c", &format!("sleep 30 & {launcher_action}")])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let (pgid_tx, pgid_rx) = std::sync::mpsc::channel();
            let error = capture_bounded_with_spawn(command, Duration::from_millis(500), |pid| {
                pgid_tx.send(pid).unwrap()
            })
            .await
            .unwrap_err();
            assert!(error.is_timed_out(), "{error}");
            let pgid = pgid_rx.recv().unwrap();
            assert!(
                !group_survives(pgid).await,
                "the group survived the timeout with launcher action `{launcher_action}`"
            );
        }
    }

    /// A request handler dropped mid-run (its client went away) used to leave
    /// the shell's children running: `kill_on_drop` reaches only the leader.
    /// Judged on the grandchild, which init reaps (the dropped leader is
    /// reaped by this runtime whenever it gets to it).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_dropped_capture_kills_the_whole_group() {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("ready");
        let script = format!("sleep 30 & echo $! > '{}'; wait", ready.display());
        let run =
            tokio::spawn(
                async move { capture_bounded(filter(&script), Duration::from_secs(60)).await },
            );
        let _cleanup = KillOnDrop::default().group_of_pid_in(&ready);
        let grandchild = wait_for_published_pid(&ready, Duration::from_secs(20))
            .await
            .expect("the shell never started its child");
        run.abort();
        assert!(run.await.unwrap_err().is_cancelled());
        assert!(
            wait_until_gone(grandchild, Duration::from_secs(10)).await,
            "the shell's child outlived the dropped capture"
        );
    }

    /// 256 KiB exceeds macOS and Linux pipe buffers: writing all of stdin
    /// before reading stdout would deadlock.
    #[tokio::test]
    async fn input_is_streamed_while_output_is_read() {
        let payload = "0123456789abcdef\n".repeat(16 * 1024);
        let input = InputCapture::builder()
            .timeout(Duration::from_secs(10))
            .stdin(payload.as_bytes())
            .stdout_capacity(payload.len())
            .build();
        let output = capture_with_input(filter("cat"), input).await.unwrap();
        assert_eq!(output.stdout, payload.as_bytes());
    }

    #[tokio::test]
    async fn a_command_that_ignores_its_input_is_not_a_write_failure() {
        let input = InputCapture::builder()
            .timeout(Duration::from_secs(10))
            .stdin(&[b'x'; 256 * 1024])
            .build();
        let output = capture_with_input(filter("echo bad >&2; exit 2"), input)
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert_eq!(output.stderr, b"bad\n");
    }

    #[tokio::test]
    async fn limits_name_the_stream_and_spawn_errors_keep_their_kind() {
        let input = InputCapture::builder()
            .timeout(Duration::from_secs(10))
            .stdin(&[b'a'; 2048])
            .max_stdout_bytes(1024)
            .build();
        let error = capture_with_input(filter("cat"), input).await.unwrap_err();
        assert_eq!(error.exceeded_stream(), Some(OutputStream::Stdout));

        let mut missing = tokio::process::Command::new("/nonexistent/cadencr-bounded-command");
        missing.stdout(Stdio::piped()).stderr(Stdio::piped());
        let error = capture_bounded(missing, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(error.spawn_error_kind(), Some(std::io::ErrorKind::NotFound));
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

    #[tokio::test]
    async fn feeding_reports_whether_the_end_was_reached() {
        use std::ops::ControlFlow;

        let bytes = vec![b'x'; 200_000];
        let mut seen = 0;
        let complete = super::feed_capped(std::io::Cursor::new(&bytes), usize::MAX, |chunk| {
            seen += chunk.len();
            ControlFlow::Continue(())
        })
        .await
        .unwrap();
        assert!(complete);
        assert_eq!(seen, bytes.len());

        seen = 0;
        let capped = super::feed_capped(std::io::Cursor::new(&bytes), 100_000, |chunk| {
            seen += chunk.len();
            ControlFlow::Continue(())
        })
        .await
        .unwrap();
        assert!(!capped);
        assert_eq!(seen, 100_000);

        let stopped = super::feed_capped(std::io::Cursor::new(&bytes), usize::MAX, |_| {
            ControlFlow::Break(())
        })
        .await
        .unwrap();
        assert!(!stopped);
    }

    #[tokio::test]
    async fn a_stream_tail_keeps_the_last_mebibyte() {
        let mut bytes = vec![b'x'; 3 * MAX_OUTPUT_BYTES];
        bytes.extend_from_slice(b"END");
        let tail = super::read_stream_tail(std::io::Cursor::new(bytes))
            .await
            .unwrap();
        assert_eq!(tail.len(), MAX_OUTPUT_BYTES);
        assert!(tail.ends_with(b"END"));
    }
}
