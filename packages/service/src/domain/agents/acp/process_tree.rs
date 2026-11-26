//! Opt-in operating-system process-tree ownership for ACP subprocesses.
//!
//! This is lifecycle containment, not a filesystem or network sandbox.

use std::io;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::{Child, Command};

#[cfg(windows)]
use super::process_tree_windows as windows_job;
#[cfg(windows)]
use crate::shared::process_group::wait_bounded;

#[cfg(unix)]
const GROUP_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

/// Resource ceilings carried by an isolated managed process tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcpProcessTreeLimits {
    /// Per-process Unix CPU time or aggregate Windows Job CPU time.
    pub cpu_time_seconds: u64,
    /// Linux per-process address space or aggregate Windows Job memory.
    pub memory_bytes: u64,
    /// Enforced by Windows Jobs; explicitly unavailable on Unix.
    pub max_processes: u32,
}

/// Provider-neutral subprocess ownership policy.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum AcpProcessTreePolicy {
    /// Preserve the established built-in provider behavior.
    #[default]
    Inherit,
    /// Own the provider's process tree and terminate descendants on shutdown,
    /// with the resource ceilings of a managed package.
    Isolated(AcpProcessTreeLimits),
    /// Own the provider's process tree and terminate descendants on shutdown,
    /// without resource ceilings.
    ///
    /// A provider installed outside the managed package store is still a
    /// process the host starts and stops, so it must not outlive its session.
    /// It must not inherit the managed ceilings either: those bound a package
    /// the host did not build, and would kill a long interactive session.
    Grouped,
}

pub(crate) struct ProcessTreeControl {
    policy: AcpProcessTreePolicy,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}

impl ProcessTreeControl {
    pub(crate) fn prepare(command: &mut Command, policy: AcpProcessTreePolicy) -> io::Result<Self> {
        validate_policy(policy)?;
        prepare_command(command, policy)?;
        #[cfg(windows)]
        let job = prepare_windows_job(policy)?;
        Ok(Self {
            policy,
            #[cfg(windows)]
            job,
        })
    }

    pub(crate) fn attach(&self, child: &Child) -> io::Result<()> {
        match self.policy {
            AcpProcessTreePolicy::Inherit => Ok(()),
            AcpProcessTreePolicy::Isolated(_) | AcpProcessTreePolicy::Grouped => {
                self.attach_isolated(child)
            }
        }
    }

    pub(crate) async fn terminate(
        &self,
        child: &mut Child,
        grace: Duration,
    ) -> io::Result<ExitStatus> {
        match self.policy {
            AcpProcessTreePolicy::Inherit => {
                child.start_kill()?;
                child.wait().await
            }
            AcpProcessTreePolicy::Isolated(_) | AcpProcessTreePolicy::Grouped => {
                self.terminate_isolated(child, grace).await
            }
        }
    }

    pub(crate) async fn cleanup_after_exit(&self, pid: Option<u32>) -> io::Result<()> {
        match self.policy {
            AcpProcessTreePolicy::Inherit => Ok(()),
            AcpProcessTreePolicy::Isolated(_) | AcpProcessTreePolicy::Grouped => {
                #[cfg(unix)]
                {
                    match pid {
                        Some(pid) => {
                            crate::shared::process_group::kill_group_after_leader_exit_and_drain(
                                pid,
                                GROUP_DRAIN_TIMEOUT,
                            )
                            .await
                        }
                        None => Ok(()),
                    }
                }
                #[cfg(not(unix))]
                {
                    cleanup_isolated(self, pid)
                }
            }
        }
    }

    #[cfg(unix)]
    fn attach_isolated(&self, child: &Child) -> io::Result<()> {
        child
            .id()
            .ok_or_else(|| io::Error::other("isolated child has no process id"))?;
        Ok(())
    }

    #[cfg(windows)]
    fn attach_isolated(&self, child: &Child) -> io::Result<()> {
        windows_job::attach(self.job.as_ref(), child)
    }

