//! Bounded one-shot provider subcommands (`models`, `updates`, `update`): the
//! runtime command plus a reserved subcommand, a hard timeout, a 1 MiB output
//! cap, and the managed process policy for managed packages.

use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use super::installation::LocalExecutable;
use super::managed::process_policy::{capture_managed_command, ManagedCommandOutput};
use super::provider_command::{prepare_provider_command, PreparedProviderCommand};
use crate::domain::agents::acp::AcpProcessTreePolicy;
use crate::shared::bounded_command::{capture_bounded, BoundedCommandError};

/// Failure fragment; callers prefix it with the command they ran, e.g.
/// "provider model discovery " + "timed out after 10 seconds".
pub(super) type CommandCaptureError = BoundedCommandError;

/// Prepare `executable` with `args` appended and capture its output. stdin is
/// closed: these commands never prompt.
pub(super) async fn run_provider_subcommand(
    executable: &LocalExecutable,
    args: &[OsString],
    cwd: &Path,
    timeout: Duration,
) -> Result<ManagedCommandOutput, CommandCaptureError> {
    let PreparedProviderCommand {
        mut command,
        process_tree_policy,
    } = prepare_provider_command(executable, args, cwd, None)
        .await
        .map_err(|error| CommandCaptureError::new(format!("could not be prepared: {error}")))?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let is_managed = matches!(process_tree_policy, AcpProcessTreePolicy::Isolated(_));
    capture_provider_command(command, is_managed, timeout).await
}

pub(super) async fn capture_provider_command(
    command: tokio::process::Command,
    is_managed: bool,
    timeout: Duration,
) -> Result<ManagedCommandOutput, CommandCaptureError> {
    if is_managed {
        return capture_managed_command(command, timeout)
            .await
            .map_err(|error| CommandCaptureError::new(format!("failed: {error}")));
    }
    let output = capture_bounded(command, timeout).await?;
    Ok(ManagedCommandOutput {
        status: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}
