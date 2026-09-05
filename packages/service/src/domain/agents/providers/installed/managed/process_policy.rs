//! Direct-exec policy for managed provider processes.
//!
//! This deliberately is **not** an operating-system sandbox. It prevents a
//! package from receiving Cadencr host credentials, never invokes a shell, and
//! prepares bounded stdio for the caller. Filesystem and network isolation are
//! a separate release gate.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fmt;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::domain::agents::acp::process_tree::ProcessTreeControl;
use crate::domain::agents::acp::{AcpProcessTreeLimits, AcpProcessTreePolicy};

mod resources;

pub use resources::{
    managed_process_policy_outcome, ManagedProcessControlOutcome, ManagedProcessPolicyOutcome,
};

/// Maximum bytes captured from either stream of a bounded one-shot command.
pub const MANAGED_MAX_CAPTURE_BYTES: usize = 1024 * 1024;
/// Maximum one-line diagnostic accepted from a long-lived ACP subprocess.
pub const MANAGED_MAX_STDERR_LINE_BYTES: usize = 64 * 1024;
/// Default upper bound for one managed-provider subprocess operation.
pub const MANAGED_PROCESS_TIMEOUT: Duration = Duration::from_secs(30);
/// CPU-time ceiling: per-process/inherited on Unix, per-job on Windows.
/// This is intentionally generous for interactive sessions.
pub const MANAGED_CPU_TIME_SECONDS: u64 = 60 * 60;
/// Address-space ceiling on Linux and aggregate Job memory ceiling on Windows.
pub const MANAGED_MEMORY_BYTES: u64 = 16 * 1024 * 1024 * 1024;
/// Windows Job Object child-process ceiling.
pub const MANAGED_MAX_PROCESSES: u32 = 64;

/// Stable reason a managed process could not be prepared for direct execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedProcessPolicyErrorCode {
    InvalidWorkingDirectory,
    ExecutableUnavailable,
    ForbiddenEnvironment,
    ProcessSpawnFailed,
    ProcessTimedOut,
    OutputTooLarge,
    ProcessIoFailed,
    ProcessContainmentUnavailable,
    ResourceLimitUnavailable,
}

/// Opt-in tree ownership passed to the generic ACP transport.
pub fn managed_process_tree_policy() -> AcpProcessTreePolicy {
    AcpProcessTreePolicy::Isolated(AcpProcessTreeLimits {
        cpu_time_seconds: MANAGED_CPU_TIME_SECONDS,
        memory_bytes: MANAGED_MEMORY_BYTES,
        max_processes: MANAGED_MAX_PROCESSES,
    })
}

/// Process-policy rejection suitable for an installer or quarantine record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedProcessPolicyError {
    pub code: ManagedProcessPolicyErrorCode,
    pub message: String,
}

