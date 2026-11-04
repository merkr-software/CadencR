//! The backend process under test: its stdin, and its stdout/stderr read on
//! threads so every wait has a deadline.
//!
//! It is started the way the Cadencr host starts a backend: without the
//! host's own `CADENCR_*`/`VITE_*` environment (matched case-insensitively),
//! and on Unix in a process group of its own, which is killed at the end so
//! no grandchild outlives the report.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{self, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::framing::{next_line, Line};
use crate::protocol::{parse_event, EVENT_PROTOCOL_VERSION, MAX_IN_FLIGHT, MAX_LINE_BYTES};
use crate::server::lock;

/// stderr lines kept for the report.
const STDERR_TAIL: usize = 50;
const POLL: Duration = Duration::from_millis(20);
const MAX_UNCLAIMED: usize = 4 * MAX_IN_FLIGHT;

pub(super) struct Backend {
    protocol: u32,
    child: Child,
    /// Whether its process group may still have members to kill.
    group_alive: bool,
    stdin: Option<ChildStdin>,
    stdout: Receiver<Line>,
    stdout_closed: bool,
    /// Messages read but not yet claimed by a check.
    inbox: VecDeque<Value>,
    /// Stdout lines that are not protocol messages.
    pub stray: Vec<String>,
    stderr: Arc<Mutex<VecDeque<String>>>,
}

#[bon::bon]
impl Backend {
    #[builder]
    pub fn spawn(binary: &Path, args: &[OsString], cwd: &Path, protocol: u32) -> io::Result<Self> {
        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, _) in std::env::vars_os() {
            if is_host_env_key(&key) {
                command.env_remove(key);
            }
        }
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let mut child = command.spawn()?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            // Unreachable with piped stdio; make sure nothing is left behind.
            let _ = child.kill();
            return Err(io::Error::other("the backend's stdio was unavailable"));
        };
        let (lines, received) = mpsc::sync_channel(MAX_UNCLAIMED);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(line)) = next_line(&mut reader, MAX_LINE_BYTES) {
                if lines.send(line).is_err() {
                    return;
                }
            }
        });
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let kept = tail.clone();
        // Drains stderr until it closes, whatever it holds: a reader that
        // stopped early would leave the backend's next write failing.
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            while let Ok(Some(line)) = next_line(&mut reader, MAX_LINE_BYTES) {
                let line = match line {
                    Line::Text(line) => String::from_utf8_lossy(&line).into_owned(),
                    Line::TooLong => format!("(a line over {MAX_LINE_BYTES} bytes, not kept)"),
                };
                let mut tail = lock(&kept);
                if tail.len() == STDERR_TAIL {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        });
        Ok(Self {
            protocol,
            child,
            group_alive: true,
            stdin: Some(stdin),
            stdout: received,
            stdout_closed: false,
            inbox: VecDeque::new(),
            stray: Vec::new(),
            stderr: tail,
        })
    }

    /// Write one line (a `\n` is added).
    pub fn send(&mut self, line: &str) -> io::Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::other("stdin is already closed"))?;
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    }

    /// The first stdout line, raw, within `timeout` (`None` when there is
    /// none). Call it first: it bypasses the message inbox.
    pub fn first_line(&mut self, timeout: Duration) -> Option<Line> {
        self.stdout.recv_timeout(timeout).ok()
    }

    /// Keep a line some check did not expect: a protocol message stays
    /// claimable, anything else is stray.
    pub fn keep(&mut self, line: &[u8]) {
        match protocol_message(line, self.protocol) {
            Some(message) => self.keep_message(message),
            None => self.note_stray(String::from_utf8_lossy(line).into_owned()),
        }
    }

    fn keep_message(&mut self, message: Value) {
        if message["type"] == "event" {
            // Validated, but no request can claim it. Do not accumulate a
            // continuously publishing backend's event stream in the report.
            return;
        }
        if self.inbox.len() < MAX_UNCLAIMED {
            self.inbox.push_back(message);
        } else {
            self.note_stray("too many unclaimed protocol messages".into());
        }
    }

    fn note_stray(&mut self, line: String) {
        if self.stray.len() < STDERR_TAIL {
            self.stray.push(line.chars().take(200).collect());
        }
    }

    /// The response with id `id` within `timeout`; other messages stay
    /// unclaimed.
    pub fn response(&mut self, id: &str, timeout: Duration) -> Option<Value> {
        let is_it = |message: &Value| message["type"] == "response" && message["id"] == id;
        if let Some(index) = self.inbox.iter().position(is_it) {
            return self.inbox.remove(index);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let message = self.read_message(deadline)?;
            if is_it(&message) {
                return Some(message);
            }
            self.keep_message(message);
        }
    }

    fn read_message(&mut self, deadline: Instant) -> Option<Value> {
        loop {
            let left = deadline.checked_duration_since(Instant::now())?;
            let line = match self.stdout.recv_timeout(left) {
                Ok(Line::Text(line)) => line,
                Ok(Line::TooLong) => {
                    self.note_stray(format!("a line over {MAX_LINE_BYTES} bytes"));
                    continue;
                }
                Err(RecvTimeoutError::Timeout) => return None,
                Err(RecvTimeoutError::Disconnected) => {
                    self.stdout_closed = true;
                    return None;
                }
            };
            match protocol_message(&line, self.protocol) {
                Some(message) if message["type"] == "event" => continue,
                Some(message) => return Some(message),
                None => self.note_stray(String::from_utf8_lossy(&line).into_owned()),
            }
        }
    }

    /// Drain stdout after exit, within `timeout`. A stream still open or
    /// still publishing at the deadline cannot be certified clean.
    pub fn drain_stdout(&mut self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while let Some(message) = self.read_message(deadline) {
            self.keep_message(message);
        }
        if !self.stdout_closed {
            self.note_stray("stdout did not close before the drain deadline".into());
        }
    }

    /// `Some(status)` once the process has exited.
    pub fn exited(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Close stdin and wait up to `timeout` for the process to exit; kill it
    /// after that. `Ok(None)` means it had to be killed.
    pub fn close_and_wait(&mut self, timeout: Duration) -> io::Result<Option<ExitStatus>> {
        drop(self.stdin.take());
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait()? {
                return Ok(Some(status));
            }
            thread::sleep(POLL);
        }
        self.kill()?;
        Ok(None)
    }

    /// Kill the backend and everything left in its process group.
    pub fn kill(&mut self) -> io::Result<()> {
        if self.child.try_wait()?.is_none() {
            self.child.kill()?;
            self.child.wait()?;
        }
        self.kill_group()
    }

    #[cfg(unix)]
    fn kill_group(&mut self) -> io::Result<()> {
        if !std::mem::replace(&mut self.group_alive, false) {
            return Ok(());
        }
        let Ok(group) = libc::pid_t::try_from(self.child.id()) else {
            return Ok(());
        };
        // SAFETY: `kill` with a negative pid signals the process group the
        // backend leads (created by `process_group(0)` at spawn); no memory
        // is touched.
        if unsafe { libc::kill(-group, libc::SIGKILL) } == 0 {
            return Ok(());
        }
        match io::Error::last_os_error() {
            // Nobody is left in the group.
            error if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
            error => Err(error),
        }
    }

    #[cfg(not(unix))]
    fn kill_group(&mut self) -> io::Result<()> {
        self.group_alive = false;
        Ok(())
    }

    /// The last stderr lines, oldest first.
    pub fn stderr_tail(&self) -> Vec<String> {
        // Give the reader thread a moment to drain what was already written.
        thread::sleep(POLL);
        lock(&self.stderr).iter().cloned().collect()
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        // Never leave the process running behind a finished report; a failure
        // here means it is already gone.
        let _ = self.kill();
    }
}