    #[cfg(not(any(unix, windows)))]
    fn attach_isolated(&self, _child: &Child) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "isolated process trees are unavailable on this platform",
        ))
    }

    #[cfg(unix)]
    async fn terminate_isolated(
        &self,
        child: &mut Child,
        grace: Duration,
    ) -> io::Result<ExitStatus> {
        crate::shared::process_group::terminate_process_group(child, grace).await
    }

    #[cfg(windows)]
    async fn terminate_isolated(
        &self,
        child: &mut Child,
        grace: Duration,
    ) -> io::Result<ExitStatus> {
        windows_job::terminate(self.job.as_ref())?;
        wait_bounded(child, grace).await
    }

    #[cfg(not(any(unix, windows)))]
    async fn terminate_isolated(
        &self,
        _child: &mut Child,
        _grace: Duration,
    ) -> io::Result<ExitStatus> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "isolated process trees are unavailable on this platform",
        ))
    }
}

fn validate_policy(policy: AcpProcessTreePolicy) -> io::Result<()> {
    let AcpProcessTreePolicy::Isolated(limits) = policy else {
        return Ok(());
    };
    if limits.cpu_time_seconds == 0 || limits.memory_bytes == 0 || limits.max_processes == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "isolated process-tree limits must be positive",
        ));
    }
    Ok(())
}

fn prepare_command(
    #[cfg_attr(not(unix), allow(unused_variables))] command: &mut Command,
    policy: AcpProcessTreePolicy,
) -> io::Result<()> {
    if matches!(policy, AcpProcessTreePolicy::Inherit) {
        return Ok(());
    }
    #[cfg(unix)]
    {
        crate::shared::process_group::lead_new_process_group(command);
        Ok(())
    }
    #[cfg(windows)]
    {
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "isolated process trees are unavailable on this platform",
    ))
}

#[cfg(windows)]
fn cleanup_isolated(control: &ProcessTreeControl, _pid: Option<u32>) -> io::Result<()> {
    windows_job::terminate(control.job.as_ref())
}

#[cfg(not(any(unix, windows)))]
fn cleanup_isolated(_control: &ProcessTreeControl, _pid: Option<u32>) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "isolated process trees are unavailable on this platform",
    ))
}

