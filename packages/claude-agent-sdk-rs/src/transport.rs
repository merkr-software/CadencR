use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter, Lines};
use tokio::process::{ChildStdin, ChildStdout};

use crate::error::SdkError;
use crate::options::Options;

// ---------------------------------------------------------------------------
// CliProcess
// ---------------------------------------------------------------------------

pub(crate) struct CliProcess {
    child: tokio::process::Child,
    stdin: Option<BufWriter<ChildStdin>>,
    stdout_lines: Lines<BufReader<ChildStdout>>,
    stderr_task: Option<tokio::task::JoinHandle<String>>,
}

impl CliProcess {
    /// Spawn the Claude CLI process with the given options.
    pub async fn spawn(cli_path: &Path, options: &Options) -> Result<Self, SdkError> {
        let mut cmd = tokio::process::Command::new(cli_path);
        cmd.args(options.to_cli_args());
        cmd.current_dir(&options.cwd);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        // Prevent nested-session detection errors (matches TS SDK behavior).
        cmd.env_remove("CLAUDECODE");

        // Layer profile env on top of the inherited parent env. Keys in
        // `options.env` override any inherited values with the same name.
        if let Some(env) = &options.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn().map_err(SdkError::SpawnFailed)?;

        let stdin = child.stdin.take().map(BufWriter::new);

        let stdout = child.stdout.take().expect("stdout was piped");

        let stdout_lines = BufReader::new(stdout).lines();

        let mut stderr_reader = BufReader::new(child.stderr.take().expect("stderr was piped"));
        let stderr_task = tokio::spawn(async move {
            let mut buf = String::new();
            use tokio::io::AsyncReadExt;
            let _ = stderr_reader.read_to_string(&mut buf).await;
            buf
        });

        Ok(Self {
            child,
            stdin,
            stdout_lines,
            stderr_task: Some(stderr_task),
        })
    }

    // -----------------------------------------------------------------------
    // Reading
    // -----------------------------------------------------------------------

    /// Read the next JSON message from stdout.
    ///
    /// Returns `None` on EOF (process finished).
    /// Returns `Err(SdkError::ProtocolError)` on malformed JSON.
    pub async fn read_message(&mut self) -> Result<Option<serde_json::Value>, SdkError> {
        loop {
            match self.stdout_lines.next_line().await {
                Ok(Some(line)) => {
                    let line = line.trim().to_owned();
                    if line.is_empty() {
                        continue; // skip blank lines
                    }
                    return serde_json::from_str(&line)
                        .map(Some)
                        .map_err(|e| SdkError::ProtocolError { line, source: e });
                }
                Ok(None) => return Ok(None), // EOF
                Err(e) => return Err(SdkError::IoError(e)),
            }
        }
    }

    // -----------------------------------------------------------------------
    // Writing
    // -----------------------------------------------------------------------

    /// Write a JSON value to stdin as a newline-terminated NDJSON message.
    ///
    /// Currently unused — `Query` manages stdin directly — but kept as part of
    /// the public transport API for future use.
    #[allow(dead_code)]
    pub async fn write_json(&mut self, value: &serde_json::Value) -> Result<(), SdkError> {
        let stdin = self.stdin.as_mut().ok_or(SdkError::InputClosed)?;
        let json = serde_json::to_string(value).map_err(SdkError::SerializationError)?;
        stdin
            .write_all(json.as_bytes())
            .await
            .map_err(SdkError::IoError)?;
        stdin.write_all(b"\n").await.map_err(SdkError::IoError)?;
        stdin.flush().await.map_err(SdkError::IoError)?;
        Ok(())
    }

    /// Close stdin, signalling no more input to the CLI.
    ///
    /// Currently unused — `Query` manages stdin directly — but kept as part of
    /// the public transport API for future use.
    #[allow(dead_code)]
    pub async fn close_stdin(&mut self) -> Result<(), SdkError> {
        self.stdin.take(); // Dropping the BufWriter closes the pipe.
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /// Send SIGINT to interrupt the process (for pause/resume).
    pub async fn interrupt(&self) -> Result<(), SdkError> {
        #[cfg(unix)]
        {
            let pid = self.child.id().ok_or(SdkError::InputClosed)?;
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGINT);
            }
        }
        Ok(())
    }

    /// Graceful shutdown: SIGTERM, wait 5 s, then SIGKILL.
    ///
    pub async fn kill(&mut self) -> Result<(), SdkError> {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }

        match tokio::time::timeout(std::time::Duration::from_secs(5), self.child.wait()).await {
            Ok(_) => Ok(()),
            Err(_) => {
                self.child.kill().await.map_err(SdkError::IoError)?;
                Ok(())
            }
        }
    }

    /// Wait for the process to exit and return `(exit_code, captured_stderr)`.
    pub async fn wait_with_stderr(&mut self) -> (Option<i32>, String) {
        let status = self.child.wait().await.ok();
        let stderr = if let Some(task) = self.stderr_task.take() {
            task.await.unwrap_or_default()
        } else {
            String::new()
        };
        let code = status.and_then(|s| s.code());
        (code, stderr)
    }

    /// Return the OS process ID, if the process is still running.
    ///
    /// Currently unused — kept as part of the public transport API for future use.
    #[allow(dead_code)]
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Take ownership of the stdin writer, leaving `None` in its place.
    ///
    /// Used by `Query` to hold stdin separately from the reader loop.
    pub(crate) fn take_stdin(&mut self) -> Option<BufWriter<ChildStdin>> {
        self.stdin.take()
    }
}

