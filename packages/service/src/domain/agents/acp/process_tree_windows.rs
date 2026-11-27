//! Windows Job Object controls for isolated ACP process trees.

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
    create_job(info)
}

/// A Job that only guarantees descendants die with their owner.
pub(super) fn prepare_unlimited() -> io::Result<OwnedHandle> {
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    create_job(info)
}

fn create_job(info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION) -> io::Result<OwnedHandle> {
    let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
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
    let result =
        unsafe { AssignProcessToJobObject(job.as_raw_handle().cast(), process.cast::<c_void>()) };
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
