//! Cursor Agent CLI concerns outside the live ACP session: binary discovery,
//! the `agent models` catalog, and native CLI updates.

pub mod binary;
pub mod models;
pub mod updates;

use std::ffi::OsString;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use cadencr_provider_sdk::ProviderError;
use tokio::process::Command;

/// Run a short-lived CLI command noninteractively (stdin closed) and capture
/// its output, killing it when `timeout` elapses.
pub async fn run_captured(
    binary: &Path,
    args: &[OsString],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Output, ProviderError> {
    let label = binary::command_label(binary, args);
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let child = command
        .spawn()
        .map_err(|error| ProviderError::new(format!("could not start `{label}`: {error}")))?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(ProviderError::new(format!("`{label}` failed: {error}"))),
        Err(_) => Err(ProviderError::new(format!(
            "`{label}` timed out after {} seconds",
            timeout.as_secs()
        ))),
    }
}

/// Last `max` characters of combined CLI output for an error message.
pub fn output_tail(output: &Output, max: usize) -> String {
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    let trimmed = combined.trim();
    let count = trimmed.chars().count();
    if count <= max {
        return trimmed.to_string();
    }
    let tail: String = trimmed.chars().skip(count - max).collect();
    format!("…{tail}")
}

/// A one-off current-thread runtime for the synchronous SDK commands.
pub fn block_on<T>(
    future: impl std::future::Future<Output = Result<T, ProviderError>>,
) -> Result<T, ProviderError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(future)
}

#[cfg(test)]
mod tests {
    use super::{block_on, output_tail, run_captured};
    use std::ffi::OsString;
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn captures_output_and_times_out() {
        let output = block_on(run_captured(
            Path::new("/bin/sh"),
            &[
                OsString::from("-c"),
                OsString::from("echo out; echo err >&2"),
            ],
            None,
            Duration::from_secs(5),
        ))
        .unwrap();
        assert!(output.status.success());
        assert_eq!(output_tail(&output, 100), "out\nerr");
        assert_eq!(output_tail(&output, 3), "…err");

        let error = block_on(run_captured(
            Path::new("/bin/sh"),
            &[OsString::from("-c"), OsString::from("sleep 5")],
            None,
            Duration::from_millis(100),
        ))
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }
}