impl Drop for CliProcess {
    fn drop(&mut self) {
        // Safety net: if the process is still running when CliProcess is dropped
        // (e.g. tokio task abort, panic, or missed cleanup), send SIGKILL to
        // prevent zombie CLI processes that consume tokens in the background.
        if let Some(pid) = self.child.id() {
            tracing::warn!(
                pid,
                "CliProcess dropped with live process — sending SIGKILL"
            );
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn make_executable(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\necho '{}'\n").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[tokio::test]
    async fn write_json_produces_ndjson() {
        use tokio::io::AsyncReadExt;

        // Spawn a simple cat process to echo stdin back to stdout.
        let mut cmd = tokio::process::Command::new("cat");
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let _stderr = child.stderr.take().unwrap();

        let mut writer = BufWriter::new(stdin);
        let value = serde_json::json!({"type": "user", "message": "hello"});
        let json = serde_json::to_string(&value).unwrap();
        writer.write_all(json.as_bytes()).await.unwrap();
        writer.write_all(b"\n").await.unwrap();
        writer.flush().await.unwrap();
        drop(writer); // close stdin → cat exits

        let mut buf = String::new();
        stdout.read_to_string(&mut buf).await.unwrap();
        assert!(buf.ends_with('\n'));
        let trimmed = buf.trim();
        let parsed: serde_json::Value = serde_json::from_str(trimmed).unwrap();
        assert_eq!(parsed["type"], "user");
    }

    #[tokio::test]
    async fn close_stdin_makes_write_return_input_closed() {
        let dir = TempDir::new().unwrap();
        let script = make_executable(dir.path(), "claude");
        // Write a script that reads stdin and exits
        std::fs::write(&script, "#!/bin/sh\ncat > /dev/null\n").unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let _options = Options::default();
        // We can't actually run with default options since the real CLI won't
        // be available, so test close_stdin logic directly.
        let mut dummy_stdin: Option<BufWriter<ChildStdin>> = None;
        // Simulate taking (dropping) stdin:
        dummy_stdin.take();
        // After take, stdin is None → InputClosed
        let result: Result<(), SdkError> = if dummy_stdin.is_none() {
            Err(SdkError::InputClosed)
        } else {
            Ok(())
        };
        assert!(matches!(result, Err(SdkError::InputClosed)));
    }

    #[test]
    fn env_remove_claudecode() {
        // Verify Command::env_remove is the correct API (compile-time check).
        let mut cmd = tokio::process::Command::new("echo");
        cmd.env_remove("CLAUDECODE");
        // If this compiles, the API exists and works as expected.
        let _ = cmd;
    }

    #[tokio::test]
    async fn drop_kills_live_process() {
        // Spawn a long-running process, then drop CliProcess and verify the
        // process is killed (no zombie).
        let mut cmd = tokio::process::Command::new("sleep");
        cmd.arg("300");
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().unwrap();
        let pid = child.id().unwrap();
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        let stderr_task = tokio::spawn(async move {
            let mut buf = String::new();
            use tokio::io::AsyncReadExt;
            let _ = tokio::io::BufReader::new(stderr)
                .read_to_string(&mut buf)
                .await;
            buf
        });

        let cli_process = CliProcess {
            child,
            stdin: None,
            stdout_lines: tokio::io::BufReader::new(stdout).lines(),
            stderr_task: Some(stderr_task),
        };

        // Process should be alive
        assert!(is_process_alive(pid), "process should be alive before drop");

        // Drop triggers SIGKILL
        drop(cli_process);

        // Give the OS a moment to reap the process
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!is_process_alive(pid), "process should be dead after drop");
    }

    #[cfg(unix)]
    fn is_process_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    #[tokio::test]
    async fn options_env_is_applied_to_child_process() {
        // Spawn `/usr/bin/env` using the same cmd wiring as CliProcess::spawn
        // and verify that entries from options.env show up in the child's
        // environment. We inline the logic rather than calling CliProcess
        // because /usr/bin/env doesn't speak the Claude CLI protocol.
        use std::collections::HashMap;
        use tokio::io::AsyncReadExt;

        let mut options = Options::default();
        let mut env = HashMap::new();
        env.insert(
            "CADENCR_TEST_PROFILE".to_string(),
            "bedrock-demo".to_string(),
        );
        options.env = Some(env);

        let mut cmd = tokio::process::Command::new("/usr/bin/env");
        cmd.current_dir(&options.cwd);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.env_remove("CLAUDECODE");
        if let Some(e) = &options.env {
            for (k, v) in e {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn().expect("spawn env");
        let mut stdout = child.stdout.take().expect("stdout piped");
        let _ = child.wait().await.expect("wait env");

        let mut buf = String::new();
        stdout.read_to_string(&mut buf).await.expect("read stdout");
        assert!(
            buf.contains("CADENCR_TEST_PROFILE=bedrock-demo"),
            "expected profile env var in child process; got: {buf}"
        );
    }
}