impl ManagedProcessPolicyError {
    fn new(code: ManagedProcessPolicyErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ManagedProcessPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ManagedProcessPolicyError {}

/// Bounded output from a completed one-shot managed command.
#[derive(Debug)]
pub struct ManagedCommandOutput {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    /// Diagnostic contents are retained only for immediate disposal/counting;
    /// callers must not persist them because provider stderr may hold secrets.
    pub stderr: Vec<u8>,
}

/// Build a provider command without a shell and with an explicit working tree.
///
/// The inherited environment stays intact so native CLIs can locate their
/// existing user configuration through `HOME`, `PATH`, and platform-specific
/// variables. The host-owned `CADENCR_*` and `VITE_*` namespaces are removed.
/// Package environment is
/// applied last, but cannot reintroduce a host credential.
pub fn managed_command(
    executable: &Path,
    args: &[String],
    package_env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Command, ManagedProcessPolicyError> {
    validate_paths(executable, cwd)?;
    validate_package_environment(package_env)?;

    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    resources::configure_resource_limits(&mut command)?;
    for (key, _) in std::env::vars_os() {
        if is_cadencr_host_secret_env_key(&key) {
            command.env_remove(key);
        }
    }
    for (key, value) in package_env {
        command.env(key, value);
    }
    Ok(command)
}

/// Execute a prepared one-shot command with bounded time and output.
pub async fn capture_managed_command(
    mut command: Command,
    timeout: Duration,
) -> Result<ManagedCommandOutput, ManagedProcessPolicyError> {
    let process_tree = ProcessTreeControl::prepare(&mut command, managed_process_tree_policy())
        .map_err(|error| containment_error("could not prepare process containment", error))?;
    let mut child = command.spawn().map_err(|error| {
        ManagedProcessPolicyError::new(
            ManagedProcessPolicyErrorCode::ProcessSpawnFailed,
            format!("could not start managed provider process: {error}"),
        )
    })?;
    if let Err(error) = process_tree.attach(&child) {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(containment_error(
            "could not attach managed process containment",
            error,
        ));
    }
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| process_io_error("managed provider process stdout was unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| process_io_error("managed provider process stderr was unavailable"))?;
    let mut stdout_task = tokio::spawn(read_bounded(stdout));
    let mut stderr_task = tokio::spawn(read_bounded(stderr));
    let capture = async {
        let status = async {
            child
                .wait()
                .await
                .map_err(|error| process_io_error(format!("could not wait for process: {error}")))
        };
        let stdout = async { join_reader(&mut stdout_task, "stdout").await };
        let stderr = async { join_reader(&mut stderr_task, "stderr").await };
        tokio::try_join!(status, stdout, stderr)
    };
    let result = tokio::time::timeout(timeout, capture).await;
    match result {
        Ok(Ok((status, stdout, stderr))) => {
            process_tree
                .cleanup_after_exit(pid)
                .map_err(|error| containment_error("could not clean up descendants", error))?;
            Ok(ManagedCommandOutput {
                status,
                stdout,
                stderr,
            })
        }
        Ok(Err(error)) => {
            stdout_task.abort();
            stderr_task.abort();
            if let Err(termination) = terminate_capture(&process_tree, &mut child, pid).await {
                return Err(containment_error(
                    "could not terminate failed managed process",
                    termination,
                ));
            }
            Err(error)
        }
        Err(_) => {
            stdout_task.abort();
            stderr_task.abort();
            terminate_capture(&process_tree, &mut child, pid)
                .await
                .map_err(|error| {
                    containment_error("could not terminate timed-out managed process", error)
                })?;
            Err(ManagedProcessPolicyError::new(
                ManagedProcessPolicyErrorCode::ProcessTimedOut,
                format!(
                    "managed provider process timed out after {} seconds",
                    timeout.as_secs()
                ),
            ))
        }
    }
}

async fn terminate_capture(
    process_tree: &ProcessTreeControl,
    child: &mut tokio::process::Child,
    pid: Option<u32>,
) -> std::io::Result<()> {
    // wait() can reap the group leader while descendants still hold the pipes.
    // Child::id() is then None, but the original process group still needs killing.
    if child.id().is_none() {
        process_tree.cleanup_after_exit(pid)
    } else {
        process_tree
            .terminate(child, Duration::from_secs(1))
            .await
            .map(|_| ())
    }
}

fn containment_error(context: &str, error: std::io::Error) -> ManagedProcessPolicyError {
    ManagedProcessPolicyError::new(
        ManagedProcessPolicyErrorCode::ProcessContainmentUnavailable,
        format!("{context}: {error}"),
    )
}

async fn join_reader(
    task: &mut tokio::task::JoinHandle<Result<Vec<u8>, ManagedProcessPolicyError>>,
    stream: &str,
) -> Result<Vec<u8>, ManagedProcessPolicyError> {
    task.await.map_err(|error| {
        process_io_error(format!("managed provider {stream} reader failed: {error}"))
    })?
}

async fn read_bounded(
    reader: impl AsyncRead + Unpin,
) -> Result<Vec<u8>, ManagedProcessPolicyError> {
    let mut bytes = Vec::new();
    reader
        .take(MANAGED_MAX_CAPTURE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| process_io_error(format!("could not read provider output: {error}")))?;
    if bytes.len() > MANAGED_MAX_CAPTURE_BYTES {
        return Err(ManagedProcessPolicyError::new(
            ManagedProcessPolicyErrorCode::OutputTooLarge,
            format!("provider output exceeded {MANAGED_MAX_CAPTURE_BYTES} bytes"),
        ));
    }
    Ok(bytes)
}

fn process_io_error(message: impl Into<String>) -> ManagedProcessPolicyError {
    ManagedProcessPolicyError::new(ManagedProcessPolicyErrorCode::ProcessIoFailed, message)
}

/// Whether a variable belongs to Cadencr's host-owned environment domain.
///
/// Provider-owned credentials are intentionally not filtered: authentication
/// remains the provider CLI's responsibility and commonly relies on its native
/// environment or files under the user's home directory.
pub fn is_cadencr_host_secret_env_key(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        return false;
    };
    let key = key.to_ascii_uppercase();
    key.starts_with("CADENCR_") || key.starts_with("VITE_")
}

fn validate_paths(executable: &Path, cwd: &Path) -> Result<(), ManagedProcessPolicyError> {
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(ManagedProcessPolicyError::new(
            ManagedProcessPolicyErrorCode::InvalidWorkingDirectory,
            "managed provider cwd must be an existing absolute directory",
        ));
    }
    if !executable.is_absolute()
        || !executable
            .metadata()
            .is_ok_and(|metadata| metadata.is_file())
    {
        return Err(ManagedProcessPolicyError::new(
            ManagedProcessPolicyErrorCode::ExecutableUnavailable,
            "managed provider executable must be an existing absolute file",
        ));
    }
    Ok(())
}

fn validate_package_environment(
    package_env: &BTreeMap<String, String>,
) -> Result<(), ManagedProcessPolicyError> {
    if let Some(key) = package_env
        .keys()
        .find(|key| is_cadencr_host_secret_env_key(key.as_ref()))
    {
        return Err(ManagedProcessPolicyError::new(
            ManagedProcessPolicyErrorCode::ForbiddenEnvironment,
            format!("managed package cannot set Cadencr host environment variable `{key}`"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_host_namespaces_but_not_provider_credentials() {
        for key in [
            "CADENCR_AUTH_TOKEN",
            "cadencr_remote_secret",
            "CADENCR_DB_PATH",
            "CADENCR_PUSH_PRIVATE_KEY",
            "VITE_API_TOKEN",
            "VITE_DEV_SERVER_URL",
        ] {
            assert!(is_cadencr_host_secret_env_key(key.as_ref()), "{key}");
        }
        for key in ["HOME", "PATH", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
            assert!(!is_cadencr_host_secret_env_key(key.as_ref()), "{key}");
        }
    }

    #[test]
    fn refuses_package_attempt_to_reintroduce_host_token() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("agent");
        std::fs::write(&executable, b"agent").unwrap();
        let environment = BTreeMap::from([("CADENCR_AUTH_TOKEN".into(), "bad".into())]);

        let error = managed_command(&executable, &[], &environment, directory.path())
            .expect_err("host token must be rejected");
        assert_eq!(
            error.code,
            ManagedProcessPolicyErrorCode::ForbiddenEnvironment
        );
    }

    #[test]
    fn requires_absolute_existing_paths() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("agent");
        std::fs::write(&executable, b"agent").unwrap();

        let error = managed_command(&executable, &[], &BTreeMap::new(), Path::new("relative"))
            .expect_err("relative cwd must fail");
        assert_eq!(
            error.code,
            ManagedProcessPolicyErrorCode::InvalidWorkingDirectory
        );
        let error = managed_command(
            &directory.path().join("missing"),
            &[],
            &BTreeMap::new(),
            directory.path(),
        )
        .expect_err("missing executable must fail");
        assert_eq!(
            error.code,
            ManagedProcessPolicyErrorCode::ExecutableUnavailable
        );
    }

    #[test]
    fn policy_report_does_not_claim_a_unix_child_count_limit() {
        let report = managed_process_policy_outcome();
        assert_eq!(
            report.descendant_termination,
            ManagedProcessControlOutcome::Applied
        );
        #[cfg(unix)]
        assert!(matches!(
            report.child_count_limit,
            ManagedProcessControlOutcome::Unavailable { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn managed_descendant_helper() {
        let Some(pid_file) = std::env::var_os("PROCESS_TREE_TEST_PID_FILE") else {
            return;
        };
        let mut descendant = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .expect("spawn descendant");
        std::fs::write(pid_file, descendant.id().to_string()).expect("write descendant pid");
        if std::env::var_os("PROCESS_TREE_TEST_EXIT_PARENT").is_some() {
            return;
        }
        let _ = descendant.wait();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_terminates_managed_descendants() {
        assert_timeout_terminates_descendants(false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_terminates_descendants_after_parent_exits() {
        assert_timeout_terminates_descendants(true).await;
    }

    #[cfg(unix)]
    async fn assert_timeout_terminates_descendants(exit_parent: bool) {
        let directory = tempfile::tempdir().expect("test directory");
        let pid_file = directory.path().join("descendant.pid");
        let executable = std::env::current_exe().expect("current test executable");
        let test_module = module_path!()
            .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
            .unwrap_or(module_path!());
        let helper_name = format!("{test_module}::managed_descendant_helper");
        let mut environment = BTreeMap::from([(
            "PROCESS_TREE_TEST_PID_FILE".into(),
            pid_file.to_string_lossy().into_owned(),
        )]);
        if exit_parent {
            environment.insert("PROCESS_TREE_TEST_EXIT_PARENT".into(), "1".into());
        }
        let command = managed_command(
            &executable,
            &["--exact".into(), helper_name, "--nocapture".into()],
            &environment,
            directory.path(),
        )
        .expect("prepare helper process");

        let error = capture_managed_command(command, Duration::from_secs(1))
            .await
            .expect_err("helper must time out");
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .expect("helper should publish descendant pid")
            .parse()
            .expect("numeric descendant pid");
        for _ in 0..50 {
            if unsafe { libc::kill(pid, 0) } != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                assert_eq!(error.code, ManagedProcessPolicyErrorCode::ProcessTimedOut);
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Keep a failing regression from leaving its own helper process behind.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        panic!("managed descendant {pid} survived bounded tree termination: {error}");
    }
}
