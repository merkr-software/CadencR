//! Tell a process group that is gone from one this process may not signal.
//!
//! XNU excludes zombies while signaling a process group, so a group whose
//! remaining members all exited (and await their parent, often launchd, to
//! reap them) answers `kill` with EPERM, as does a group holding a live
//! process this one may not signal. A group whose last member was just
//! reaped can also answer EPERM, not ESRCH, for a few milliseconds on a
//! loaded machine. Only a live member makes it a failure, and the group's
//! members tell that at once: waiting for the reap or for ESRCH would make
//! the answer depend on how loaded the machine is.
//! https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c

use std::io;

/// Whether every process left in the group `pid` leads has exited (none at
/// all included).
pub(super) fn only_exited_members(pid: u32) -> io::Result<bool> {
    let pgid = libc::pid_t::try_from(pid).map_err(io::Error::other)?;
    Ok(!crate::shared::process_table::group_has_live_member(pgid)?)
}

/// Never repeats the destructive signal: a group reported as EPERM is
/// reconciled by reading its members, not by signaling it again.
pub(super) fn reconcile_permission_denied(
    kill: impl FnOnce() -> io::Result<()>,
    only_exited_members: impl FnOnce() -> io::Result<bool>,
) -> io::Result<()> {
    let kill_error = match kill() {
        Ok(()) => return Ok(()),
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => error,
        Err(error) => return Err(error),
    };
    if only_exited_members()? {
        Ok(())
    } else {
        Err(kill_error)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::os::unix::process::CommandExt;

    use super::*;
    use crate::shared::process_table::group_has_live_member;

    fn error(code: libc::c_int) -> io::Error {
        io::Error::from_raw_os_error(code)
    }

    #[test]
    fn a_group_of_exited_processes_is_gone_without_a_second_kill() {
        let kills = Cell::new(0);
        reconcile_permission_denied(
            || {
                kills.set(kills.get() + 1);
                Err(error(libc::EPERM))
            },
            || Ok(true),
        )
        .expect("only zombies are left: the group is dead");
        assert_eq!(kills.get(), 1);
    }

    #[test]
    fn a_live_member_that_refuses_the_signal_is_a_failure() {
        let result = reconcile_permission_denied(|| Err(error(libc::EPERM)), || Ok(false));
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EPERM));
    }

    #[test]
    fn other_errors_are_kept_and_a_signaled_group_needs_no_reading() {
        let reads = Cell::new(0);
        let read = || {
            reads.set(reads.get() + 1);
            Ok(true)
        };
        reconcile_permission_denied(|| Ok(()), read).unwrap();
        let result = reconcile_permission_denied(|| Err(error(libc::EINVAL)), read);
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EINVAL));
        assert_eq!(reads.get(), 0);
        let unreadable =
            reconcile_permission_denied(|| Err(error(libc::EPERM)), || Err(error(libc::EACCES)));
        assert_eq!(unreadable.unwrap_err().raw_os_error(), Some(libc::EACCES));
    }

    #[test]
    fn a_group_left_with_only_a_zombie_is_killed_at_once() {
        // The zombie's parent (this test) does not reap it yet, as launchd may
        // not on a loaded machine: XNU answers the group's SIGKILL with EPERM.
        let mut child = std::process::Command::new("/usr/bin/true")
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = child.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match super::super::try_signal_process_group(pgid, 0) {
                Err(error) if error.raw_os_error() == Some(libc::EPERM) => break,
                _ if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                other => panic!("/usr/bin/true never exited: {other:?}"),
            }
        }
        assert!(!group_has_live_member(pgid as i32).unwrap());

        let kill = |pgid| super::super::kill_group_after_leader_exit(pgid);
        futures::executor::block_on(kill(pgid)).expect("a zombie-only group is already dead");
        child.wait().unwrap();
        futures::executor::block_on(kill(pgid)).expect("a vanished group is fine");
    }

    #[test]
    fn a_live_member_is_not_mistaken_for_an_exited_one() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let _cleanup = crate::shared::test_processes::KillOnDrop::default().group(child.id());
        assert!(group_has_live_member(child.id() as i32).unwrap());
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
