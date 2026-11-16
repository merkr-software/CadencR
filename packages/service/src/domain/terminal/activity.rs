use std::collections::HashMap;
use std::sync::Arc;

use super::service::{PtyHandle, PtyManager};

pub fn is_foreground_command_active(shell_pgrp: Option<i32>, foreground_pgrp: Option<i32>) -> bool {
    match (shell_pgrp, foreground_pgrp) {
        (Some(shell), Some(foreground)) => foreground > 0 && shell != foreground,
        _ => false,
    }
}

/// Whether a foreground command (other than the shell itself) is currently
/// running in this PTY. Exited shells are never busy. Used both for per-feature
/// activity counts and to decide whether a stale terminal can be auto-switched
/// to a fresh worktree without killing a running command.
pub fn pty_foreground_active(handle: &Arc<PtyHandle>) -> bool {
    if handle.alive.borrow().is_some() {
        return false;
    }
    let foreground = foreground_process_group(handle);
    is_foreground_command_active(handle.shell_process_group_leader, foreground)
}

pub fn foreground_command_counts_by_feature(manager: &PtyManager) -> HashMap<i64, i64> {
    let mut counts = HashMap::new();
    for entry in manager.terminals.iter() {
        let handle = entry.value();
        if pty_foreground_active(handle) {
            *counts.entry(handle.feature_id).or_insert(0) += 1;
        }
    }
    counts
}

/// Shell pid of every live feature terminal, keyed to the feature it serves.
/// Exited shells are skipped — their handles linger for a grace period, and a
/// recycled pid must not be credited to the feature that used to own it.
pub fn live_shell_pids_by_feature(manager: &PtyManager) -> HashMap<i32, i64> {
    let mut roots = HashMap::new();
    for entry in manager.terminals.iter() {
        let handle = entry.value();
        if handle.alive.borrow().is_some() {
            continue;
        }
        if let Some(shell_pid) = handle.shell_process_group_leader {
            roots.insert(shell_pid, handle.feature_id);
        }
    }
    roots
}

fn foreground_process_group(handle: &PtyHandle) -> Option<i32> {
    #[cfg(unix)]
    {
        let master = handle.master.lock().unwrap_or_else(|e| e.into_inner());
        let fd = master.as_raw_fd()?;
        let pgrp = unsafe { libc::tcgetpgrp(fd) };
        (pgrp > 0).then_some(pgrp)
    }
    #[cfg(not(unix))]
    {
        let _ = handle;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::service::PtyManager;

    #[test]
    fn foreground_differs_from_shell_counts_as_busy() {
        assert!(super::is_foreground_command_active(Some(12), Some(34)));
        assert!(!super::is_foreground_command_active(Some(12), Some(12)));
        assert!(!super::is_foreground_command_active(None, Some(12)));
        assert!(!super::is_foreground_command_active(Some(12), None));
    }

    /// An idle shell sitting at its prompt must report *not* busy — this is the
    /// safety contract the client relies on to auto-switch a terminal to a fresh
    /// worktree without killing a running command. We poll to let shell startup
    /// (rc sourcing) settle before asserting.
    #[tokio::test]
    #[cfg(unix)]
    async fn idle_shell_is_not_foreground_active() {
        let _guard = crate::shared::test_env::async_env_lock().lock().await;
        let _shell = crate::shared::test_env::EnvVarGuard::set("SHELL", "/bin/sh");

        let manager = PtyManager::new();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let (pty_id, handle) = manager.create_pty(1, &cwd, 80, 24).expect("spawn shell");

        let mut settled = false;
        for _ in 0..50 {
            if !super::pty_foreground_active(&handle) {
                settled = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let _ = manager.kill_pty(&pty_id);

        assert!(settled, "an idle shell should not be reported as busy");
    }
}
