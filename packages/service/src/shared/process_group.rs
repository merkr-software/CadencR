//! Unix process groups: the one place that signals a whole group.
//!
//! A command spawned after [`lead_new_process_group`] leads a group whose id
//! is its pid, so a signal sent to that group reaches every descendant: a
//! shell's pipeline or the `sleep 60 &` it left behind, which would otherwise
//! keep the output pipes open after the shell itself dies. macOS needs one
//! workaround, for groups that are gone or hold only zombies (see
//! `macos_signal`).
//! Other platforms have no process groups and keep their single-process kill.

use std::io;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::Child;
#[cfg(unix)]
use tokio::process::Command;

#[cfg(target_os = "macos")]
mod macos_signal;
#[cfg(unix)]
mod shutdown;
#[cfg(unix)]
pub(crate) use shutdown::{
    interrupt_process_group, kill_group_after_leader_exit_and_drain, stop_process_group,
    terminate_process_group,
};

/// Make the command lead a new process group, so signals sent to that group
/// reach every descendant.
#[cfg(unix)]
pub(crate) fn lead_new_process_group(command: &mut Command) {
    command.process_group(0);
}

/// Signal every process of the group `pid` leads; a vanished group is fine.
#[cfg(unix)]
pub(crate) fn signal_process_group(pid: u32, signal: libc::c_int) -> io::Result<()> {
    signal_group_with(pid, || try_signal_process_group(pid, signal))
}

/// What `send` (a signal to the group `pid` leads) answered, with a group
/// that is gone counted as signaled.
#[cfg(unix)]
fn signal_group_with(pid: u32, send: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
    let sent = match send() {
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        result => result,
    };
    reconcile_vanished(pid, sent)
}

/// macOS also answers EPERM for a group that is gone or holds only zombies;
/// the group's members tell that apart from a live process this one may not
/// signal.
#[cfg(target_os = "macos")]
fn reconcile_vanished(pid: u32, sent: io::Result<()>) -> io::Result<()> {
    macos_signal::reconcile_permission_denied(|| sent, || macos_signal::only_exited_members(pid))
}

/// Linux signals zombies and drops a reaped process from its group before
/// `wait` returns, so a gone group is always ESRCH and an EPERM always means
/// a live member this process may not signal.
#[cfg(all(unix, not(target_os = "macos")))]
fn reconcile_vanished(_pid: u32, sent: io::Result<()>) -> io::Result<()> {
    sent
}

