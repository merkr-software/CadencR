//! Opt-in operating-system process-tree ownership for ACP subprocesses.
//!
//! This is lifecycle containment, not a filesystem or network sandbox.

use std::io;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::{Child, Command};

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
    /// Own the provider's process tree and terminate descendants on shutdown.
    Isolated(AcpProcessTreeLimits),
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
            AcpProcessTreePolicy::Isolated(_) => self.attach_isolated(child),
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
            AcpProcessTreePolicy::Isolated(_) => self.terminate_isolated(child, grace).await,
        }
    }

    pub(crate) fn cleanup_after_exit(&self, pid: Option<u32>) -> io::Result<()> {
        match self.policy {
            AcpProcessTreePolicy::Inherit => Ok(()),
            AcpProcessTreePolicy::Isolated(_) => cleanup_isolated(self, pid),
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
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("isolated child has no process id"))?;
        signal_process_group(pid, libc::SIGTERM)?;
        match tokio::time::timeout(grace, child.wait()).await {
            Ok(status) => {
                let status = status?;
                signal_process_group(pid, libc::SIGKILL)?;
                Ok(status)
            }
            Err(_) => {
                signal_process_group(pid, libc::SIGKILL)?;
                wait_bounded(child, grace).await
            }
        }
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

async fn wait_bounded(child: &mut Child, timeout: Duration) -> io::Result<ExitStatus> {
    tokio::time::timeout(timeout, child.wait())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "process did not exit after kill"))?
}

fn prepare_command(command: &mut Command, policy: AcpProcessTreePolicy) -> io::Result<()> {
    if !matches!(policy, AcpProcessTreePolicy::Isolated(_)) {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
        return Ok(());
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

#[cfg(unix)]
fn cleanup_isolated(_control: &ProcessTreeControl, pid: Option<u32>) -> io::Result<()> {
    let Some(pid) = pid else {
        return Ok(());
    };
    signal_process_group(pid, libc::SIGKILL)
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

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) -> io::Result<()> {
    let result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(windows)]
fn prepare_windows_job(
    policy: AcpProcessTreePolicy,
) -> io::Result<Option<std::os::windows::io::OwnedHandle>> {
    match policy {
        AcpProcessTreePolicy::Inherit => Ok(None),
        AcpProcessTreePolicy::Isolated(limits) => windows_job::prepare(limits).map(Some),
    }
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    use tokio::process::Child;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_JOB_TIME,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    use super::AcpProcessTreeLimits;

    pub(super) fn prepare(limits: AcpProcessTreeLimits) -> io::Result<OwnedHandle> {
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_JOB_TIME
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY;
        info.BasicLimitInformation.PerJobUserTimeLimit = i64::try_from(
            limits
                .cpu_time_seconds
                .checked_mul(10_000_000)
                .ok_or_else(|| io::Error::other("Windows CPU limit overflow"))?,
        )
        .map_err(|_| io::Error::other("Windows CPU limit overflow"))?;
        info.BasicLimitInformation.ActiveProcessLimit = limits.max_processes;
        info.JobMemoryLimit = usize::try_from(limits.memory_bytes)
            .map_err(|_| io::Error::other("Windows memory limit overflow"))?;
        let result = unsafe {
            SetInformationJobObject(
                job.as_raw_handle().cast(),
                JobObjectExtendedLimitInformation,
                (&raw const info).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub(super) fn attach(job: Option<&OwnedHandle>, child: &Child) -> io::Result<()> {
        let job = required_job(job)?;
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("isolated child has no process handle"))?;
        let result = unsafe {
            AssignProcessToJobObject(job.as_raw_handle().cast(), process.cast::<c_void>())
        };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub(super) fn terminate(job: Option<&OwnedHandle>) -> io::Result<()> {
        let job = required_job(job)?;
        let result = unsafe { TerminateJobObject(job.as_raw_handle().cast(), 1) };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn required_job(job: Option<&OwnedHandle>) -> io::Result<&OwnedHandle> {
        job.ok_or_else(|| io::Error::other("isolated Windows process has no Job Object"))
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
}