#[cfg(windows)]
fn prepare_windows_job(
    policy: AcpProcessTreePolicy,
) -> io::Result<Option<std::os::windows::io::OwnedHandle>> {
    match policy {
        AcpProcessTreePolicy::Inherit => Ok(None),
        AcpProcessTreePolicy::Isolated(limits) => windows_job::prepare(limits).map(Some),
        AcpProcessTreePolicy::Grouped => windows_job::prepare_unlimited().map(Some),
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn isolated_policy_prepares_a_kill_on_close_job() {
        let mut command = Command::new("cmd.exe");
        let control = ProcessTreeControl::prepare(
            &mut command,
            AcpProcessTreePolicy::Isolated(AcpProcessTreeLimits {
                cpu_time_seconds: 60,
                memory_bytes: 256 * 1024 * 1024,
                max_processes: 4,
            }),
        )
        .expect("Job Object controls should be available");
        assert!(control.job.is_some());
    }

    #[test]
    fn grouped_policy_prepares_a_kill_on_close_job_without_ceilings() {
        let mut command = Command::new("cmd.exe");
        let control = ProcessTreeControl::prepare(&mut command, AcpProcessTreePolicy::Grouped)
            .expect("Job Object controls should be available");
        assert!(control.job.is_some());
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use std::fs::{File, TryLockError};
    use std::path::Path;
    use std::time::Duration;

    use tokio::process::Command;

    use super::{AcpProcessTreePolicy, ProcessTreeControl};
    use crate::domain::agents::acp::client::{AcpClient, AcpSpawnOptions};
    use crate::domain::agents::acp::types::{AcpClientInfo, AcpEvent};
    use crate::shared::test_processes::{
        publish_pid, sleeping_child_command, wait_for_published_pid, KillOnDrop,
    };

    const STOP_LAUNCHER: &str = r#"trap '' TERM; "$@" >/dev/null 2>&1 & wait"#;
    const NATURAL_EXIT_LAUNCHER: &str = r#"
        "$@" >/dev/null 2>&1 &
        while [ ! -e "$PROCESS_TREE_TEST_EXIT_FILE" ]; do sleep 0.02; done
    "#;

    /// Acts as the provider worker, holding an OS lock until it is killed.
    #[test]
    fn lease_worker() {
        let Ok(pid_file) = std::env::var("PROCESS_TREE_TEST_PID_FILE") else {
            return;
        };
        let pid_file = Path::new(&pid_file);
        let lease = File::create(pid_file.with_extension("lock")).expect("create worker lease");
        lease.try_lock().expect("acquire worker lease");
        publish_pid(pid_file, std::process::id()).expect("publish descendant pid");
        std::thread::sleep(Duration::from_secs(30));
    }

    fn launcher_command(script: &str, pid_file: &Path, exit_file: &Path) -> Command {
        let executable = std::env::current_exe().expect("current test executable");
        let test_module = module_path!()
            .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
            .unwrap_or(module_path!());
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", script, "process-tree-test"])
            .arg(executable)
            .args(["--exact", &format!("{test_module}::lease_worker")])
            .env("PROCESS_TREE_TEST_PID_FILE", pid_file)
            .env("PROCESS_TREE_TEST_EXIT_FILE", exit_file);
        command
    }

    #[tokio::test]
    async fn grouped_policy_leads_a_new_process_group() {
        let mut command = sleeping_child_command();
        let control = ProcessTreeControl::prepare(&mut command, AcpProcessTreePolicy::Grouped)
            .expect("prepare grouped command");
        let mut child = command.spawn().expect("spawn sleep");
        let pid = child.id().expect("sleep pid");
        let _cleanup = KillOnDrop::default().process(pid);
        control.attach(&child).expect("attach grouped control");
        // SAFETY: getpgid only reads the process table. The process group is
        // set before spawn returns.
        assert_eq!(
            unsafe { libc::getpgid(pid as libc::pid_t) },
            pid as libc::pid_t
        );

        control
            .terminate(&mut child, Duration::from_secs(1))
            .await
            .expect("terminate helper");
    }

    #[tokio::test]
    async fn stopping_a_term_resistant_launcher_releases_the_lease_before_process_exit() {
        assert_lease_released(STOP_LAUNCHER, Some(libc::SIGKILL)).await;
    }

    #[tokio::test]
    async fn natural_launcher_exit_releases_the_lease_before_process_exit() {
        assert_lease_released(NATURAL_EXIT_LAUNCHER, None).await;
    }

    async fn assert_lease_released(script: &str, stop_signal: Option<i32>) {
        let directory = tempfile::tempdir().expect("test directory");
        let pid_file = directory.path().join("worker.pid");
        let exit_file = directory.path().join("exit");
        let client = AcpClient::spawn(
            AcpSpawnOptions::builder()
                .command(launcher_command(script, &pid_file, &exit_file))
                .client_info(AcpClientInfo::default())
                .process_tree_policy(AcpProcessTreePolicy::Grouped)
                .build(),
        )
        .await
        .expect("spawn grouped ACP launcher");
        let mut events = client.subscribe_reliable();
        let _launcher_cleanup = KillOnDrop::default()
            .process(client.pid().expect("launcher pid"))
            .group_of_pid_in(&pid_file);
        let worker = wait_for_published_pid(&pid_file, Duration::from_secs(5))
            .await
            .expect("worker published its pid");
        let _worker_cleanup = KillOnDrop::default().process(worker as u32);
        let lease = File::open(pid_file.with_extension("lock")).expect("open worker lease");
        assert!(matches!(lease.try_lock(), Err(TryLockError::WouldBlock)));
        drop(lease);

        if stop_signal.is_some() {
            client.shutdown().await;
        } else {
            std::fs::write(exit_file, []).expect("release launcher");
        }
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("ProcessExited must be published");
        assert!(
            matches!(
                event,
                Some(AcpEvent::ProcessExited { status, signal })
                    if signal == stop_signal && (signal.is_some() || status == Some(0))
            ),
            "{event:?}"
        );
        // Reopen as an immediate session/load would, without a retry.
        let lease = File::open(pid_file.with_extension("lock")).expect("reopen worker lease");
        lease
            .try_lock()
            .expect("session lease released by ProcessExited");
        client.shutdown().await;
    }
}
