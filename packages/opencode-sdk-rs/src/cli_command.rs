//! One-shot `opencode <args>` runs whose stdout is read back in full.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use crate::error::{CommandStderr, SdkError};

/// Run `opencode <args>` through the login shell and return its stdout.
///
/// OpenCode exits before draining a piped stdout, so a reader that falls
/// behind gets the output cut at the 64 KiB pipe buffer while the exit status
/// still reads 0. A file receives every byte; it is owner-only (the resolved
/// config can carry provider API keys) and removed on drop, cancellation
/// included. A failed exit is [`SdkError::CommandFailed`], its stderr kept
/// apart from the message.
pub(crate) async fn run_opencode_command(
    binary: &Path,
    cwd: Option<&Path>,
    args: &[&str],
    timeout: Duration,
) -> Result<String, SdkError> {
    let run = capture_opencode_command(binary, cwd, args, timeout).await?;
    if !run.status.success() {
        return Err(SdkError::CommandFailed {
            command: run.label,
            status: run.status,
            stderr: CommandStderr::new(run.stderr),
        });
    }
    Ok(run.stdout)
}

/// A finished one-shot run: its streams are kept whatever the exit status.
pub struct CapturedRun {
    pub label: String,
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

/// Run `opencode <args>` and keep stdout and stderr even when it fails: some
/// commands (`opencode api`) print the response body on stdout either way.
pub async fn capture_opencode_command(
    binary: &Path,
    cwd: Option<&Path>,
    args: &[&str],
    timeout: Duration,
) -> Result<CapturedRun, SdkError> {
    let label = format!("opencode {}", args.join(" "));
    let mut command = cli_discovery::login_shell_exec_command(
        binary.as_os_str(),
        args.iter().map(std::ffi::OsString::from),
    );
    command.kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let stdout_capture = tempfile::NamedTempFile::new()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_capture.reopen()?))
        .stderr(Stdio::piped());
    // `output()` would re-pipe stdout; `spawn` keeps the file redirection.
    let child = command.spawn()?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| SdkError::Timeout(label.clone()))??;

    let stdout = tokio::task::spawn_blocking(move || std::fs::read(stdout_capture.path()))
        .await
        .map_err(|error| SdkError::Protocol(format!("read {label} output: {error}")))??;
    Ok(CapturedRun {
        label,
        status: output.status,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    use super::run_opencode_command;
    use crate::error::SdkError;

    #[tokio::test]
    async fn a_failed_command_keeps_its_stderr_out_of_the_message() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("opencode");
        std::fs::write(
            &binary,
            "#!/bin/sh\necho 'provider key sk-secret rejected' >&2\nexit 2\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();

        let error = run_opencode_command(&binary, None, &["models"], Duration::from_secs(30))
            .await
            .unwrap_err();

        assert!(!error.to_string().contains("sk-secret"), "{error}");
        assert!(!format!("{error:?}").contains("sk-secret"), "{error:?}");
        let SdkError::CommandFailed {
            command,
            status,
            stderr,
        } = error
        else {
            panic!("expected a failed command, got {error}");
        };
        assert_eq!(command, "opencode models");
        assert_eq!(status.code(), Some(2));
        assert_eq!(stderr.raw().trim(), "provider key sk-secret rejected");
    }
}
