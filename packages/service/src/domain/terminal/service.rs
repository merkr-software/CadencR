use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, watch};
use tracing::warn;

mod output;
mod threads;
mod writer;
pub use output::ScrollbackBuffer;
use threads::{kill_and_reap, spawn_reader_thread, spawn_waiter_thread, WaiterParts};
pub use writer::PtyWriteQueue;

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
    pub write_queue: PtyWriteQueue,
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

impl PtyHandle {
    /// Output publication takes this same lock, making replay and subscription
    /// one boundary: bytes appear either in scrollback or in the receiver.
    pub(crate) fn subscribe_with_scrollback(&self) -> (String, broadcast::Receiver<String>) {
        let scrollback = self.scrollback.lock().unwrap_or_else(|e| e.into_inner());
        let receiver = self.data_tx.subscribe();
        (scrollback.contents(), receiver)
    }
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
    pub data_rx: broadcast::Receiver<String>,
}

/// Manages all PTY sessions. Stored in AppState.
#[derive(Clone)]
pub struct PtyManager {
    pub terminals: Arc<DashMap<String, Arc<PtyHandle>>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
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
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        configure_pty_command(&mut cmd, cwd);

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let pty_id = uuid::Uuid::new_v4().to_string();
        let (alive_tx, _) = watch::channel::<Option<i32>>(None);
        let (data_tx, _) = broadcast::channel::<String>(256);

        // Clone a killer handle before moving child into the waiter thread.
        let killer = child.clone_killer();
        let write_queue = match PtyWriteQueue::spawn(&pty_id, writer) {
            Ok(queue) => queue,
            Err(error) => {
                kill_and_reap(child, "kill PTY after writer spawn error");
                return Err(error);
            }
        };

        #[cfg(unix)]
        let shell_process_group_leader = pair.master.process_group_leader();
        #[cfg(not(unix))]
        let shell_process_group_leader = None;
        let handle = Arc::new(PtyHandle {
            master: Arc::new(Mutex::new(pair.master)),
            write_queue,
            scrollback: Arc::new(Mutex::new(ScrollbackBuffer::new())),
            alive: Arc::new(alive_tx),
            killer: Arc::new(Mutex::new(killer)),
            data_tx: data_tx.clone(),
            cwd: cwd.to_string(),
            feature_id,
            shell_process_group_leader,
            kind,
        });

        if let Err(error) =
            spawn_reader_thread(&pty_id, reader, Arc::clone(&handle.scrollback), data_tx)
        {
            abandon_spawn(&handle, child, "kill PTY after reader spawn error");
            return Err(error);
        }

        self.terminals.insert(pty_id.clone(), Arc::clone(&handle));

        let waiter = WaiterParts {
            pty_id: pty_id.clone(),
            terminals: Arc::clone(&self.terminals),
            alive_tx: Arc::clone(&handle.alive),
            write_queue: handle.write_queue.clone(),
            runtime: tokio::runtime::Handle::try_current().ok(),
        };
        if let Err((error, child)) = spawn_waiter_thread(waiter, child) {
            self.terminals.remove(&pty_id);
            abandon_spawn(&handle, child, "kill PTY after waiter spawn error");
            return Err(error);
        }

