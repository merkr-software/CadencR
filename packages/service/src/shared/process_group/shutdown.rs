//! Bounded shutdown of Unix process groups.

use std::io;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::Child;
use tokio::time::{sleep_until, timeout_at, Instant};

#[cfg(not(target_os = "macos"))]
use super::try_signal_process_group;
use super::{
    kill_group_after_leader_exit, process_group_alive, signal_process_group, wait_bounded,
    wait_until,
};

/// Give the leader `grace` to exit after SIGTERM, then SIGKILL any remaining
/// members. Reap the leader and drain the group within one post-KILL budget.
pub(crate) async fn terminate_process_group(
    child: &mut Child,
    grace: Duration,
) -> io::Result<ExitStatus> {
    terminate_group_with(child, grace, signal_process_group).await
}

async fn terminate_group_with(
    child: &mut Child,
    grace: Duration,
    signal: impl Fn(u32, libc::c_int) -> io::Result<()>,
) -> io::Result<ExitStatus> {
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("process group leader has no process id"))?;
    let term_error = match signal(pid, libc::SIGTERM) {
        Ok(()) => {
            if let Ok(status) = timeout_at(Instant::now() + grace, child.wait()).await {
                let status = status?;
                kill_group_after_leader_exit_and_drain(pid, grace).await?;
                return Ok(status);
            }
            None
        }
        // A sandbox can deny SIGTERM while allowing SIGKILL.
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => None,
        Err(error) => Some(error),
    };

    signal(pid, libc::SIGKILL)?;
    let deadline = Instant::now() + grace;
    let status = wait_until(child, deadline).await?;
    drain_process_group(pid, deadline).await?;
    match term_error {
        Some(error) => Err(error),
        None => Ok(status),
    }
}

/// Stop descendants of a reaped leader and wait for them to release their
/// resources, including session leases, within `grace`.
pub(crate) async fn kill_group_after_leader_exit_and_drain(
    pid: u32,
    grace: Duration,
) -> io::Result<()> {
    kill_group_after_leader_exit(pid).await?;
    drain_process_group(pid, Instant::now() + grace).await
}

async fn drain_process_group(pid: u32, deadline: Instant) -> io::Result<()> {
    const GROUP_POLL: Duration = Duration::from_millis(20);
    timeout_at(deadline, async {
        while group_has_unfinished_member(pid).await? {
            sleep_until((Instant::now() + GROUP_POLL).min(deadline)).await;
        }
        Ok(())
    })
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "process group did not exit after kill",
        )
    })?
}

async fn group_has_unfinished_member(pid: u32) -> io::Result<bool> {
    // macOS can stop delivering signals before closing the member's files.
    #[cfg(not(target_os = "macos"))]
    match try_signal_process_group(pid, 0) {
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(false),
        result => result?,
    }
    // Linux signal 0 still sees members that have exited but remain unreaped.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let pgid = libc::pid_t::try_from(pid).map_err(io::Error::other)?;
        tokio::task::spawn_blocking(move || {
            crate::shared::process_table::group_has_unfinished_member(pgid)
        })
        .await
        .map_err(io::Error::other)?
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Ok(true)
}

/// Interrupt the group `child` leads like Ctrl-C does a terminal job: `signal`
/// (SIGINT), then `grace` for the whole group to exit, then SIGKILL whatever
/// is left. Unlike [`terminate_process_group`], members that outlive the
/// leader get the rest of the grace too, and a member that ignores `signal`
/// (a non-interactive shell's background job ignores SIGINT) still dies.
/// Returns the leader's status.
pub(crate) async fn interrupt_process_group(
    child: &mut Child,
    signal: libc::c_int,
    grace: Duration,
) -> io::Result<ExitStatus> {
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("process group leader has no process id"))?;
    let deadline = tokio::time::Instant::now() + grace;
    if let Err(error) = signal_process_group(pid, signal) {
        // Still end the group, but report why it got no chance to clean up.
        signal_process_group(pid, libc::SIGKILL)?;
        wait_bounded(child, grace).await?;
        return Err(error);
    }
    let Ok(status) = tokio::time::timeout_at(deadline, child.wait()).await else {
        signal_process_group(pid, libc::SIGKILL)?;
        return wait_bounded(child, grace).await;
    };
    let status = status?;
    wait_group_gone(pid, deadline).await;
    kill_group_after_leader_exit(pid).await?;
    Ok(status)
}

/// Stop a group whose leader is not a child this process waits on (it has
/// exited, or was started by another process): SIGTERM, up to `grace` for
/// every member to exit, then SIGKILL whatever is left. A group that is
/// already gone is fine.
pub(crate) async fn stop_process_group(pgid: u32, grace: Duration) -> io::Result<()> {
    stop_group_with(pgid, grace, signal_process_group).await
}

/// [`stop_process_group`], sending each signal through `signal`.
async fn stop_group_with(
    pgid: u32,
    grace: Duration,
    signal: impl Fn(u32, libc::c_int) -> io::Result<()>,
) -> io::Result<()> {
    if !process_group_alive(pgid) {
        return Ok(());
    }
    let deadline = tokio::time::Instant::now() + grace;
    match signal(pgid, libc::SIGTERM) {
        // A member refused SIGTERM; SIGKILL may still be allowed (a sandbox
        // or seccomp filter can let one through and not the other).
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => {}
        result => {
            result?;
            wait_group_gone(pgid, deadline).await;
        }
    }
    signal(pgid, libc::SIGKILL)
}