/// Recognize legacy messages or a valid event in a v2 session.
fn protocol_message(line: &[u8], protocol: u32) -> Option<Value> {
    let message: Value = serde_json::from_slice(line).ok()?;
    match message["type"].as_str() {
        Some("ready" | "response") => Some(message),
        Some("event") if protocol == EVENT_PROTOCOL_VERSION && parse_event(line).is_ok() => {
            Some(message)
        }
        _ => None,
    }
}

/// An environment variable the host never passes to a backend.
fn is_host_env_key(key: &std::ffi::OsStr) -> bool {
    key.to_str().is_some_and(|key| {
        let key = key.to_ascii_uppercase();
        key.starts_with("CADENCR_") || key.starts_with("VITE_")
    })
}

/// The working directory: as given, else the binary's folder.
pub(super) fn working_dir(binary: &Path, cwd: Option<&Path>) -> PathBuf {
    cwd.map(Path::to_path_buf)
        .or_else(|| binary.parent().map(Path::to_path_buf))
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// A fresh private directory standing in for the host's per-tab state
/// directory; removed on drop.
pub(super) struct StateDir(PathBuf);

impl StateDir {
    pub fn create() -> io::Result<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let name = format!("cadencr-conformance-{}-{nanos}", std::process::id());
        let path = std::env::temp_dir().join(name);
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&path)?;
        Ok(Self(path.canonicalize()?))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for StateDir {
    fn drop(&mut self) {
        // A leftover directory in the system temp folder is harmless, and a
        // finished report has nowhere to say so.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_v2_accepts_well_formed_bounded_events() {
        let event = br#"{"type":"event","topic":"timer","payload":{"tick":1}}"#;
        assert!(protocol_message(event, 1).is_none());
        assert!(protocol_message(event, 2).is_some());
        for event in [
            &br#"{"type":"event","topic":"","payload":null}"#[..],
            br#"{"type":"event","topic":"t"}"#,
        ] {
            assert!(protocol_message(event, 2).is_none());
        }
        let large = serde_json::json!({
            "type":"event","topic":"t","payload":"x".repeat(crate::protocol::MAX_EVENT_BYTES)
        })
        .to_string();
        assert!(protocol_message(large.as_bytes(), 2).is_none());
    }
}
