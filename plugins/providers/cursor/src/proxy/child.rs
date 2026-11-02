//! The `agent [flags] acp` child process and its JSON-RPC connection.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::mpsc;

use super::rpc::Peer;
use crate::access::AccessMode;

const TERMINATE_GRACE: Duration = Duration::from_secs(2);

/// How to launch Cursor: the resolved binary plus descriptor-provided args,
/// which precede the connector's access flags and the `acp` subcommand.
#[derive(Debug, Clone)]
pub struct Launch {
    pub binary: PathBuf,
    pub extra_args: Vec<OsString>,
}

impl Launch {
    pub fn args(&self, access: AccessMode) -> Vec<OsString> {
        let mut args = self.extra_args.clone();
        args.extend(access.launch_args());
        args
    }
}

pub struct ChildConn {
    pub peer: Peer,
    pub generation: u64,
    process: tokio::sync::Mutex<Option<Child>>,
    pid: Option<u32>,
}

pub struct SpawnedChild {
    pub conn: Arc<ChildConn>,
    pub stdout: ChildStdout,
}

pub fn spawn_child(
    launch: &Launch,
    access: AccessMode,
    generation: u64,
) -> std::io::Result<SpawnedChild> {
    let mut command = Command::new(&launch.binary);
    command
        .args(launch.args(access))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    // Own process group, so shutdown and access restarts reach every process
    // Cursor started. If the connector itself is killed, Cursor sees stdin EOF.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(std::io::Error::other(
            "Cursor Agent stdio pipes were unavailable",
        ));
    };
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(write_lines(stdin, rx, "Cursor Agent"));
    let pid = child.id();
    Ok(SpawnedChild {
        conn: Arc::new(ChildConn {
            peer: Peer::new("Cursor Agent", tx),
            generation,
            process: tokio::sync::Mutex::new(Some(child)),
            pid,
        }),
        stdout,
    })
}

impl ChildConn {
    /// SIGTERM the child's process group, escalate to SIGKILL after a grace
    /// period, and fail whatever was still waiting on it.
    pub async fn terminate(&self) {
        self.peer.close();
        let mut guard = self.process.lock().await;
        if let Some(child) = guard.as_mut() {
            signal_group(self.pid, Signal::Term);
            if tokio::time::timeout(TERMINATE_GRACE, child.wait())
                .await
                .is_err()
            {
                signal_group(self.pid, Signal::Kill);
                if let Err(error) = child.kill().await {
                    eprintln!("cursor connector: could not kill Cursor Agent: {error}");
                }
            }
            // Descendants may outlive a leader that exited on SIGTERM.
            signal_group(self.pid, Signal::Kill);
        }
        guard.take();
        self.peer.fail_all("Cursor Agent was stopped");
    }
}

enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn signal_group(pid: Option<u32>, signal: Signal) {
    let Some(pid) = pid.and_then(|pid| libc::pid_t::try_from(pid).ok()) else {
        return;
    };
    let signal = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // SAFETY: kill(2) with a negative pid signals the process group created
    // for this child (`process_group(0)` makes its pgid equal its pid). It
    // has no memory-safety preconditions; ESRCH just means the group is gone.
    unsafe {
        libc::kill(-pid, signal);
    }
}

#[cfg(not(unix))]
fn signal_group(_pid: Option<u32>, _signal: Signal) {}

/// Write queued frames as newline-delimited JSON until the channel closes.
pub async fn write_lines<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut rx: mpsc::UnboundedReceiver<String>,
    label: &str,
) {
    while let Some(mut line) = rx.recv().await {
        line.push('\n');
        let written = async {
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await
        };
        if let Err(error) = written.await {
            eprintln!("cursor connector: writing to {label} failed: {error}");
            return;
        }
    }
    if let Err(error) = writer.shutdown().await {
        eprintln!("cursor connector: closing {label} failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{spawn_child, Launch};
    use crate::access::AccessMode;
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncBufReadExt, BufReader};

    #[test]
    fn descriptor_args_precede_access_flags() {
        let launch = Launch {
            binary: PathBuf::from("/bin/agent"),
            extra_args: vec![OsString::from("--endpoint"), OsString::from("x")],
        };
        let args = launch.args(AccessMode::FullAccess);
        assert_eq!(args.first().unwrap(), "--endpoint");
        assert_eq!(args.last().unwrap(), "acp");
    }

    #[tokio::test]
    async fn terminate_stops_the_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("agent");
        std::fs::write(&script, "#!/bin/sh\nsleep 30 &\necho started\nwait\n").unwrap();
        std::process::Command::new("chmod")
            .arg("+x")
            .arg(&script)
            .status()
            .unwrap();
        let launch = Launch {
            binary: script,
            extra_args: Vec::new(),
        };
        let spawned = spawn_child(&launch, AccessMode::Default, 1).unwrap();
        let mut lines = BufReader::new(spawned.stdout).lines();
        assert_eq!(lines.next_line().await.unwrap().as_deref(), Some("started"));
        let started = Instant::now();
        spawned.conn.terminate().await;
        assert!(started.elapsed() < Duration::from_secs(5));
        // The backgrounded `sleep` shared the pipe; EOF proves it died too.
        assert_eq!(lines.next_line().await.unwrap(), None);
    }
}
