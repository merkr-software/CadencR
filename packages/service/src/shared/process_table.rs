//! The OS process table, read from the kernel.
//!
//! No `ps` subprocess: on a loaded machine one can take longer than any
//! deadline worth setting (seen past 5 s at a load average of 50), and the
//! callers decide from this table which processes to stop. macOS answers
//! `proc_pidinfo`, Linux `/proc/<pid>/stat`.
//!
//! A process that has exited counts as gone, whether or not its parent has
//! reaped it yet: macOS already reports a zombie as absent (where `ps` still
//! listed it), Linux keeps it until it is reaped. Nothing hangs off a zombie
//! either way: its children went to init when it exited.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod owned_session;
#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(crate) use owned_session::{owned_process_is_live, stop_pinned_session};
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) use owned_session::{
    pinned_session_has_work, stop_verified_tree, BootIdentity, SessionAnchor,
};

/// Where a process sits in the process tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessLinks {
    pub ppid: i32,
    pub pgid: i32,
}

/// Parent and process group of every process on the machine. A process that
/// exits while the table is read is simply absent.
pub async fn links() -> io::Result<HashMap<i32, ProcessLinks>> {
    tokio::task::spawn_blocking(platform::links)
        .await
        .map_err(io::Error::other)?
}

/// Parent of every process on the machine.
pub async fn parents() -> io::Result<HashMap<i32, i32>> {
    Ok(links()
        .await?
        .into_iter()
        .map(|(pid, links)| (pid, links.ppid))
        .collect())
}

/// Current working directory of each requested pid, read directly from the
/// kernel (`proc_pidinfo(PROC_PIDVNODEPATHINFO)` on macOS, `/proc/<pid>/cwd`
/// on Linux). Duplicate pids are probed once. A process that exited, or one
/// this user may not inspect, is omitted; any other failure is an error.
/// A directory deleted under a process keeps its last path on both
/// platforms. Returns `ErrorKind::Unsupported` elsewhere.
pub async fn cwds(pids: &[i32]) -> io::Result<HashMap<i32, PathBuf>> {
    let owned: Vec<i32> = pids.to_vec();
    tokio::task::spawn_blocking(move || platform::cwds(&owned))
        .await
        .map_err(io::Error::other)?
}

/// When `pid` started, or `None` when there is no such process: a pid with
/// the same start time is the same process. macOS only answers for this
/// user's processes, so another user's reads as `None` there.
pub async fn start_time(pid: u32) -> Option<String> {
    match tokio::task::spawn_blocking(move || platform::start_time(pid)).await {
        Ok(start) => start,
        Err(error) => {
            tracing::warn!(pid, %error, "could not read a process's start time");
            None
        }
    }
}

/// Whether macOS can still see a member of `pgid` when sending signals.
#[cfg(target_os = "macos")]
pub(crate) fn group_has_live_member(pgid: i32) -> io::Result<bool> {
    platform::group_has_live_member(pgid, false)
}

