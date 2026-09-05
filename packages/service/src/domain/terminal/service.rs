use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, watch};
use tracing::{info, warn};

const SCROLLBACK_CAP: usize = 50 * 1024; // 50KB

/// Ring buffer that keeps the last ~50KB of terminal output.
pub struct ScrollbackBuffer {
    buf: VecDeque<u8>,
}

impl ScrollbackBuffer {
    fn new() -> Self {
        Self {
            buf: VecDeque::with_capacity(SCROLLBACK_CAP),
        }
    }

    pub fn append(&mut self, data: &[u8]) {
        let overflow = (self.buf.len() + data.len()).saturating_sub(SCROLLBACK_CAP);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.buf.extend(data);
    }

    pub fn contents(&self) -> String {
        let (a, b) = self.buf.as_slices();
        let mut v = Vec::with_capacity(a.len() + b.len());
        v.extend_from_slice(a);
        v.extend_from_slice(b);
        String::from_utf8_lossy(&v).into_owned()
    }
}

/// What a PTY is used for. Every PTY lives in the same `PtyManager` map keyed
/// only by feature, so listing/killing "a feature's terminals" must filter on
/// this — otherwise a feature's Neovim process (its own PTY, tagged with the
/// same `feature_id`) gets surfaced to a client asking for shell sessions to
/// attach to, or killed by a "close all terminals" action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyKind {
    Terminal,
    Neovim,
}

/// Handle for a single PTY session.
pub struct PtyHandle {
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub master_writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub scrollback: Arc<Mutex<ScrollbackBuffer>>,
    pub alive: Arc<watch::Sender<Option<i32>>>,
    /// Killer handle — allows sending signals without holding the child lock.
    pub killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    /// Broadcast channel for PTY output data. WebSocket connections subscribe to this.
    pub data_tx: broadcast::Sender<String>,
    /// Working directory the PTY was spawned in. Reported back to the client so
    /// it can detect when the terminal is running outside the feature's current
    /// worktree.
    pub cwd: String,
    /// Feature this PTY belongs to. Lets a second client (e.g. a remote device)
    /// discover and attach to the feature's live shells instead of spawning a
    /// new one — the broadcast channel already supports multiple subscribers.
    pub feature_id: i64,
    pub shell_process_group_leader: Option<i32>,
    pub kind: PtyKind,
}

/// A live PTY belonging to a feature, surfaced so another client can attach.
pub struct PtySession {
    pub pty_id: String,
    pub cwd: String,
    pub alive: bool,
    /// Whether a foreground command is currently running in this shell. Lets the
    /// client auto-switch an *idle* terminal to a fresh worktree while leaving a
    /// busy one alone (so it never kills a running command).
    pub foreground_active: bool,
}

pub(super) struct PtyReconnect {
    pub handle: Arc<PtyHandle>,
    pub alive: bool,
    pub scrollback: String,
    pub cwd: String,
}

