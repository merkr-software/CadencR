//! Unix process groups: the one place that signals a whole group.
//!
//! A command spawned after [`lead_new_process_group`] leads a group whose id
//! is its pid, so a signal sent to that group reaches every descendant: a
//! shell's pipeline or the `sleep 60 &` it left behind, which would otherwise
//! keep the output pipes open after the shell itself dies. macOS needs one
//! workaround, for groups whose leader has exited (see `macos_signal`).
//! Other platforms have no process groups and keep their single-process kill.

use std::io;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::Child;
#[cfg(unix)]
use tokio::process::Command;

#[cfg(target_os = "macos")]
mod macos_signal;

/// Make the command lead a new process group, so signals sent to that group
/// reach every descendant.
#[cfg(unix)]
pub(crate) fn lead_new_process_group(command: &mut Command) {
    command.process_group(0);
}

/// Signal every process of the group `pid` leads; a vanished group is fine.
#[cfg(unix)]
pub(crate) fn signal_process_group(pid: u32, signal: libc::c_int) -> io::Result<()> {
    match try_signal_process_group(pid, signal) {
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        result => result,
    }
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
/// excludes the zombie leader from group signals; see `macos_signal`).
#[cfg(unix)]
pub(crate) async fn kill_group_after_leader_exit(pid: u32) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos_signal::cleanup_after_exit(pid).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        signal_process_group(pid, libc::SIGKILL)
    }
}

/// Stop the group `child` leads: SIGTERM, then `grace` for the leader to
/// exit. If it does, SIGKILL whatever it left behind; if not, SIGKILL the
/// whole group and wait `grace` more for the leader.
#[cfg(unix)]
pub(crate) async fn terminate_process_group(
    child: &mut Child,
    grace: Duration,
) -> io::Result<ExitStatus> {
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("process group leader has no process id"))?;
    signal_process_group(pid, libc::SIGTERM)?;
    match tokio::time::timeout(grace, child.wait()).await {
        Ok(status) => {
            let status = status?;
            #[cfg(target_os = "macos")]
            macos_signal::kill_after_leader_exit(pid, grace).await?;
            #[cfg(not(target_os = "macos"))]
            signal_process_group(pid, libc::SIGKILL)?;
            Ok(status)
        }
        Err(_) => {
            signal_process_group(pid, libc::SIGKILL)?;
            wait_bounded(child, grace).await
        }
    }
}

/// Wait for `child` to exit, failing once `timeout` has passed.
pub(crate) async fn wait_bounded(child: &mut Child, timeout: Duration) -> io::Result<ExitStatus> {
    tokio::time::timeout(timeout, child.wait())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "process did not exit after kill"))?
}

#[cfg(all(test, unix))]
mod tests {
    use std::path::Path;
    use std::process::Stdio;

    use super::*;

    fn read_pid(path: &Path) -> libc::pid_t {
        std::fs::read_to_string(path)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    async fn wait_for_file(path: &Path) {
        for _ in 0..100 {
            if std::fs::read_to_string(path).is_ok_and(|text| !text.trim().is_empty()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("{} was never written", path.display());
    }

    async fn process_gone(pid: libc::pid_t) -> bool {
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
    const GRANDCHILD: &str = "/bin/sh -c 'echo $$ > \"$0\"; exec sleep 30' \"$1\" &";
    /// The same, ignoring SIGTERM (set before its pid is written), so only a
    /// SIGKILL ends it.
    const STUBBORN_GRANDCHILD: &str =
        "/bin/sh -c 'trap \"\" TERM; echo $$ > \"$0\"; exec sleep 30' \"$1\" &";

    /// `/bin/sh -c script` leading its own group, with `pid_file` as `$1`.
    fn group_leader(pid_file: &Path, script: &str) -> Child {
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
        assert_eq!(error.raw_os_error(), Some(libc::ESRCH));
    }

    #[tokio::test]
    async fn terminate_kills_what_an_exited_leader_left_behind() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        // The shell exits on SIGTERM; its grandchild ignores it, so only the
        // SIGKILL that follows the leader's exit ends it. Both are set up
        // before the pid file appears.
        let mut child = group_leader(
            &pid_file,
            &format!("trap 'exit 0' TERM; {STUBBORN_GRANDCHILD} wait"),
        );
        wait_for_file(&pid_file).await;
        let grandchild = read_pid(&pid_file);

        terminate_process_group(&mut child, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(process_gone(grandchild).await, "the grandchild survived");
    }

    #[tokio::test]
    async fn terminate_escalates_to_sigkill_when_term_is_ignored() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        let mut child = group_leader(
            &pid_file,
            &format!("trap '' TERM; {STUBBORN_GRANDCHILD} while :; do sleep 1; done"),
        );
        wait_for_file(&pid_file).await;
        let grandchild = read_pid(&pid_file);

        let status = terminate_process_group(&mut child, Duration::from_millis(300))
            .await
            .unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert!(process_gone(grandchild).await, "the grandchild survived");
    }
}