/// Whether a member of `pgid` still needs to finish exiting.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn group_has_unfinished_member(pgid: i32) -> io::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        platform::group_has_live_member(pgid, true)
    }
    #[cfg(target_os = "linux")]
    {
        platform::group_has_live_member(pgid)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::collections::HashMap;
    use std::ffi::OsStr;
    use std::io;
    use std::mem::{size_of, size_of_val};
    use std::os::unix::ffi::OsStrExt;
    use std::path::PathBuf;

    use super::ProcessLinks;

    pub(super) fn cwds(pids: &[i32]) -> io::Result<HashMap<i32, PathBuf>> {
        let mut out = HashMap::new();
        for &pid in pids {
            if pid <= 0 || out.contains_key(&pid) {
                continue;
            }
            if let Some(path) = pid_cwd(pid)? {
                out.insert(pid, path);
            }
        }
        Ok(out)
    }

    /// `None` when the process is gone or belongs to another user (EPERM).
    fn pid_cwd(pid: i32) -> io::Result<Option<PathBuf>> {
        let info: libc::proc_vnodepathinfo =
            match read_pid_info(pid, libc::PROC_PIDVNODEPATHINFO) {
                Ok(Some(info)) => info,
                Ok(None) => return Ok(None),
                Err(error) if matches!(error.raw_os_error(), Some(libc::EPERM | libc::EACCES)) => {
                    return Ok(None)
                }
                Err(error) => return Err(error),
            };
        let raw_len = size_of_val(&info.pvi_cdir.vip_path);
        // SAFETY: `vip_path` is a contiguous `[[c_char; 32]; 32]` (MAXPATHLEN = 1024)
        // populated as a NUL-terminated path by `proc_pidinfo`.
        let bytes = unsafe {
            std::slice::from_raw_parts(info.pvi_cdir.vip_path.as_ptr().cast::<u8>(), raw_len)
        };
        let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        if end == 0 {
            return Ok(None);
        }
        Ok(Some(PathBuf::from(OsStr::from_bytes(&bytes[..end]))))
    }

    pub(super) fn links() -> io::Result<HashMap<i32, ProcessLinks>> {
        Ok(all_pids()?
            .into_iter()
            .filter_map(|pid| {
                // Any user's process: this flavor needs no privilege.
                let info: libc::proc_bsdshortinfo = pid_info(pid, libc::PROC_PIDT_SHORTBSDINFO)?;
                let links = ProcessLinks {
                    ppid: i32::try_from(info.pbsi_ppid).ok()?,
                    pgid: i32::try_from(info.pbsi_pgid).ok()?,
                };
                Some((pid, links))
            })
            .collect())
    }

    pub(super) fn links_of(pid: i32) -> io::Result<Option<ProcessLinks>> {
        let Some(info) =
            read_pid_info::<libc::proc_bsdshortinfo>(pid, libc::PROC_PIDT_SHORTBSDINFO)?
        else {
            return Ok(None);
        };
        Ok(Some(ProcessLinks {
            ppid: i32::try_from(info.pbsi_ppid).map_err(io::Error::other)?,
            pgid: i32::try_from(info.pbsi_pgid).map_err(io::Error::other)?,
        }))
    }

    /// The kernel's own start time, the one `ps -o lstart` prints.
    pub(super) fn start_time(pid: u32) -> Option<String> {
        let info: libc::proc_bsdinfo =
            pid_info(libc::c_int::try_from(pid).ok()?, libc::PROC_PIDTBSDINFO)?;
        Some(format!(
            "{}.{:06}",
            info.pbi_start_tvsec, info.pbi_start_tvusec
        ))
    }

    pub(super) fn group_has_live_member(pgid: i32, include_exiting: bool) -> io::Result<bool> {
        // XNU hides exiting processes from regular PID lookups before it closes
        // their files. A nonzero argument lets us check whether they reached SZOMB.
        let arg = u64::from(include_exiting);
        for pid in group_pids(pgid)? {
            let info: Option<libc::proc_bsdshortinfo> =
                read_pid_info_with_arg(pid, libc::PROC_PIDT_SHORTBSDINFO, arg)?;
            let live_member = info.is_some_and(|info| {
                i32::try_from(info.pbsi_pgid) == Ok(pgid) && info.pbsi_status != libc::SZOMB
            });
            if live_member {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Every pid in the group `pgid`, members that exited unreaped included.
    fn group_pids(pgid: i32) -> io::Result<Vec<i32>> {
        let mut capacity = 64;
        loop {
            let mut pids = vec![0 as libc::pid_t; capacity];
            let bytes = libc::c_int::try_from(capacity * size_of::<libc::pid_t>())
                .map_err(io::Error::other)?;
            // SAFETY: errno is this thread's own.
            unsafe { *libc::__error() = 0 };
            // SAFETY: the buffer holds `bytes` bytes of pids.
            let count = unsafe { libc::proc_listpgrppids(pgid, pids.as_mut_ptr().cast(), bytes) };
            let count = listed_count(count, io::Error::last_os_error())?;
            // A full buffer may have missed members: read again, larger.
            if count < capacity {
                pids.truncate(count);
                return Ok(pids);
            }
            capacity *= 2;
        }
    }

    /// libproc answers 0 both for an empty group and for a call that failed
    /// (ENOMEM, an enumeration the kernel refused): only `errno`, cleared
    /// before the call, tells them apart.
    pub(super) fn listed_count(count: libc::c_int, errno: io::Error) -> io::Result<usize> {
        match usize::try_from(count) {
            Ok(0) if errno.raw_os_error().is_some_and(|code| code != 0) => Err(errno),
            Ok(count) => Ok(count),
            Err(_) => Err(errno),
        }
    }

    pub(super) fn all_pids() -> io::Result<Vec<i32>> {
        loop {
            // SAFETY: errno is this thread's own.
            unsafe { *libc::__error() = 0 };
            // SAFETY: a null buffer only asks for the table's size.
            let estimate = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
            let estimate = all_pid_count(estimate)?;
            // Room for processes started meanwhile; a full buffer may have
            // missed some, so read again.
            let capacity = estimate + 64;
            let mut pids = vec![0 as libc::pid_t; capacity];
            let bytes = libc::c_int::try_from(capacity * size_of::<libc::pid_t>())
                .map_err(io::Error::other)?;
            // SAFETY: errno is this thread's own.
            unsafe { *libc::__error() = 0 };
            // SAFETY: the buffer holds `bytes` bytes of pids.
            let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
            let count = all_pid_count(count)?;
            if count < capacity {
                pids.truncate(count);
                return Ok(pids);
            }
        }
    }

    fn all_pid_count(count: libc::c_int) -> io::Result<usize> {
        match listed_count(count, io::Error::last_os_error())? {
            0 => Err(io::Error::other(
                "the kernel returned an empty process table",
            )),
            count => Ok(count),
        }
    }

    /// One `proc_pidinfo` flavor, `None` when the process is gone or the
    /// flavor is refused for it.
    fn pid_info<T: Copy>(pid: libc::c_int, flavor: libc::c_int) -> Option<T> {
        read_pid_info(pid, flavor).ok().flatten()
    }

    /// One `proc_pidinfo` flavor, `None` only when the process is gone
    /// (ESRCH, which an exited, unreaped process answers too).
    pub(super) fn read_pid_info<T: Copy>(
        pid: libc::c_int,
        flavor: libc::c_int,
    ) -> io::Result<Option<T>> {
        read_pid_info_with_arg(pid, flavor, 0)
    }

    /// One `proc_pidinfo` flavor with an explicit `arg`, `None` when the kernel returns ESRCH.
    pub(super) fn read_pid_info_with_arg<T: Copy>(
        pid: libc::c_int,
        flavor: libc::c_int,
        arg: u64,
    ) -> io::Result<Option<T>> {
        let size = libc::c_int::try_from(size_of::<T>()).map_err(io::Error::other)?;
        // SAFETY: the proc_* info structs are plain integers, valid zeroed.
        let mut info: T = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is `size` writable bytes.
        let written = unsafe {
            libc::proc_pidinfo(pid, flavor, arg, std::ptr::from_mut(&mut info).cast(), size)
        };
        if written == size {
            return Ok(Some(info));
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(None),
            _ if written > 0 => Err(io::Error::other(format!(
                "proc_pidinfo wrote {written} of {size} bytes for pid {pid}"
            ))),
            _ => Err(error),
        }
    }
}

#[cfg(target_os = "linux")]
#[path = "process_table/linux.rs"]
mod platform;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use std::collections::HashMap;
    use std::io;
    use std::path::PathBuf;

    use super::ProcessLinks;

    pub(super) fn cwds(_pids: &[i32]) -> io::Result<HashMap<i32, PathBuf>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "reading process cwds is not supported on this platform",
        ))
    }

    pub(super) fn links() -> io::Result<HashMap<i32, ProcessLinks>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "reading the process table is not supported on this platform",
        ))
    }

    pub(super) fn start_time(_pid: u32) -> Option<String> {
        None
    }
}

