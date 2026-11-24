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
                            crate::shared::process_group::kill_group_after_leader_exit(pid).await
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

fn prepare_command(command: &mut Command, policy: AcpProcessTreePolicy) -> io::Result<()> {
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
        return Ok(());
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
    use super::{AcpProcessTreePolicy, ProcessTreeControl};
    use std::path::Path;
    use std::process::Stdio;
    use std::time::Duration;

    use tokio::process::Command;

    /// Spawns a descendant, publishes its pid, then waits for it.
    #[test]
    fn grouped_descendant_helper() {
        let Some(pid_file) = std::env::var_os("PROCESS_TREE_TEST_PID_FILE") else {
            return;
        };
        let mut descendant = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .expect("spawn descendant");
        std::fs::write(pid_file, descendant.id().to_string()).expect("write descendant pid");
        let _ = descendant.wait();
    }

    fn helper_command(pid_file: &Path) -> Command {
        let executable = std::env::current_exe().expect("current test executable");
        let test_module = module_path!()
            .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
            .unwrap_or(module_path!());
        let mut command = Command::new(executable);
        command
            .args([
                "--exact",
                &format!("{test_module}::grouped_descendant_helper"),
                "--nocapture",
            ])
            .env("PROCESS_TREE_TEST_PID_FILE", pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    /// Whether `pid` is gone or a zombie (exited but not yet reaped).
    fn process_dead_or_zombie(pid: libc::pid_t) -> bool {
        // SAFETY: kill with signal 0 only probes the process table.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return true;
        }
        // On Linux, read /proc/<pid>/stat: state Z means zombie (exited).
        #[cfg(target_os = "linux")]
        {
            if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                if let Some(state) = stat
                    .rsplit(')')
                    .next()
                    .and_then(|s| s.trim_start().chars().next())
                {
                    if state == 'Z' {
                        return true;
                    }
                }
            }
        }
        false
    }

    #[tokio::test]
    async fn grouped_policy_leads_a_new_process_group() {
        // Start `sleep` directly: if grouping regresses, the only process this
        // test started is the one the cleanup guard covers.
        let mut command = Command::new("/bin/sleep");
        command.arg("60");
        let control = ProcessTreeControl::prepare(&mut command, AcpProcessTreePolicy::Grouped)
            .expect("prepare grouped command");
        let mut child = command.spawn().expect("spawn sleep");
        let pid = child.id().expect("sleep pid");
        let _cleanup = crate::shared::test_processes::KillOnDrop::default().process(pid);
        control.attach(&child).expect("attach grouped control");

        let mut group = -1;
        for _ in 0..50 {
            // SAFETY: getpgid only reads the process table.
            group = unsafe { libc::getpgid(pid as libc::pid_t) };
            if group == pid as libc::pid_t {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            group, pid as libc::pid_t,
            "a grouped provider must lead its own process group"
        );

        control
            .terminate(&mut child, Duration::from_secs(1))
            .await
            .expect("terminate helper");
    }

    #[tokio::test]
    async fn grouped_policy_terminates_descendants() {
        let directory = tempfile::tempdir().expect("test directory");
        let pid_file = directory.path().join("descendant.pid");
        let mut command = helper_command(&pid_file);
        let control = ProcessTreeControl::prepare(&mut command, AcpProcessTreePolicy::Grouped)
            .expect("prepare grouped command");
        let mut child = command.spawn().expect("spawn helper");
        let pid = child.id().expect("helper pid");
        // Keep a failing regression from leaving its own helper behind.
        let _cleanup = crate::shared::test_processes::KillOnDrop::default()
            .process(pid)
            .group_of_pid_in(&pid_file);
        control.attach(&child).expect("attach grouped control");

        let descendant = wait_for_pid(&pid_file).await;
        // Register the descendant itself so a failed assertion cannot leave it running.
        let _descendant_cleanup =
            crate::shared::test_processes::KillOnDrop::default().process(descendant as u32);
        control
            .terminate(&mut child, Duration::from_secs(1))
            .await
            .expect("terminate helper");

        for _ in 0..50 {
            if process_dead_or_zombie(descendant) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("grouped descendant {descendant} survived tree termination");
    }

    async fn wait_for_pid(path: &Path) -> libc::pid_t {
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("helper never published its descendant pid");
    }
}