/// Signal every process of the group `pid` leads, reporting every failure
/// (`ESRCH` for a group that is gone included).
#[cfg(unix)]
pub(crate) fn try_signal_process_group(pid: u32, signal: libc::c_int) -> io::Result<()> {
    // Safety: a bare kill(2) on a process group, with no memory involved.
    let result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Whether a live process remains in the group `pid` leads (zombies the
/// kernel refuses to signal do not count).
#[cfg(unix)]
pub(crate) fn process_group_alive(pid: u32) -> bool {
    try_signal_process_group(pid, 0).is_ok()
}

/// SIGKILL what is left of a process group whose leader has exited (macOS
/// excludes the zombie leader from group signals; [`signal_process_group`]
/// reconciles that).
#[cfg(unix)]
pub(crate) async fn kill_group_after_leader_exit(pid: u32) -> io::Result<()> {
    signal_process_group(pid, libc::SIGKILL)
}

/// SIGKILLs, when dropped, the process group a still-unreaped child leads —
/// the abandoned launcher's hooks, aliases and filters with it. Disarm it
/// once the leader is reaped: until then the leader's zombie keeps the group
/// id taken, so the signal can never reach a group that reused it.
pub(crate) struct KillGroupOnDrop {
    pid: Option<u32>,
}

impl KillGroupOnDrop {
    /// Guard the group `pid` leads (a child spawned after
    /// [`lead_new_process_group`]); `None` guards nothing.
    pub(crate) fn new(pid: Option<u32>) -> Self {
        Self { pid }
    }

    pub(crate) fn disarm(&mut self) {
        self.pid = None;
    }

    /// Kill the group now (a failed or timed-out run) instead of on drop.
    pub(crate) fn kill(&mut self) {
        let Some(pid) = self.pid.take() else {
            return;
        };
        #[cfg(unix)]
        crate::shared::discard::cleanup(
            signal_process_group(pid, libc::SIGKILL),
            "kill an abandoned process group",
        );
        #[cfg(not(unix))]
        drop(pid);
    }
}

impl Drop for KillGroupOnDrop {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Wait for `child` to exit, failing once `deadline` has passed.
async fn wait_until(child: &mut Child, deadline: tokio::time::Instant) -> io::Result<ExitStatus> {
    tokio::time::timeout_at(deadline, child.wait())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "process did not exit after kill"))?
}

/// Wait for `child` to exit, failing once `timeout` has passed.
pub(crate) async fn wait_bounded(child: &mut Child, timeout: Duration) -> io::Result<ExitStatus> {
    wait_until(child, tokio::time::Instant::now() + timeout).await
}

#[cfg(all(test, unix))]
mod tests {
    use std::path::Path;
    use std::process::Stdio;

    use super::*;

    pub(super) fn read_pid(path: &Path) -> libc::pid_t {
        std::fs::read_to_string(path)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    pub(super) async fn wait_for_file(path: &Path) {
        for _ in 0..100 {
            if std::fs::read_to_string(path).is_ok_and(|text| !text.trim().is_empty()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("{} was never written", path.display());
    }

    pub(super) async fn process_gone(pid: libc::pid_t) -> bool {
        // An orphaned grandchild is reaped by init asynchronously.
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        unsafe { libc::kill(pid, libc::SIGKILL) };
        false
    }

    /// A background `sleep` that writes its pid to the leader's `$1` once set up.
    pub(super) const GRANDCHILD: &str = "/bin/sh -c 'echo $$ > \"$0\"; exec sleep 30' \"$1\" &";
    /// The same, ignoring SIGTERM (set before its pid is written), so only a
    /// SIGKILL ends it.
    pub(super) const STUBBORN_GRANDCHILD: &str =
        "/bin/sh -c 'trap \"\" TERM; echo $$ > \"$0\"; exec sleep 30' \"$1\" &";

    /// `/bin/sh -c script` leading its own group, with `pid_file` as `$1`.
    pub(super) fn group_leader(pid_file: &Path, script: &str) -> Child {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", script, "process-group-test"])
            .arg(pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        lead_new_process_group(&mut command);
        command.spawn().unwrap()
    }

    #[tokio::test]
    async fn a_new_group_is_signalled_as_a_whole() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        let mut child = group_leader(&pid_file, &format!("{GRANDCHILD} wait"));
        let leader = child.id().unwrap();
        wait_for_file(&pid_file).await;
        let grandchild = read_pid(&pid_file);
        assert_eq!(unsafe { libc::getpgid(grandchild) }, leader as libc::pid_t);
        assert!(process_group_alive(leader));

        signal_process_group(leader, libc::SIGKILL).unwrap();
        child.wait().await.unwrap();
        assert!(process_gone(grandchild).await, "the grandchild survived");
        assert!(!process_group_alive(leader));
    }

    #[tokio::test]
    async fn a_vanished_group_is_fine_unless_asked_strictly() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .spawn()
            .unwrap();
        let leader = child.id().unwrap();
        child.wait().await.unwrap();

        signal_process_group(leader, libc::SIGTERM).expect("ESRCH is not a failure");
        let error = try_signal_process_group(leader, libc::SIGTERM).unwrap_err();
        // XNU may still answer EPERM for a moment after the reap.
        let vanished: &[i32] = if cfg!(target_os = "macos") {
            &[libc::ESRCH, libc::EPERM]
        } else {
            &[libc::ESRCH]
        };
        assert!(
            vanished.contains(&error.raw_os_error().unwrap_or_default()),
            "{error}"
        );
    }

    pub(super) fn eperm() -> io::Result<()> {
        Err(io::Error::from_raw_os_error(libc::EPERM))
    }

    /// Found under load: XNU answered EPERM, not ESRCH, for a few milliseconds
    /// after the group's only member was reaped, and the vanished group was
    /// reported as a failure. The EPERM is simulated, so the answer no longer
    /// depends on the machine's load.
    #[tokio::test]
    async fn an_eperm_from_a_group_that_is_gone_is_not_a_failure() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .spawn()
            .unwrap();
        let leader = child.id().unwrap();
        child.wait().await.unwrap();

        let result = signal_group_with(leader, eperm);
        if cfg!(target_os = "macos") {
            result.expect("no member is left: the group is gone");
        } else {
            // Linux never answers EPERM for a gone group: one is a live member.
            assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EPERM));
        }
    }

    /// Found in QA under a seccomp filter that refused SIGTERM but not
    /// SIGKILL: the stop gave up at the refused SIGTERM.
    #[tokio::test]
    async fn an_eperm_from_a_group_with_a_live_member_stays_a_failure() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = group_leader(&directory.path().join("unused.pid"), "exec sleep 30");
        let leader = child.id().unwrap();

        let result = signal_group_with(leader, eperm);
        child.kill().await.unwrap();
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EPERM));
    }
}