/// Linux appends ` (deleted)` to the link of a directory removed under a
/// process; macOS keeps reporting its last path. Strip the marker so both
/// platforms attribute such a process to where it was started — unless a
/// directory by that literal name exists.
#[cfg(any(target_os = "linux", test))]
fn without_deleted_marker(path: PathBuf, exists: impl Fn(&std::path::Path) -> bool) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    const MARKER: &[u8] = b" (deleted)";
    let bytes = path.as_os_str().as_bytes();
    match bytes.strip_suffix(MARKER) {
        Some(original) if !exists(&path) => PathBuf::from(std::ffi::OsStr::from_bytes(original)),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_deleted_marker_is_stripped_unless_the_literal_directory_exists() {
        let deleted = PathBuf::from("/w/feature-a/src (deleted)");
        assert_eq!(
            without_deleted_marker(deleted.clone(), |_| false),
            PathBuf::from("/w/feature-a/src")
        );
        assert_eq!(without_deleted_marker(deleted.clone(), |_| true), deleted);
        let plain = PathBuf::from("/w/feature-a");
        assert_eq!(without_deleted_marker(plain.clone(), |_| false), plain);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn processes_that_exit_before_the_cwd_read_are_omitted_not_errors() {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let gone = i32::try_from(child.id()).unwrap();
        child.wait().unwrap();
        let this = i32::try_from(std::process::id()).unwrap();

        let found = cwds(&[gone, this, this]).await.unwrap();

        assert!(!found.contains_key(&gone));
        assert_eq!(
            std::fs::canonicalize(&found[&this]).unwrap(),
            std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap()
        );
    }

    /// A failed listing used to read as an empty group, so a group that
    /// refused a signal was taken for one that is gone.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_failed_group_listing_is_an_error_not_an_empty_group() {
        use std::io::Error;
        let failed = platform::listed_count(0, Error::from_raw_os_error(libc::ENOMEM));
        assert_eq!(failed.unwrap_err().raw_os_error(), Some(libc::ENOMEM));
        assert_eq!(
            platform::listed_count(0, Error::from_raw_os_error(0)).unwrap(),
            0
        );
        assert_eq!(
            platform::listed_count(3, Error::from_raw_os_error(0)).unwrap(),
            3
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_table_holds_this_process_with_its_parent_and_group() {
        let table = links().await.unwrap();
        let pid = i32::try_from(std::process::id()).unwrap();
        // SAFETY: getppid/getpgrp only read this process's own ids.
        let expected = unsafe {
            ProcessLinks {
                ppid: libc::getppid(),
                pgid: libc::getpgrp(),
            }
        };
        assert_eq!(table.get(&pid), Some(&expected));
        assert!(table.len() > 1, "{table:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_start_time_is_stable_and_absent_once_the_process_is_gone() {
        let pid = std::process::id();
        let first = start_time(pid).await;
        assert!(first.is_some());
        assert_eq!(first, start_time(pid).await);

        let mut child = std::process::Command::new("true").spawn().unwrap();
        let child_pid = child.id();
        child.wait().unwrap();
        assert_eq!(start_time(child_pid).await, None);
    }
}
