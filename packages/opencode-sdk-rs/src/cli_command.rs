//! One-shot `opencode <args>` runs whose stdout is read back in full.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use crate::error::SdkError;

/// Run `opencode <args>` through the login shell and return its stdout.
///
/// OpenCode exits before draining a piped stdout, so a reader that falls
/// behind gets the output cut at the 64 KiB pipe buffer while the exit status
/// still reads 0. A file receives every byte; it is owner-only (the resolved
/// config can carry provider API keys) and removed on drop, cancellation
/// included. `stderr_in_error` appends the command's stderr to a failed exit;
/// leave it off for commands whose diagnostics may echo secrets.
pub(crate) async fn run_opencode_command(
    binary: &Path,
    cwd: Option<&Path>,
    args: &[&str],
    timeout: Duration,
    stderr_in_error: bool,
) -> Result<String, SdkError> {
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

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = match stderr.trim() {
            detail if stderr_in_error && !detail.is_empty() => format!(": {detail}"),
            _ => String::new(),
        };
        return Err(SdkError::Protocol(format!(
            "{label} exited with status {}{detail}",
            output.status,
        )));
    }

    let stdout = tokio::task::spawn_blocking(move || std::fs::read(stdout_capture.path()))
        .await
        .map_err(|error| SdkError::Protocol(format!("read {label} output: {error}")))??;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}
