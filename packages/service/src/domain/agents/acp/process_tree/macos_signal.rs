use std::io;
use std::time::Duration;

use tokio::time::{sleep, Instant};

const PROBE_INTERVAL: Duration = Duration::from_millis(10);
const MAX_RECONCILE_WINDOW: Duration = Duration::from_millis(100);

pub(super) async fn kill_after_leader_exit(pid: u32, timeout: Duration) -> io::Result<()> {
    // XNU excludes zombies while signaling a process group, so SIGKILL can report EPERM
    // until the group disappears. Never repeat the destructive signal: reconcile with
    // non-destructive signal-0 probes instead.
    // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c
    reconcile_permission_denied(
        timeout.min(MAX_RECONCILE_WINDOW),
        || super::signal_process_group(pid, libc::SIGKILL),
        || probe_process_group(pid),
    )
    .await
}

pub(super) async fn cleanup_after_exit(pid: u32) -> io::Result<()> {
    kill_after_leader_exit(pid, MAX_RECONCILE_WINDOW).await
}

fn probe_process_group(pid: u32) -> io::Result<()> {
    let result = unsafe { libc::kill(-(pid as libc::pid_t), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

async fn reconcile_permission_denied(
    timeout: Duration,
    kill: impl FnOnce() -> io::Result<()>,
    mut probe: impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    let kill_error = match kill() {
        Ok(()) => return Ok(()),
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => error,
        Err(error) => return Err(error),
    };
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() >= deadline {
            return Err(kill_error);
        }
        match probe() {
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(()),
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => {}
            Err(error) => return Err(error),
            Ok(()) => return Err(kill_error),
        }
        if deadline.saturating_duration_since(Instant::now()) <= PROBE_INTERVAL {
            return Err(kill_error);
        }
        sleep(PROBE_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    fn error(code: libc::c_int) -> io::Error {
        io::Error::from_raw_os_error(code)
    }

    #[tokio::test]
    async fn reconciles_disappearance_without_repeating_kill() {
        let kills = Cell::new(0);
        let probes = Cell::new(0);
        reconcile_permission_denied(
            Duration::from_secs(1),
            || {
                kills.set(kills.get() + 1);
                Err(error(libc::EPERM))
            },
            || {
                probes.set(probes.get() + 1);
                Err(error(if probes.get() < 3 {
                    libc::EPERM
                } else {
                    libc::ESRCH
                }))
            },
        )
        .await
        .expect("a vanished group completes cleanup");
        assert_eq!(kills.get(), 1);
        assert_eq!(probes.get(), 3);
    }

    #[tokio::test]
    async fn persistent_permission_denied_stops_at_deadline() {
        let result = reconcile_permission_denied(
            Duration::from_millis(20),
            || Err(error(libc::EPERM)),
            || Err(error(libc::EPERM)),
        )
        .await;
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EPERM));
    }

    #[tokio::test]
    async fn signalable_group_fails_closed_without_repeating_kill() {
        let kills = Cell::new(0);
        let result = reconcile_permission_denied(
            Duration::from_secs(1),
            || {
                kills.set(kills.get() + 1);
                Err(error(libc::EPERM))
            },
            || Ok(()),
        )
        .await;
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EPERM));
        assert_eq!(kills.get(), 1);
    }

    #[tokio::test]
    async fn unexpected_probe_error_is_preserved() {
        let result = reconcile_permission_denied(
            Duration::from_secs(1),
            || Err(error(libc::EPERM)),
            || Err(error(libc::EINVAL)),
        )
        .await;
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EINVAL));
    }

    #[tokio::test]
    async fn initial_result_never_probes() {
        let probes = Cell::new(0);
        reconcile_permission_denied(
            Duration::from_secs(1),
            || Ok(()),
            || {
                probes.set(probes.get() + 1);
                Ok(())
            },
        )
        .await
        .expect("successful kill needs no reconciliation");
        let result = reconcile_permission_denied(
            Duration::from_secs(1),
            || Err(error(libc::EINVAL)),
            || {
                probes.set(probes.get() + 1);
                Ok(())
            },
        )
        .await;
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EINVAL));
        assert_eq!(probes.get(), 0);
    }

    #[tokio::test]
    async fn zero_budget_performs_one_kill_and_no_probe() {
        let probes = Cell::new(0);
        let result = reconcile_permission_denied(
            Duration::ZERO,
            || Err(error(libc::EPERM)),
            || {
                probes.set(probes.get() + 1);
                Ok(())
            },
        )
        .await;
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EPERM));
        assert_eq!(probes.get(), 0);
    }
}
