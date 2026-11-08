//! Process-group ownership for ACP terminals — the one platform boundary of
//! the terminal lifecycle.
//!
//! On Unix the command leads its own process group, so a kill reaches every
//! descendant: otherwise `sh -c 'sleep 60 &'` leaves a grandchild holding the
//! output pipes open after the shell dies. Other platforms keep the
//! single-process kill.
//!
//! A group outlives its command when the command left something running (a
//! dev server started with `&`), and only an explicit stop ends it: a kill or
//! release, the session closing, or the service shutting down. Since the group
//! no longer shares the service's own group, the service tracks every group
//! that may still have members ([`stop_all_live_groups`]).
//!
//! A group id cannot be reused while the group has a member, and a group is
//! forgotten as soon as it is seen empty, so signalling a tracked group only
//! risks a stranger in the window between its last member exiting and the
//! next liveness check.

use std::io;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::time::Instant;

#[cfg(unix)]
const GROUP_POLL: Duration = Duration::from_millis(20);

/// Leaders of the groups that may still have members.
#[cfg(unix)]
static LIVE_GROUPS: std::sync::Mutex<std::collections::BTreeSet<u32>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

#[cfg(unix)]
fn live_groups() -> std::sync::MutexGuard<'static, std::collections::BTreeSet<u32>> {
    // The set holds plain ids, so a panic elsewhere cannot leave it torn.
    LIVE_GROUPS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Make the command lead a new process group (Unix).
pub(super) fn isolate(command: &mut Command) {
    #[cfg(unix)]
    crate::shared::process_group::lead_new_process_group(command);
    #[cfg(not(unix))]
    let _ = command;
}

/// The process group a terminal command leads.
#[derive(Clone, Copy)]
pub(super) struct TerminalGroup {
    #[cfg(unix)]
    leader: Option<u32>,
}

impl TerminalGroup {
    /// The group of a command spawned after [`isolate`], tracked until it is
    /// seen empty.
    pub(super) fn of(child: &Child) -> Self {
        #[cfg(unix)]
        {
            let leader = child.id();
            if let Some(pid) = leader {
                live_groups().insert(pid);
            }
            Self { leader }
        }
        #[cfg(not(unix))]
        {
            let _ = child;
            Self {}
        }
    }

    /// Ask the whole group to stop (SIGTERM) while its leader runs.
    pub(super) fn terminate(&self, child: &mut Child) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(pid) = self.leader {
            return crate::shared::process_group::signal_process_group(pid, libc::SIGTERM);
        }
        child.start_kill()
    }

    /// Kill the whole group (SIGKILL) while its leader runs.
    pub(super) fn kill(&self, child: &mut Child) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(pid) = self.leader {
            return crate::shared::process_group::signal_process_group(pid, libc::SIGKILL);
        }
        child.start_kill()
    }

    /// Whether a live process is left in the group.
    pub(super) fn is_alive(&self) -> bool {
        #[cfg(unix)]
        if let Some(pid) = self.leader {
            return crate::shared::process_group::process_group_alive(pid);
        }
        false
    }

    /// Wait until no live process is left in the group, or until `deadline`.
    pub(super) async fn wait_until_empty(&self, deadline: Instant) {
        while Instant::now() < deadline && self.is_alive() {
            #[cfg(unix)]
            tokio::time::sleep(GROUP_POLL).await;
        }
    }

    /// SIGKILL what is left of the group once its leader has exited, then
    /// stop tracking it.
    pub(super) async fn kill_remaining(&self) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(pid) = self.leader {
            let killed = crate::shared::process_group::kill_group_after_leader_exit(pid).await;
            self.forget();
            return killed;
        }
        Ok(())
    }

    /// Stop tracking the group if nothing is left in it.
    pub(super) fn forget_if_empty(&self) {
        if !self.is_alive() {
            self.forget();
        }
    }

    /// Stop what the command left running after it exited: SIGTERM now, then
    /// SIGKILL for whatever is left after `grace`, in the background. A group
    /// already empty is a no-op.
    pub(super) fn stop_after_exit(&self, grace: Duration) -> io::Result<()> {
        if !self.is_alive() {
            self.forget();
            return Ok(());
        }
        self.signal_term()?;
        let group = *self;
        tokio::spawn(async move { group.escalate(Instant::now() + grace).await });
        Ok(())
    }

    /// Synchronous SIGKILL for `Drop`, where the child itself is killed by
    /// `kill_on_drop`; the group is skipped once seen empty.
    pub(super) fn kill_on_drop(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.leader {
            if self.is_alive() {
                if let Err(error) =
                    crate::shared::process_group::signal_process_group(pid, libc::SIGKILL)
                {
                    tracing::warn!(%error, pid, "failed to kill a dropped ACP terminal's process group");
                }
            }
        }
        self.forget();
    }

    fn signal_term(&self) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(pid) = self.leader {
            return crate::shared::process_group::signal_process_group(pid, libc::SIGTERM);
        }
        Ok(())
    }

    async fn escalate(&self, deadline: Instant) {
        self.wait_until_empty(deadline).await;
        if let Err(error) = self.kill_remaining().await {
            tracing::warn!(%error, "failed to kill an ACP terminal's remaining processes");
        }
    }

    fn forget(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.leader {
            live_groups().remove(&pid);
        }
    }

    #[cfg(all(test, unix))]
    pub(super) fn is_tracked(&self) -> bool {
        self.leader.is_some_and(|pid| live_groups().contains(&pid))
    }
}

/// Stop `groups` together: SIGTERM to each, then SIGKILL for whatever is left
/// once `grace` has passed for all of them.
pub(super) async fn stop_groups(groups: &[TerminalGroup], grace: Duration) {
    let deadline = Instant::now() + grace;
    for group in groups {
        if group.is_alive() {
            if let Err(error) = group.signal_term() {
                tracing::warn!(%error, "failed to SIGTERM an ACP terminal's process group");
            }
        }
    }
    for group in groups {
        group.escalate(deadline).await;
    }
}

/// Service shutdown: stop every terminal group still tracked. They lead their
/// own groups, so nothing else would reach them once the service is gone.
pub(super) async fn stop_all_live_groups(grace: Duration) {
    #[cfg(unix)]
    {
        let groups: Vec<TerminalGroup> = live_groups()
            .iter()
            .map(|&pid| TerminalGroup { leader: Some(pid) })
            .collect();
        stop_groups(&groups, grace).await;
    }
    #[cfg(not(unix))]
    let _ = grace;
}