/// Manages all PTY sessions. Stored in AppState.
#[derive(Clone)]
pub struct PtyManager {
    pub terminals: Arc<DashMap<String, Arc<PtyHandle>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            terminals: Arc::new(DashMap::new()),
        }
    }

    /// Spawn a new PTY in the given working directory. Returns (pty_id, handle).
    pub fn create_pty(
        &self,
        feature_id: i64,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<(String, Arc<PtyHandle>)> {
        self.create_pty_with_command(
            feature_id,
            CommandBuilder::new_default_prog(),
            cwd,
            cols,
            rows,
            PtyKind::Terminal,
        )
    }

    /// Spawn a new PTY running `cmd`. The caller supplies the program and its
    /// arguments; this method still applies the environment every Cadencr PTY
    /// gets — working directory, `TERM`, and removal of the service launch
    /// token — so a caller-supplied command can never inherit it.
    pub fn create_pty_with_command(
        &self,
        feature_id: i64,
        mut cmd: CommandBuilder,
        cwd: &str,
        cols: u16,
        rows: u16,
        kind: PtyKind,
    ) -> anyhow::Result<(String, Arc<PtyHandle>)> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        cmd.cwd(cwd);
        cmd.env_remove(crate::shared::security::SERVICE_AUTH_TOKEN_ENV);
        // Ensure the program knows it's running inside an xterm-compatible
        // terminal. Without this, programs emit wrong escape sequences.
        cmd.env("TERM", "xterm-256color");

        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let pty_id = uuid::Uuid::new_v4().to_string();
        let (alive_tx, _) = watch::channel::<Option<i32>>(None);
        let (data_tx, _) = broadcast::channel::<String>(256);

        // Clone a killer handle before moving child into the blocking task.
        let killer = child.clone_killer();

        #[cfg(unix)]
        let shell_process_group_leader = pair.master.process_group_leader();
        #[cfg(not(unix))]
        let shell_process_group_leader = None;
        let handle = Arc::new(PtyHandle {
            master: Arc::new(Mutex::new(pair.master)),
            master_writer: Arc::new(Mutex::new(writer)),
            scrollback: Arc::new(Mutex::new(ScrollbackBuffer::new())),
            alive: Arc::new(alive_tx),
            killer: Arc::new(Mutex::new(killer)),
            data_tx: data_tx.clone(),
            cwd: cwd.to_string(),
            feature_id,
            shell_process_group_leader,
            kind,
        });

        self.terminals.insert(pty_id.clone(), Arc::clone(&handle));

        // Persistent reader task: lives as long as the PTY.
        // Reads PTY output, updates scrollback, and broadcasts to all WS subscribers.
        let scrollback = Arc::clone(&handle.scrollback);
        let data_tx_reader = data_tx;
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4096];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                scrollback
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .append(&buf[..n]);
                // send() only fails when there are no receivers — that's fine
                let _ = data_tx_reader.send(data);
            }
        });

        // Child watcher task: signals alive channel and schedules cleanup.
        let terminals = Arc::clone(&self.terminals);
        let alive_tx = Arc::clone(&handle.alive);
        let pid = pty_id.clone();
        tokio::task::spawn_blocking(move || {
            let status = child.wait();
            let exit_code = match status {
                Ok(s) => s.exit_code() as i32,
                Err(_) => -1,
            };
            info!(pty_id = %pid, exit_code, "PTY child exited");
            let _ = alive_tx.send(Some(exit_code));

            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                terminals.remove(&pid);
                info!(pty_id = %pid, "PTY handle removed after grace period");
            });
        });

        Ok((pty_id, handle))
    }

    pub fn write_pty(&self, pty_id: &str, data: &[u8]) -> anyhow::Result<()> {
        let handle = self
            .terminals
            .get(pty_id)
            .ok_or_else(|| anyhow::anyhow!("PTY not found: {pty_id}"))?;
        handle
            .master_writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .write_all(data)?;
        Ok(())
    }

    pub fn resize_pty(&self, pty_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let handle = self
            .terminals
            .get(pty_id)
            .ok_or_else(|| anyhow::anyhow!("PTY not found: {pty_id}"))?;
        handle
            .master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow::anyhow!("Failed to resize PTY: {e}"))?;
        Ok(())
    }

    pub fn kill_pty(&self, pty_id: &str) -> anyhow::Result<()> {
        let handle = self
            .terminals
            .get(pty_id)
            .ok_or_else(|| anyhow::anyhow!("PTY not found: {pty_id}"))?;
        handle
            .killer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .kill()
            .map_err(|e| anyhow::anyhow!("Failed to kill PTY: {e}"))?;
        Ok(())
    }

    /// Kill every live PTY belonging to `feature_id`, returning how many shells
    /// were signalled. Used when a feature is archived/deleted, or when the user
    /// closes a feature's terminals from the sidebar, so its lingering shells
    /// don't keep running in a worktree that may be about to be removed.
    ///
    /// Each killed PTY is also dropped from the map immediately. The 300s grace
    /// window only exists to let a *disconnected* client reattach to its still-
    /// running shell; a shell the user explicitly killed must not be re-listed
    /// or reattachable — otherwise a still-open terminal pane would re-adopt the
    /// dying shell and end up stuck on its hangup output. The connected WS loop
    /// keeps the handle alive through its own `Arc`, so the exit message still
    /// reaches any attached client before its socket closes.
    pub fn kill_feature_ptys(&self, feature_id: i64) -> usize {
        let pty_ids = self
            .terminals
            .iter()
            .filter(|entry| {
                entry.value().feature_id == feature_id
                    && entry.value().kind == PtyKind::Terminal
                    && entry.value().alive.borrow().is_none()
            })
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        let mut killed = 0;
        for pty_id in pty_ids {
            match self.kill_pty(&pty_id) {
                Ok(()) => {
                    killed += 1;
                    self.terminals.remove(&pty_id);
                }
                Err(error) => warn!(pty_id = %pty_id, error = %error, "Failed to kill feature PTY"),
            }
        }
        killed
    }

    pub fn kill_all(&self) {
        let pty_ids = self
            .terminals
            .iter()
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        for pty_id in pty_ids {
            if let Err(error) = self.kill_pty(&pty_id) {
                warn!(pty_id = %pty_id, error = %error, "Failed to kill PTY during shutdown");
            }
        }
    }

    #[cfg(test)]
    pub fn get_scrollback(&self, pty_id: &str) -> Option<(bool, String)> {
        let handle = self.terminals.get(pty_id)?;
        let alive = handle.alive.borrow().is_none();
        let scrollback = handle
            .scrollback
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contents();
        Some((alive, scrollback))
    }

    /// Snapshot a PTY only when it belongs to the requested feature. Treat a
    /// feature mismatch exactly like an unknown ID so callers cannot probe
    /// shells from another workspace.
    pub(super) fn reconnect_for_feature(
        &self,
        pty_id: &str,
        feature_id: i64,
    ) -> Option<PtyReconnect> {
        let handle = self.terminals.get(pty_id)?;
        if handle.feature_id != feature_id || handle.kind != PtyKind::Terminal {
            return None;
        }
        let alive = handle.alive.borrow().is_none();
        let scrollback = handle
            .scrollback
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contents();
        Some(PtyReconnect {
            handle: Arc::clone(handle.value()),
            alive,
            scrollback,
            cwd: handle.cwd.clone(),
        })
    }

    #[cfg(test)]
    /// Returns the working directory the PTY was spawned in, or None if the
    /// handle no longer exists.
    pub fn get_cwd(&self, pty_id: &str) -> Option<String> {
        self.terminals.get(pty_id).map(|h| h.cwd.clone())
    }

    /// All PTYs spawned for `feature_id`, so another client can attach to the
    /// feature's live shells. `alive` mirrors `get_scrollback`'s liveness check
    /// (the child hasn't exited). Dead-but-not-yet-reaped PTYs are still listed;
    /// the caller decides whether to attach (e.g. to read final scrollback).
    pub fn feature_ptys(&self, feature_id: i64) -> Vec<PtySession> {
        self.terminals
            .iter()
            .filter(|entry| {
                entry.value().feature_id == feature_id && entry.value().kind == PtyKind::Terminal
            })
            .map(|entry| PtySession {
                pty_id: entry.key().clone(),
                cwd: entry.value().cwd.clone(),
                alive: entry.value().alive.borrow().is_none(),
                foreground_active: super::activity::pty_foreground_active(entry.value()),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_existing_dir() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn create_pty_records_cwd_on_handle() {
        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let (pty_id, handle) = manager
            .create_pty(1, &cwd, 80, 24)
            .expect("PTY should spawn in temp dir");

        assert_eq!(handle.cwd, cwd, "handle should expose spawned cwd");
        assert_eq!(
            manager.get_cwd(&pty_id),
            Some(cwd),
            "manager lookup should return the same cwd",
        );

        let _ = manager.kill_pty(&pty_id);
    }

    #[tokio::test]
    async fn get_cwd_returns_none_for_unknown_pty() {
        let manager = PtyManager::new();
        assert_eq!(manager.get_cwd("does-not-exist"), None);
    }

    #[tokio::test]
    async fn reconnect_for_feature_rejects_cross_feature_pty_access() {
        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let (pty_id, _) = manager
            .create_pty(7, &cwd, 80, 24)
            .expect("PTY should spawn");

        assert!(manager.reconnect_for_feature(&pty_id, 7).is_some());
        assert!(manager.reconnect_for_feature(&pty_id, 99).is_none());
        assert!(manager.reconnect_for_feature("does-not-exist", 7).is_none());

        manager.kill_all();
    }

    #[tokio::test]
    async fn feature_ptys_lists_only_that_features_live_shells() {
        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let (pty_a, _) = manager.create_pty(7, &cwd, 80, 24).expect("spawn a");
        let (_pty_b, _) = manager.create_pty(7, &cwd, 80, 24).expect("spawn b");
        let (_pty_other, _) = manager.create_pty(99, &cwd, 80, 24).expect("spawn other");

        let feature_7 = manager.feature_ptys(7);
        assert_eq!(feature_7.len(), 2, "both feature-7 PTYs are listed");
        assert!(
            feature_7.iter().all(|s| s.alive),
            "freshly spawned => alive"
        );
        assert!(feature_7.iter().any(|s| s.pty_id == pty_a));

        assert_eq!(manager.feature_ptys(99).len(), 1, "other feature isolated");
        assert!(
            manager.feature_ptys(123).is_empty(),
            "unknown feature => none"
        );

        // Kill every spawned shell so each blocking `child.wait()` returns and the
        // test runtime can shut down — a lingering login shell would hang it.
        manager.kill_all();
    }

    #[tokio::test]
    async fn feature_ptys_excludes_neovim_ptys() {
        // A feature's Neovim process is spawned through this same manager
        // (`NeovimManager::start` calls `create_pty_with_command` too), tagged
        // with the same `feature_id` as its terminal shells. If it leaked into
        // `feature_ptys`, a client listing "this feature's terminal sessions"
        // to attach to would adopt Neovim's raw PTY as a shell — which is
        // exactly what made a fresh Terminal tab show Neovim's own screen.
        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let (shell_id, _) = manager.create_pty(7, &cwd, 80, 24).expect("spawn shell");
        let mut nvim_cmd = CommandBuilder::new("/bin/sh");
        nvim_cmd.arg("-c");
        nvim_cmd.arg("sleep 60");
        let (nvim_id, _) = manager
            .create_pty_with_command(7, nvim_cmd, &cwd, 80, 24, PtyKind::Neovim)
            .expect("spawn neovim-tagged pty");

        let sessions = manager.feature_ptys(7);
        assert_eq!(sessions.len(), 1, "only the terminal shell is listed");
        assert_eq!(sessions[0].pty_id, shell_id);
        assert!(!sessions.iter().any(|s| s.pty_id == nvim_id));

        assert!(
            manager.reconnect_for_feature(&nvim_id, 7).is_none(),
            "reconnecting to a Neovim-tagged pty via the terminal socket must be refused"
        );

        manager.kill_all();
    }

    #[tokio::test]
    async fn kill_feature_ptys_only_kills_that_feature() {
        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let (_pty_a, _) = manager.create_pty(7, &cwd, 80, 24).expect("spawn a");
        let (_pty_b, _) = manager.create_pty(7, &cwd, 80, 24).expect("spawn b");
        let (_pty_other, _) = manager.create_pty(99, &cwd, 80, 24).expect("spawn other");

        let killed = manager.kill_feature_ptys(7);
        assert_eq!(killed, 2, "both feature-7 shells are killed");
        assert_eq!(manager.kill_feature_ptys(123), 0, "unknown feature => none");

        // Killed shells are dropped from the map so a still-open terminal pane
        // can't re-list or reattach to them while they hang up.
        assert!(
            manager.feature_ptys(7).is_empty(),
            "killed shells removed from the map"
        );

        // The other feature's shell is untouched, so its child is still running.
        assert_eq!(manager.feature_ptys(99).len(), 1, "other feature untouched");

        manager.kill_all();
    }

    #[tokio::test]
    async fn kill_feature_ptys_leaves_neovim_running() {
        // "Close all terminals" (sidebar action, feature archive/delete) must
        // not take the feature's Neovim process down with it.
        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let (_shell_id, _) = manager.create_pty(7, &cwd, 80, 24).expect("spawn shell");
        let mut nvim_cmd = CommandBuilder::new("/bin/sh");
        nvim_cmd.arg("-c");
        nvim_cmd.arg("sleep 60");
        let (nvim_id, _) = manager
            .create_pty_with_command(7, nvim_cmd, &cwd, 80, 24, PtyKind::Neovim)
            .expect("spawn neovim-tagged pty");

        let killed = manager.kill_feature_ptys(7);
        assert_eq!(killed, 1, "only the terminal shell is killed");
        assert_eq!(
            manager.get_cwd(&nvim_id),
            Some(cwd.clone()),
            "the neovim-tagged pty is still tracked, i.e. was never killed"
        );

        manager.kill_all();
    }

    #[tokio::test]
    async fn create_pty_inherits_process_environment() {
        let _guard = crate::shared::test_env::async_env_lock().lock().await;
        let _shell = crate::shared::test_env::EnvVarGuard::set("SHELL", "/bin/sh");
        let _marker =
            crate::shared::test_env::EnvVarGuard::set("CADENCR_TEST_PTY_ENV", "visible-to-pty");
        let _auth =
            crate::shared::test_env::EnvVarGuard::set("CADENCR_AUTH_TOKEN", "service-secret");

        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let (pty_id, _) = manager
            .create_pty(1, &cwd, 80, 24)
            .expect("PTY should spawn in temp dir");
        manager
            .write_pty(
                &pty_id,
                b"printf 'CADENCR_TEST_PTY_ENV=%s AUTH=%s\\n' \"$CADENCR_TEST_PTY_ENV\" \"${CADENCR_AUTH_TOKEN-unset}\"\nexit\n",
            )
            .expect("write command to PTY");

        let saw_expected =
            wait_for_scrollback(&manager, &pty_id, "CADENCR_TEST_PTY_ENV=visible-to-pty").await;
        let auth_was_scrubbed = wait_for_scrollback(&manager, &pty_id, "AUTH=unset").await;
        let _ = manager.kill_pty(&pty_id);

        assert!(saw_expected, "PTY shell should inherit process environment");
        assert!(
            auth_was_scrubbed,
            "PTY shell must not inherit the service launch token"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn create_pty_starts_login_shell() {
        let _guard = crate::shared::test_env::async_env_lock().lock().await;
        let _shell = crate::shared::test_env::EnvVarGuard::set("SHELL", "/bin/sh");

        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let (pty_id, _) = manager
            .create_pty(1, &cwd, 80, 24)
            .expect("PTY should spawn in temp dir");
        manager
            .write_pty(&pty_id, b"printf 'CADENCR_SHELL_ARG0=%s\\n' \"$0\"\nexit\n")
            .expect("write command to PTY");

        let saw_login_shell =
            wait_for_scrollback(&manager, &pty_id, "CADENCR_SHELL_ARG0=-sh").await;
        let _ = manager.kill_pty(&pty_id);

        assert!(
            saw_login_shell,
            "PTY shell should be started as a login shell"
        );
    }

    #[tokio::test]
    async fn create_pty_with_command_runs_the_supplied_program() {
        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("printf 'CADENCR_CUSTOM_CMD=ran\\n'");

        let (pty_id, handle) = manager
            .create_pty_with_command(11, cmd, &cwd, 80, 24, PtyKind::Terminal)
            .expect("custom-command PTY should spawn");

        assert_eq!(handle.feature_id, 11);
        let saw_output = wait_for_scrollback(&manager, &pty_id, "CADENCR_CUSTOM_CMD=ran").await;
        manager.kill_all();
        assert!(
            saw_output,
            "the supplied command should have run in the PTY"
        );
    }

    #[tokio::test]
    async fn create_pty_with_command_still_scrubs_the_service_auth_token() {
        let _guard = crate::shared::test_env::async_env_lock().lock().await;
        let _auth =
            crate::shared::test_env::EnvVarGuard::set("CADENCR_AUTH_TOKEN", "service-secret");

        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("printf 'AUTH=%s\\n' \"${CADENCR_AUTH_TOKEN-unset}\"");

        let (pty_id, _) = manager
            .create_pty_with_command(12, cmd, &cwd, 80, 24, PtyKind::Terminal)
            .expect("custom-command PTY should spawn");

        let scrubbed = wait_for_scrollback(&manager, &pty_id, "AUTH=unset").await;
        manager.kill_all();
        assert!(
            scrubbed,
            "a caller-supplied command must not inherit the service launch token"
        );
    }

    async fn wait_for_scrollback(manager: &PtyManager, pty_id: &str, needle: &str) -> bool {
        for _ in 0..50 {
            if manager
                .get_scrollback(pty_id)
                .is_some_and(|(_, output)| output.contains(needle))
            {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        false
    }
}