        Ok((pty_id, handle))
    }

    /// Clone the `Arc<PtyHandle>` and immediately drop the `DashMap` shard ref
    /// so no bucket lock is ever held across PTY locks or I/O.
    fn get_handle(&self, pty_id: &str) -> anyhow::Result<Arc<PtyHandle>> {
        self.terminals
            .get(pty_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| anyhow::anyhow!("PTY not found: {pty_id}"))
    }

    /// Queue client input for the PTY. The returned future waits (without
    /// holding a Tokio worker) while the child is not reading, and fails only
    /// when the PTY can no longer take input; callers report that failure.
    pub fn write_pty(
        &self,
        pty_id: &str,
        data: Vec<u8>,
    ) -> impl std::future::Future<Output = anyhow::Result<()>> + Send + 'static {
        let write = self
            .get_handle(pty_id)
            .map(|handle| handle.write_queue.write(data));
        async move { write?.await }
    }

    pub fn resize_pty(&self, pty_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let handle = self.get_handle(pty_id)?;
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

    /// Hang up the PTY's child. The input queue stays open until the waiter
    /// thread sees the child exit: closing it now would drop the master
    /// writer, whose Drop types "\n" + VEOF into the PTY while SIGHUP is still
    /// in flight, and a shell would run the line the user had not submitted.
    pub fn kill_pty(&self, pty_id: &str) -> anyhow::Result<()> {
        let handle = self.get_handle(pty_id)?;
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
        let handle = self.terminals.get(pty_id).map(|e| Arc::clone(e.value()))?;
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
        let handle = self.terminals.get(pty_id).map(|e| Arc::clone(e.value()))?;
        if handle.feature_id != feature_id || handle.kind != PtyKind::Terminal {
            return None;
        }
        let alive = handle.alive.borrow().is_none();
        let (scrollback, data_rx) = handle.subscribe_with_scrollback();
        let cwd = handle.cwd.clone();
        Some(PtyReconnect {
            handle,
            alive,
            scrollback,
            cwd,
            data_rx,
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
        let matches: Vec<(String, Arc<PtyHandle>)> = self
            .terminals
            .iter()
            .filter(|entry| {
                entry.value().feature_id == feature_id && entry.value().kind == PtyKind::Terminal
            })
            .map(|entry| (entry.key().clone(), Arc::clone(entry.value())))
            .collect();
        matches
            .into_iter()
            .map(|(pty_id, handle)| PtySession {
                pty_id,
                cwd: handle.cwd.clone(),
                alive: handle.alive.borrow().is_none(),
                foreground_active: super::activity::pty_foreground_active(&handle),
            })
            .collect()
    }
}

fn configure_pty_command(cmd: &mut CommandBuilder, cwd: &str) {
    cmd.cwd(cwd);
    crate::shared::security::scrub_service_only_pty_env(cmd);
    // Ensure the program knows it's running inside an xterm-compatible
    // terminal. Without this, programs emit wrong escape sequences.
    cmd.env("TERM", "xterm-256color");
    // The renderer is truecolor-capable. Without this, TUIs that probe
    // COLORTERM quantize their palettes to the 256-color cube.
    cmd.env("COLORTERM", "truecolor");
}

/// Tear down a PTY whose setup failed after its writer thread started: reap
/// the child first, so the writer's "\n" + VEOF reaches no live shell.
fn abandon_spawn(handle: &PtyHandle, child: threads::PtyChild, reason: &str) {
    kill_and_reap(child, reason);
    handle.write_queue.close();
}

#[cfg(test)]
mod tests {
    use super::output::publish_output;
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn exit_status_survives_without_a_subscriber() {
        let manager = PtyManager::new();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "exit 7"]);
        let (_, handle) = manager
            .create_pty_with_command(1, command, &temp_existing_dir(), 80, 24, PtyKind::Neovim)
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while handle.alive.borrow().is_none() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("exit must be retained without watch receivers");
        assert_eq!(*handle.alive.subscribe().borrow(), Some(7));
    }

    #[tokio::test]
    async fn output_snapshot_and_subscription_do_not_overlap() {
        let manager = PtyManager::new();
        let (id, handle) = manager.create_pty(1, &temp_existing_dir(), 80, 24).unwrap();
        // Serialize this deterministic publisher with the real reader just as
        // an actual read is serialized with a concurrent reconnect snapshot.
        publish_output(
            &handle.scrollback,
            &handle.data_tx,
            "before-snapshot".to_string(),
        );
        let reconnect = manager.reconnect_for_feature(&id, 1).unwrap();
        let snapshot = reconnect.scrollback;
        let mut receiver = reconnect.data_rx;
        publish_output(
            &handle.scrollback,
            &handle.data_tx,
            "after-snapshot".to_string(),
        );
        assert!(snapshot.contains("before-snapshot"));
        assert!(!snapshot.contains("after-snapshot"));
        let mut found_after = false;
        while let Ok(chunk) = receiver.try_recv() {
            assert!(!chunk.contains("before-snapshot"));
            found_after |= chunk.contains("after-snapshot");
        }
        assert!(found_after);
        manager.kill_pty(&id).unwrap();
    }

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
                b"printf 'CADENCR_TEST_PTY_ENV=%s AUTH=%s\\n' \"$CADENCR_TEST_PTY_ENV\" \"${CADENCR_AUTH_TOKEN-unset}\"\nexit\n".to_vec(),
            )
            .await
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
            .write_pty(
                &pty_id,
                b"printf 'CADENCR_SHELL_ARG0=%s\\n' \"$0\"\nexit\n".to_vec(),
            )
            .await
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

    /// Spawn `script` under `/bin/sh` and wait until it prints READY.
    #[cfg(unix)]
    async fn spawn_ready(manager: &PtyManager, script: &str) -> (String, Arc<PtyHandle>) {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", script]);
        let (pty_id, handle) = manager
            .create_pty_with_command(77, cmd, &temp_existing_dir(), 80, 24, PtyKind::Terminal)
            .expect("spawn child");
        assert!(
            wait_for_scrollback(manager, &pty_id, "READY").await,
            "child never became ready"
        );
        (pty_id, handle)
    }

    #[cfg(unix)]
    fn sigkill_foreground(handle: &PtyHandle) {
        let pid = handle.shell_process_group_leader.expect("foreground pid");
        // SAFETY: plain signal delivery to a child this test spawned.
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_paste_larger_than_the_queue_reaches_the_child_intact() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("paste.bin");
        let size = 1024 * 1024;
        // Raw mode: no line discipline limit or echo between us and `head`.
        let script = format!(
            "stty raw -echo; printf 'READY\\n'; head -c {size} > '{}'; printf 'DONE\\n'",
            out.display()
        );
        let (pty_id, _handle) = spawn_ready(&manager, &script).await;

        let payload: Vec<u8> = (0..size).map(|i| b'a' + (i % 26) as u8).collect();
        tokio::time::timeout(
            std::time::Duration::from_secs(20),
            manager.write_pty(&pty_id, payload.clone()),
        )
        .await
        .expect("a 1 MiB paste must not hang")
        .expect("a 1 MiB paste must be accepted, not dropped");

        let mut done = false;
        for _ in 0..500 {
            if manager
                .get_scrollback(&pty_id)
                .is_some_and(|(_, output)| output.contains("DONE"))
            {
                done = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        manager.kill_all();
        assert!(done, "the child never received the whole paste");
        assert_eq!(std::fs::read(&out).unwrap(), payload);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_write_waiting_on_a_stalled_child_fails_once_it_is_killed() {
        let manager = PtyManager::new();
        let (pty_id, _handle) =
            spawn_ready(&manager, "stty raw -echo; printf 'READY\\n'; exec sleep 60").await;

        let ticks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ticks_task = Arc::clone(&ticks);
        let ticker = tokio::spawn(async move {
            for _ in 0..10 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                ticks_task.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        });

        let mut write = Box::pin(manager.write_pty(&pty_id, vec![b'x'; 2 * 1024 * 1024]));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(300), &mut write)
                .await
                .is_err(),
            "input for a child that does not read must wait, not be dropped"
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), ticker)
            .await
            .expect("a waiting write must not stall the runtime")
            .unwrap();
        assert_eq!(ticks.load(std::sync::atomic::Ordering::Relaxed), 10);

        manager.kill_pty(&pty_id).unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_secs(5), write)
            .await
            .expect("killing the child wakes the waiting write")
            .expect_err("a dead child takes no input");
        // Either the waiter closed the queue, or the in-flight write saw the
        // hangup first (EIO on macOS); both name the real cause.
        let message = error.to_string();
        assert!(
            message.contains("exited") || message.contains("writing to the terminal failed"),
            "{message}"
        );
        manager.kill_all();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_pty_types_nothing_into_a_child_that_outlives_the_hangup() {
        let manager = PtyManager::new();
        // The child ignores SIGHUP and echoes every byte it reads (raw, no
        // echo): anything the kill path types into the PTY shows up as output.
        let (pty_id, handle) = spawn_ready(
            &manager,
            "trap '' HUP; stty raw -echo; printf 'READY\\n'; exec cat",
        )
        .await;
        manager.write_pty(&pty_id, b"typed".to_vec()).await.unwrap();
        assert!(wait_for_scrollback(&manager, &pty_id, "typed").await);

        manager.kill_pty(&pty_id).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let (_, output) = manager.get_scrollback(&pty_id).unwrap();
        assert!(
            !output.contains('\u{4}') && !output.contains("typed\n"),
            "kill must not type a newline/EOF into the PTY: {output:?}"
        );
        manager
            .write_pty(&pty_id, b"-still-open".to_vec())
            .await
            .expect("input stays open until the child actually exits");
        assert!(wait_for_scrollback(&manager, &pty_id, "typed-still-open").await);

        sigkill_foreground(&handle);
        manager.kill_all();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn write_pty_preserves_fifo_order_for_200_lines() {
        let manager = PtyManager::new();
        let cwd = temp_existing_dir();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "stty -echo; printf 'READY\\n'; exec cat"]);
        let (pty_id, handle) = manager
            .create_pty_with_command(78, cmd, &cwd, 80, 24, PtyKind::Terminal)
            .expect("spawn cat");

        let (initial, mut rx) = handle.subscribe_with_scrollback();
        let mut collected = initial;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !collected.contains("READY") {
                if let Ok(chunk) = rx.recv().await {
                    collected.push_str(&chunk);
                }
            }
        })
        .await
        .expect("cat child should become ready");

        for i in 0..200 {
            let line = format!("line-{i:03}\n");
            manager.write_pty(&pty_id, line.into_bytes()).await.unwrap();
        }

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !collected.contains("line-199") {
                if let Ok(chunk) = rx.recv().await {
                    collected.push_str(&chunk);
                }
            }
        })
        .await
        .expect("all 200 lines should echo back from cat");

        let received: Vec<&str> = collected
            .lines()
            .map(|l| l.trim_end_matches('\r'))
            .filter(|l| l.starts_with("line-"))
            .collect();
        let expected: Vec<String> = (0..200).map(|i| format!("line-{i:03}")).collect();
        assert_eq!(received, expected);

        manager.kill_all();
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
