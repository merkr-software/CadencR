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

/// Whether a process that has not exited is still in the group `pgid`
/// (macOS). `proc_listpgrppids` still lists a member that exited and awaits
/// reaping, which `proc_pidinfo` then reports as gone: such a member is
/// dead, as is one a reused pid moved out of the group since the listing.
/// A process that joins the group (`setpgid`) after the listing is missed;
/// Cadencr never moves a process into an existing group.
#[cfg(target_os = "macos")]
pub(crate) fn group_has_live_member(pgid: i32) -> io::Result<bool> {
    platform::group_has_live_member(pgid)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::collections::HashMap;
    use std::io;
    use std::mem::size_of;

    use super::ProcessLinks;

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

    /// The kernel's own start time, the one `ps -o lstart` prints.
    pub(super) fn start_time(pid: u32) -> Option<String> {
        let info: libc::proc_bsdinfo =
            pid_info(libc::c_int::try_from(pid).ok()?, libc::PROC_PIDTBSDINFO)?;
        Some(format!(
            "{}.{:06}",
            info.pbi_start_tvsec, info.pbi_start_tvusec
        ))
    }

    pub(super) fn group_has_live_member(pgid: i32) -> io::Result<bool> {
        for pid in group_pids(pgid)? {
            let info: Option<libc::proc_bsdshortinfo> =
                read_pid_info(pid, libc::PROC_PIDT_SHORTBSDINFO)?;
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

    fn all_pids() -> io::Result<Vec<i32>> {
        loop {
            // SAFETY: a null buffer only asks for the table's size.
            let estimate = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
            let estimate = usize::try_from(estimate).map_err(|_| io::Error::last_os_error())?;
            // Room for processes started meanwhile; a full buffer may have
            // missed some, so read again.
            let capacity = estimate + 64;
            let mut pids = vec![0 as libc::pid_t; capacity];
            let bytes = libc::c_int::try_from(capacity * size_of::<libc::pid_t>())
                .map_err(io::Error::other)?;
            // SAFETY: the buffer holds `bytes` bytes of pids.
            let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
            let count = usize::try_from(count).map_err(|_| io::Error::last_os_error())?;
            if count < capacity {
                pids.truncate(count);
                return Ok(pids);
            }
        }
    }

    /// One `proc_pidinfo` flavor, `None` when the process is gone or the
    /// flavor is refused for it.
    fn pid_info<T: Copy>(pid: libc::c_int, flavor: libc::c_int) -> Option<T> {
        read_pid_info(pid, flavor).ok().flatten()
    }

    /// One `proc_pidinfo` flavor, `None` only when the process is gone
    /// (ESRCH, which an exited, unreaped process answers too).
    fn read_pid_info<T: Copy>(pid: libc::c_int, flavor: libc::c_int) -> io::Result<Option<T>> {
        let size = libc::c_int::try_from(size_of::<T>()).map_err(io::Error::other)?;
        // SAFETY: the proc_* info structs are plain integers, valid zeroed.
        let mut info: T = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is `size` writable bytes.
        let written = unsafe {
            libc::proc_pidinfo(pid, flavor, 0, std::ptr::from_mut(&mut info).cast(), size)
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
mod platform {
    use std::collections::HashMap;
    use std::io;

    use super::{stat_fields, ProcessLinks};

    pub(super) fn links() -> io::Result<HashMap<i32, ProcessLinks>> {
        let mut links = HashMap::new();
        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse().ok())
            else {
                continue;
            };
            // Unreadable once the process has exited: not in the table.
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            if let Some(found) = super::stat_links(&stat) {
                links.insert(pid, found);
            }
        }
        Ok(links)
    }

    /// The kernel's tick count, which `ps -o lstart` would round through the
    /// wall clock (and can shift by a second between calls).
    pub(super) fn start_time(pid: u32) -> Option<String> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        stat_fields(&stat)?.nth(22 - 3).map(str::to_string)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use std::collections::HashMap;
    use std::io;

    use super::ProcessLinks;

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

/// Fields 3 onward of `/proc/<pid>/stat`. The command name (field 2) is in
/// parentheses and may itself contain spaces and parentheses, so fields are
/// counted from the last `)`.
#[cfg(any(target_os = "linux", test))]
fn stat_fields(stat: &str) -> Option<std::str::SplitWhitespace<'_>> {
    stat.rsplit_once(')')
        .map(|(_, fields)| fields.split_whitespace())
}

/// Fields 4 (parent) and 5 (process group).
#[cfg(any(target_os = "linux", test))]
fn stat_links(stat: &str) -> Option<ProcessLinks> {
    let mut fields = stat_fields(stat)?.skip(1);
    Some(ProcessLinks {
        ppid: fields.next()?.parse().ok()?,
        pgid: fields.next()?.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_fields_are_read_past_a_command_name_with_spaces() {
        let stat = "4242 (my (odd) cmd) S 1 4242 4242 0 -1 4194560 120 0 0 0 1 2 0 0 \
                    20 0 1 0 987654 1000 10";
        assert_eq!(
            stat_links(stat),
            Some(ProcessLinks {
                ppid: 1,
                pgid: 4242
            })
        );
        assert_eq!(stat_fields(stat).unwrap().nth(22 - 3), Some("987654"));
        assert_eq!(stat_links("garbage"), None);
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
