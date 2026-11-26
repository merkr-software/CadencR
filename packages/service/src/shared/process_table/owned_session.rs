//! Drain a private POSIX session while an exact anchor reserves its SID.
//! Outside processes cannot join a session
//! by setting their process group. Each signal still targets a kernel process
//! identity, never a numeric PID or a process group.

use std::collections::HashSet;
use std::io;
use std::time::Duration;

use tokio::time::Instant;

#[path = "verified_tree.rs"]
mod verified_tree;
pub(crate) use verified_tree::stop_verified_tree;
mod anchor;
pub(crate) use anchor::{BootIdentity, SessionAnchor};
mod snapshot;
#[cfg(test)]
use snapshot::Snapshot;
use snapshot::{confirmed_empty, members, Observed};

const TERM_GRACE: Duration = Duration::from_secs(1);
const KILL_GRACE: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(40);

/// The caller holds the direct child's wait until this returns, including on
/// retries. Every member that still runs in that session belongs to the launch.
#[cfg(test)]
pub(crate) async fn stop_pinned_session(leader: u32) -> io::Result<()> {
    let leader = i32::try_from(leader).map_err(io::Error::other)?;
    drain_session(leader, Some(leader), None).await
}

#[cfg(test)]
pub(crate) fn owned_process_is_live(pid: u32, sid: u32) -> io::Result<bool> {
    let pid = i32::try_from(pid).map_err(io::Error::other)?;
    let sid = i32::try_from(sid).map_err(io::Error::other)?;
    Ok(platform::Target::open(pid, sid)?.is_some())
}

async fn drain_session(
    leader: i32,
    excluded: Option<i32>,
    anchor: Option<&platform::Target>,
) -> io::Result<()> {
    let start = Instant::now();
    let mut first_signal: Option<Instant> = None;
    let mut terminated = HashSet::new();
    let mut empty = None;
    let mut failure = None;
    loop {
        // A cancelled future can abandon a blocking read. Only the task
        // that verifies the reserved session may send a signal.
        let mut snapshot = tokio::task::spawn_blocking(move || members(leader, excluded))
            .await
            .map_err(io::Error::other)??;
        verify_anchor(anchor)?;
        if confirmed_empty(&mut empty, &mut snapshot) {
            return Ok(());
        }
        for pid in snapshot.members {
            let target = match platform::Target::open(pid, leader) {
                Ok(Some(target)) => target,
                Ok(None) => continue,
                Err(error) => {
                    failure = Some(error);
                    continue;
                }
            };
            let hard = first_signal.get_or_insert_with(Instant::now).elapsed() >= TERM_GRACE;
            if hard || terminated.insert(pid) {
                // Identity checks after acquiring the target guarantee the
                // session could not have been replaced during that acquisition.
                verify_anchor(anchor)?;
                if !matches_session(pid, leader)? {
                    continue;
                }
                let signal = if hard { libc::SIGKILL } else { libc::SIGTERM };
                if let Err(error) = target.signal(signal) {
                    failure = Some(error);
                }
            }
        }
        if first_signal.unwrap_or(start).elapsed() >= TERM_GRACE + KILL_GRACE
            || start.elapsed() >= TERM_GRACE + KILL_GRACE + KILL_GRACE
        {
            return Err(failure.unwrap_or_else(|| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "could not verify that the owned session is empty",
                )
            }));
        }
        tokio::time::sleep(POLL).await;
    }
}

async fn confirm_no_peers(leader: i32) -> io::Result<()> {
    let deadline = Instant::now() + KILL_GRACE;
    let mut empty = None;
    loop {
        let mut snapshot = tokio::task::spawn_blocking(move || members(leader, None))
            .await
            .map_err(io::Error::other)??;
        if confirmed_empty(&mut empty, &mut snapshot) {
            return Ok(());
        }
        if !snapshot.members.is_empty() || Instant::now() >= deadline {
            return Err(io::Error::other(format!(
                "cannot verify ownership of the remaining processes in session {leader}"
            )));
        }
        tokio::time::sleep(POLL).await;
    }
}

fn verify_anchor(anchor: Option<&platform::Target>) -> io::Result<()> {
    if let Some(anchor) = anchor {
        if !anchor.live()? {
            return Err(io::Error::other(
                "the recorded process session lost its anchor",
            ));
        }
    }
    Ok(())
}