/// Wait until no live process is left in the group `pid` leads, or `deadline`.
async fn wait_group_gone(pid: u32, deadline: tokio::time::Instant) {
    const GROUP_POLL: Duration = Duration::from_millis(20);
    while tokio::time::Instant::now() < deadline && process_group_alive(pid) {
        tokio::time::sleep(GROUP_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{
        eperm, group_leader, process_gone, read_pid, wait_for_file, GRANDCHILD, STUBBORN_GRANDCHILD,
    };
    use super::*;

    use crate::shared::test_processes::{sleeping_child_command, KillOnDrop};

    #[tokio::test]
    async fn a_group_that_stays_live_reports_a_drain_timeout() {
        let mut command = sleeping_child_command();
        super::super::lead_new_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let _cleanup = KillOnDrop::default().group(pid);
        let error = drain_process_group(pid, Instant::now() + Duration::from_millis(100))
            .await
            .expect_err("a live member must stop the drain from succeeding");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        child.kill().await.unwrap();
    }

    #[tokio::test]
    async fn terminate_still_kills_a_group_that_refuses_sigterm() {
        use std::os::unix::process::ExitStatusExt;

        let mut command = sleeping_child_command();
        super::super::lead_new_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let _cleanup = KillOnDrop::default().group(pid);
        let sent = std::cell::RefCell::new(Vec::new());
        let status = terminate_group_with(&mut child, Duration::from_secs(1), |group, signal| {
            sent.borrow_mut().push(signal);
            if signal == libc::SIGTERM {
                return eperm();
            }
            signal_process_group(group, signal)
        })
        .await
        .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert_eq!(*sent.borrow(), [libc::SIGTERM, libc::SIGKILL]);
        assert!(!group_has_unfinished_member(pid).await.unwrap());
    }

    #[tokio::test]
    async fn stop_still_kills_a_group_that_refuses_sigterm() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = group_leader(&directory.path().join("unused.pid"), "exec sleep 30");
        let leader = child.id().unwrap();
        let sent = std::sync::Mutex::new(Vec::new());
        let refuse_term = |pgid, signal| {
            sent.lock().unwrap().push(signal);
            if signal == libc::SIGTERM {
                return eperm();
            }
            signal_process_group(pgid, signal)
        };

        stop_group_with(leader, Duration::from_secs(5), refuse_term)
            .await
            .expect("SIGKILL stops the group");
        use std::os::unix::process::ExitStatusExt;
        let status = wait_bounded(&mut child, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert_eq!(*sent.lock().unwrap(), [libc::SIGTERM, libc::SIGKILL]);
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

        let grace = Duration::from_secs(2);
        let started = Instant::now();
        let status = terminate_process_group(&mut child, grace).await.unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert!(
            started.elapsed() < grace + Duration::from_millis(1500),
            "reaping the group should return before the post-KILL deadline"
        );
        assert!(process_gone(grandchild).await, "the grandchild survived");
    }

    #[tokio::test]
    async fn interrupt_kills_a_background_job_that_ignores_sigint() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        // `sleep 120 & sleep 120` as a custom action runs it: a
        // non-interactive shell starts its background job with SIGINT ignored,
        // so Ctrl-C ends the foreground sleep and the shell, not that job.
        let mut child = group_leader(&pid_file, &format!("{GRANDCHILD} sleep 30"));
        wait_for_file(&pid_file).await;
        let grandchild = read_pid(&pid_file);

        let started = std::time::Instant::now();
        interrupt_process_group(&mut child, libc::SIGINT, Duration::from_millis(300))
            .await
            .unwrap();
        assert!(
            process_gone(grandchild).await,
            "the background job survived"
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn stop_ends_a_group_whose_leader_is_gone() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        // The leader exits at once, leaving a member that ignores SIGTERM:
        // only the SIGKILL after the grace ends it.
        let mut child = group_leader(&pid_file, STUBBORN_GRANDCHILD);
        let leader = child.id().unwrap();
        wait_for_file(&pid_file).await;
        let grandchild = read_pid(&pid_file);
        child.wait().await.unwrap();
        assert!(process_group_alive(leader));

        let started = std::time::Instant::now();
        stop_process_group(leader, Duration::from_millis(300))
            .await
            .unwrap();
        assert!(process_gone(grandchild).await, "the member survived");
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(!process_group_alive(leader));
        stop_process_group(leader, Duration::from_millis(300))
            .await
            .expect("a group that is gone is fine");
    }

    #[tokio::test]
    async fn stop_lets_a_group_exit_on_sigterm_within_the_grace() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        let mut child = group_leader(&pid_file, &format!("{GRANDCHILD} wait"));
        let leader = child.id().unwrap();
        wait_for_file(&pid_file).await;
        let grandchild = read_pid(&pid_file);
        // Whoever started the leader reaps it, as the Claude SDK does its CLI.
        let reaper = tokio::spawn(async move { child.wait().await });

        let started = std::time::Instant::now();
        stop_process_group(leader, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "SIGTERM was enough"
        );
        reaper.await.unwrap().unwrap();
        assert!(process_gone(grandchild).await, "the grandchild survived");
    }

    #[tokio::test]
    async fn interrupt_escalates_to_sigkill_when_the_leader_ignores_sigint() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        let mut child = group_leader(
            &pid_file,
            &format!("trap '' INT; {GRANDCHILD} while :; do sleep 1; done"),
        );
        wait_for_file(&pid_file).await;
        let grandchild = read_pid(&pid_file);

        let status = interrupt_process_group(&mut child, libc::SIGINT, Duration::from_millis(300))
            .await
            .unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert!(process_gone(grandchild).await, "the grandchild survived");
    }
}
