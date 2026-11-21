//! Provider launchers and one-shot queries can open listeners while running in
//! a feature's worktree. Record their process roots from spawn until teardown.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, PoisonError, Weak};

#[derive(Clone, Copy)]
pub(crate) enum ProviderProcessScope {
    CommandTree,
    Launcher,
}

impl ProviderProcessScope {
    pub(super) fn includes(self, depth: usize) -> bool {
        match self {
            Self::CommandTree => true,
            Self::Launcher => depth <= 1,
        }
    }
}

pub(super) type ProviderProcesses = HashMap<i32, ProviderProcessScope>;
type Snapshot = Mutex<ProviderProcesses>;

#[derive(Default)]
struct TrackedProcesses {
    active: ProviderProcesses,
    scans: Vec<Weak<Snapshot>>,
}

static PROCESSES: LazyLock<Mutex<TrackedProcesses>> = LazyLock::new(Mutex::default);

/// A process root tracked for the lifetime of the provider operation.
pub(crate) struct ProviderProcess(i32);

impl ProviderProcess {
    pub(crate) fn register(pid: u32, scope: ProviderProcessScope) -> Option<Self> {
        let pid = i32::try_from(pid).ok()?;
        let mut processes = PROCESSES.lock().unwrap_or_else(PoisonError::into_inner);
        processes.active.insert(pid, scope);
        processes.scans.retain(|scan| {
            let Some(scan) = scan.upgrade() else {
                return false;
            };
            scan.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(pid, scope);
            true
        });
        Some(Self(pid))
    }
}

impl Drop for ProviderProcess {
    fn drop(&mut self) {
        PROCESSES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .active
            .remove(&self.0);
    }
}

/// Retain the roots of processes that overlap a listener scan, even when a
/// process exits before attribution. Later scans only inherit active roots.
pub(super) struct ProviderProcessScan(Arc<Snapshot>);

impl ProviderProcessScan {
    pub(super) fn begin() -> Self {
        let mut processes = PROCESSES.lock().unwrap_or_else(PoisonError::into_inner);
        let pids = Arc::new(Mutex::new(processes.active.clone()));
        processes.scans.retain(|scan| scan.strong_count() > 0);
        processes.scans.push(Arc::downgrade(&pids));
        Self(pids)
    }

    pub(super) fn finish(self) -> ProviderProcesses {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_commands_active_at_start_or_launched_during_a_scan() {
        let early = ProviderProcess::register(101, ProviderProcessScope::CommandTree).unwrap();
        let scan = ProviderProcessScan::begin();
        let late = ProviderProcess::register(102, ProviderProcessScope::Launcher).unwrap();
        drop(early);
        drop(late);

        let seen = scan.finish();
        assert!(matches!(
            seen.get(&101),
            Some(ProviderProcessScope::CommandTree)
        ));
        assert!(matches!(
            seen.get(&102),
            Some(ProviderProcessScope::Launcher)
        ));
        let next = ProviderProcessScan::begin().finish();
        assert!(!next.contains_key(&101));
        assert!(!next.contains_key(&102));
    }
}