pub(crate) async fn pinned_session_has_work(
    leader: u32,
    excluded: Option<i32>,
) -> io::Result<bool> {
    let leader = i32::try_from(leader).map_err(io::Error::other)?;
    let snapshot = tokio::task::spawn_blocking(move || members(leader, excluded))
        .await
        .map_err(io::Error::other)??;
    Ok(snapshot.incomplete || !snapshot.members.is_empty())
}

#[cfg(test)]
#[path = "owned_session_tests.rs"]
mod tests;

fn matches_session(pid: i32, leader: i32) -> io::Result<bool> {
    if pid <= 0 {
        return Ok(false);
    }
    session_id(pid).map(|sid| sid == Some(leader))
}

fn session_id(pid: i32) -> io::Result<Option<i32>> {
    // SAFETY: getsid only looks up an integer PID.
    let sid = unsafe { libc::getsid(pid) };
    if sid != -1 {
        return Ok(Some(sid));
    }
    ignore_gone(io::Error::last_os_error()).map(|()| None)
}

fn ignore_gone(error: io::Error) -> io::Result<()> {
    match error.raw_os_error() {
        Some(libc::ESRCH | libc::ENOENT) => Ok(()),
        _ => Err(error),
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    use super::{ignore_gone, matches_session, Observed};

    pub(super) fn pids() -> io::Result<Vec<i32>> {
        std::fs::read_dir("/proc")?
            .map(|entry| {
                entry.map(|entry| {
                    entry
                        .file_name()
                        .to_str()
                        .and_then(|name| name.parse().ok())
                })
            })
            .filter_map(Result::transpose)
            .collect()
    }

    pub(super) fn observe(pid: i32) -> io::Result<Observed> {
        let bytes = match std::fs::read(format!("/proc/{pid}/stat")) {
            Ok(bytes) => bytes,
            Err(error) => return ignore_gone(error).map(|()| Observed::Vanished),
        };
        let mut fields = crate::shared::process_table::platform::stat_fields(&bytes)
            .ok_or_else(|| io::Error::other("invalid process stat"))?;
        if matches!(fields.next(), Some("Z" | "X")) {
            return Ok(Observed::Exited);
        }
        let sid = fields
            .nth(2)
            .and_then(|field| field.parse().ok())
            .ok_or_else(|| io::Error::other("no session in process stat"))?;
        Ok(Observed::Live(sid))
    }

    pub(super) fn anchor_generation(pid: i32) -> io::Result<Option<String>> {
        let stat = match std::fs::read(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) => return ignore_gone(error).map(|()| None),
        };
        let start_ticks = crate::shared::process_table::platform::stat_fields(&stat)
            .and_then(|mut fields| fields.nth(22 - 3))
            .ok_or_else(|| io::Error::other("invalid process start time"))?;
        let endpoint = match std::fs::read_link(format!("/proc/{pid}/fd/0")) {
            Ok(endpoint) => endpoint,
            Err(error) => return ignore_gone(error).map(|()| None),
        };
        let Some(pipe) = endpoint.to_str().filter(|name| name.starts_with("pipe:[")) else {
            return Ok(None);
        };
        Ok(Some(format!("{start_ticks}:{pipe}")))
    }

    pub(super) struct Target {
        handle: OwnedFd,
    }

    impl Target {
        pub(super) fn open(pid: i32, leader: i32) -> io::Result<Option<Self>> {
            Self::capture_if(pid, || matches_session(pid, leader))
        }

        pub(super) fn capture_if(
            pid: i32,
            belongs: impl FnOnce() -> io::Result<bool>,
        ) -> io::Result<Option<Self>> {
            // SAFETY: pidfd_open takes an integer PID and zero flags.
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
            if fd == -1 {
                return ignore_gone(io::Error::last_os_error()).map(|()| None);
            }
            // SAFETY: the successful syscall returned an owned descriptor.
            let target = Self {
                handle: unsafe { OwnedFd::from_raw_fd(fd as i32) },
            };
            Ok((target.live()? && belongs()?).then_some(target))
        }

        pub(super) fn live(&self) -> io::Result<bool> {
            let mut poll = libc::pollfd {
                fd: self.handle.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: poll points to one initialized descriptor. POLLIN means exited.
            if unsafe { libc::poll(&mut poll, 1, 0) } < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(poll.revents == 0)
        }

        pub(super) fn signal(&self, signal: libc::c_int) -> io::Result<()> {
            // SAFETY: this descriptor identifies the exact process fetched
            // above. Its numeric PID being reused cannot redirect the signal.
            let result = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    self.handle.as_raw_fd(),
                    signal,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            };
            if result == -1 {
                return ignore_gone(io::Error::last_os_error());
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::io;

    use super::{ignore_gone, matches_session, session_id, Observed};
    use crate::shared::process_table::platform::{all_pids, read_pid_info, read_pid_info_with_arg};

    // XNU's PROC_PIDUNIQIDENTIFIERINFO (flavor 17) exposes the same PID
    // generation that the kernel checks in an audit-token signal.
    #[derive(Clone, Copy)]
    #[repr(C)]
    struct UniqueProcessInfo {
        executable: [u8; 16],
        unique_id: u64,
        parent_id: u64,
        pid_version: i32,
        original_parent_version: i32,
        reserved: [u64; 2],
    }

    extern "C" {
        fn proc_signal_with_audittoken(token: *const [u32; 8], signal: libc::c_int) -> libc::c_int;
    }

    pub(super) fn pids() -> io::Result<Vec<i32>> {
        all_pids()
    }

    pub(super) fn observe(pid: i32) -> io::Result<Observed> {
        let Some(info) = read_pid_info_with_arg::<libc::proc_bsdshortinfo>(
            pid,
            libc::PROC_PIDT_SHORTBSDINFO,
            1,
        )?
        else {
            return Ok(Observed::Vanished);
        };
        if info.pbsi_status == libc::SZOMB {
            return Ok(Observed::Exited);
        }
        Ok(session_id(pid)?.map_or(Observed::Vanished, Observed::Live))
    }

    pub(super) fn anchor_generation(pid: i32) -> io::Result<Option<String>> {
        Ok(read_pid_info::<UniqueProcessInfo>(pid, 17)?.map(|info| info.unique_id.to_string()))
    }

    pub(super) struct Target {
        pid: i32,
        version: i32,
    }

    impl Target {
        pub(super) fn open(pid: i32, leader: i32) -> io::Result<Option<Self>> {
            Self::capture_if(pid, || matches_session(pid, leader))
        }

        pub(super) fn capture_if(
            pid: i32,
            belongs: impl FnOnce() -> io::Result<bool>,
        ) -> io::Result<Option<Self>> {
            let Some(first) = read_pid_info::<UniqueProcessInfo>(pid, 17)? else {
                return Ok(None);
            };
            let Some(info) =
                read_pid_info::<libc::proc_bsdshortinfo>(pid, libc::PROC_PIDT_SHORTBSDINFO)?
            else {
                return Ok(None);
            };
            if info.pbsi_status == libc::SZOMB || !belongs()? {
                return Ok(None);
            }
            let same = read_pid_info::<UniqueProcessInfo>(pid, 17)?
                .is_some_and(|last| last.pid_version == first.pid_version);
            Ok(same.then_some(Self {
                pid,
                version: first.pid_version,
            }))
        }

        pub(super) fn live(&self) -> io::Result<bool> {
            let same = read_pid_info::<UniqueProcessInfo>(self.pid, 17)?
                .is_some_and(|info| info.pid_version == self.version);
            if !same {
                return Ok(false);
            }
            Ok(
                read_pid_info::<libc::proc_bsdshortinfo>(self.pid, libc::PROC_PIDT_SHORTBSDINFO)?
                    .is_some_and(|info| info.pbsi_status != libc::SZOMB),
            )
        }

        pub(super) fn signal(&self, signal: libc::c_int) -> io::Result<()> {
            // XNU uses only these two fields to locate the target; permission
            // is checked against the calling process by the syscall itself.
            let mut token = [0; 8];
            token[5] = self.pid as u32;
            token[7] = self.version as u32;
            // SAFETY: the audit token ABI is eight 32-bit words.
            let result = unsafe { proc_signal_with_audittoken(&token, signal) };
            if result == 0 {
                return Ok(());
            }
            ignore_gone(io::Error::from_raw_os_error(result))
        }
    }
}
