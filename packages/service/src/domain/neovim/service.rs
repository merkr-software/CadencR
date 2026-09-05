use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use portable_pty::CommandBuilder;
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::domain::terminal::cwd::resolve_cwd;
use crate::domain::terminal::service::{PtyKind, PtyManager};
use crate::error::AppError;

#[cfg(test)]
use nvim_rs::rpc::handler::Dummy;

use super::protocol::NeovimStartResponse;

mod file;
mod lifecycle;
pub use lifecycle::nvim_available;
use lifecycle::{nvim_version, wait_for_socket, StartupPty};

/// A running Neovim process for one feature: its PTY (display) and its
/// control socket (programmatic file-open / cursor jumps).
struct NeovimHandle {
    pty_id: String,
    #[allow(dead_code)]
    control_socket: PathBuf,
    /// Owned so the socket's temp directory outlives the process.
    _socket_dir: tempfile::TempDir,
}

/// Supervises one real Neovim process per feature. All PTY plumbing (reader
/// task, output broadcast, scrollback, resize, kill) is delegated to
/// `PtyManager`; this type only owns the feature → process mapping and the
/// control socket path.
pub struct NeovimManager {
    processes: Arc<Mutex<HashMap<i64, NeovimHandle>>>,
    /// Serializes the spawn sequence across features so Cadencr never triggers
    /// two simultaneous first-time plugin installs into the same shared
    /// plugin directory.
    spawn_lock: Arc<Mutex<()>>,
    pty_manager: PtyManager,
    /// Resolves each feature's worktree path before spawning, so plugins that
    /// assume a real project directory (network installs, path-relative
    /// config) don't get stuck behind a hit-enter error prompt from running
    /// out of a bare temp directory.
    read_pool: SqlitePool,
}

impl NeovimManager {
    pub fn new(pty_manager: PtyManager, read_pool: SqlitePool) -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            spawn_lock: Arc::new(Mutex::new(())),
            pty_manager,
            read_pool,
        }
    }

    /// Start (or return the already-running) Neovim process for `feature_id`.
    pub async fn start(&self, feature_id: i64) -> Result<NeovimStartResponse, AppError> {
        self.ensure_started(feature_id).await?;
        Ok(NeovimStartResponse {
            version: nvim_version().await,
        })
    }

    /// WebSocket attachment needs a process, not a fresh version subprocess.
    pub(crate) async fn ensure_started(&self, feature_id: i64) -> Result<(), AppError> {
        if self.is_running(feature_id).await {
            return Ok(());
        }

        let _spawn_guard = self.spawn_lock.lock().await;

        // Re-check under the lock: another task may have spawned this feature
        // while we waited.
        if self.is_running(feature_id).await {
            return Ok(());
        }

        let socket_dir = tempfile::tempdir().map_err(|e| AppError::NeovimSpawnError {
            detail: format!("failed to create control socket directory: {e}"),
        })?;
        // The tempdir is already unique per spawn, so the socket needs no
        // per-feature name of its own — keeps `feature_id` (client-supplied)
        // out of path construction entirely, rather than trusting its `i64`
        // type to rule out traversal characters.
        let control_socket = socket_dir.path().join("nvim.sock");

        let mut cmd = CommandBuilder::new("nvim");
        // Tests must not load or mutate the developer's plugins/instance state.
        #[cfg(test)]
        cmd.arg("--clean");
        cmd.arg("--listen");
        cmd.arg(&control_socket);
        // GUI-launched service processes (the Electron sidecar) don't inherit
        // the user's login-shell PATH, so a Homebrew-installed `nvim` resolves
        // in a terminal but not here. Widen PATH when the login shell gives us
        // one; otherwise keep the inherited value.
        if let Some(login_path) = cli_discovery::login_shell_path().await {
            cmd.env("PATH", login_path);
        }

        let project_id = project_id_for_feature(&self.read_pool, feature_id).await?;
        let cwd = resolve_cwd(&self.read_pool, feature_id, project_id).await?;
        let (pty_id, pty_handle) = self
            .pty_manager
            .create_pty_with_command(feature_id, cmd, &cwd, 120, 40, PtyKind::Neovim)
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })?;

        let mut startup = StartupPty::new(self.pty_manager.clone(), pty_id.clone());
        let mut alive = pty_handle.alive.subscribe();
        wait_for_socket(&control_socket, &mut alive).await?;

        self.processes.lock().await.insert(
            feature_id,
            NeovimHandle {
                pty_id: pty_id.clone(),
                control_socket,
                _socket_dir: socket_dir,
            },
        );
        startup.disarm();

        // `:q`/`:qa` (or a crash) exits the process without telling this
        // manager — nothing else observes `alive`. Without this, `is_running`
        // keeps reporting true forever, so a later reconnect or open_file call
        // reuses a dead pty_id/socket pair instead of respawning. Only clears
        // the entry it just inserted: a restart in between already replaced
        // it with a fresh pty_id, and that one owns the removal.
        let processes = self.processes.clone();
        tokio::spawn(async move {
            while alive.borrow_and_update().is_none() {
                if alive.changed().await.is_err() {
                    break;
                }
            }
            let mut processes = processes.lock().await;
            if processes.get(&feature_id).map(|h| &h.pty_id) == Some(&pty_id) {
                processes.remove(&feature_id);
            }
        });

        Ok(())
    }

    /// Kill the feature's Neovim process and forget it.
    pub async fn stop(&self, feature_id: i64) -> Result<(), AppError> {
        let _spawn_guard = self.spawn_lock.lock().await;
        let mut processes = self.processes.lock().await;
        let handle = processes
            .get(&feature_id)
            .ok_or(AppError::NeovimNotRunning {
                feature_id: feature_id.to_string(),
            })?;
        self.pty_manager
            .kill_pty(&handle.pty_id)
            .map_err(|e| AppError::NeovimSpawnError {
                detail: format!("failed to kill neovim pty: {e}"),
            })?;
        processes.remove(&feature_id);
        Ok(())
    }

    pub(crate) async fn is_running(&self, feature_id: i64) -> bool {
        self.processes.lock().await.contains_key(&feature_id)
    }

    /// PTY id backing this feature's Neovim, so the WS layer can attach to the
    /// existing broadcast channel rather than opening a second stream.
    #[allow(dead_code)]
    pub(crate) async fn pty_id(&self, feature_id: i64) -> Option<String> {
        self.processes
            .lock()
            .await
            .get(&feature_id)
            .map(|handle| handle.pty_id.clone())
    }

    /// Path of this feature's `--listen` control socket.
    #[allow(dead_code)]
    pub(crate) async fn control_socket_path(&self, feature_id: i64) -> Option<PathBuf> {
        self.processes
            .lock()
            .await
            .get(&feature_id)
            .map(|handle| handle.control_socket.clone())
    }

    /// Open `path` in this feature's Neovim and move the cursor there.
    ///
    /// `line` and `col` are 1-indexed, matching how humans write a reference
    /// (`main.rs:240:2` = line 240, 2nd character). Neovim's
    /// `nvim_win_set_cursor` wants a 1-indexed line but a 0-indexed column, so
    /// the column is decremented on the way in.
    pub async fn open_file(
        &self,
        feature_id: i64,
        path: &str,
        line: Option<u32>,
        col: Option<u32>,
    ) -> Result<(), AppError> {
        let socket = self
            .control_socket_path(feature_id)
            .await
            .ok_or(AppError::NeovimProcessNotRunning)?;

        let pty_id = self
            .pty_id(feature_id)
            .await
            .ok_or(AppError::NeovimProcessNotRunning)?;
        let cwd = self
            .pty_manager
            .terminals
            .get(&pty_id)
            .map(|handle| handle.cwd.clone())
            .ok_or(AppError::NeovimProcessNotRunning)?;
        let path = file::scoped_file_path(&cwd, path)?;
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            file::open_file(&socket, &path, line, col),
        )
        .await
        .map_err(|_| AppError::NeovimSpawnError {
            detail: "Neovim file-open request timed out".to_string(),
        })?
    }

    /// Current cursor position as Neovim reports it: (1-indexed line,
    /// 0-indexed column). Used by tests to assert `open_file` landed correctly.
    #[cfg(test)]
    pub(crate) async fn cursor_position(&self, feature_id: i64) -> Result<(i64, i64), AppError> {
        let socket = self
            .control_socket_path(feature_id)
            .await
            .ok_or(AppError::NeovimProcessNotRunning)?;
        let (nvim, io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })?;
        let _io = file::RpcTask(io.abort_handle());
        let window = nvim
            .get_current_win()
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })?;
        window
            .get_cursor()
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })
    }

    /// How many tab pages the session currently has. Lets the tests assert that
    /// opening files stacks tabs instead of replacing the visible buffer.
    #[cfg(test)]
    pub(crate) async fn tab_page_count(&self, feature_id: i64) -> Result<usize, AppError> {
        let socket = self
            .control_socket_path(feature_id)
            .await
            .ok_or(AppError::NeovimProcessNotRunning)?;
        let (nvim, io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })?;
        let _io = file::RpcTask(io.abort_handle());
        let tabs = nvim
            .list_tabpages()
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })?;
        Ok(tabs.len())
    }
}

impl Clone for NeovimManager {
    fn clone(&self) -> Self {
        Self {
            processes: self.processes.clone(),
            spawn_lock: self.spawn_lock.clone(),
            pty_manager: self.pty_manager.clone(),
            read_pool: self.read_pool.clone(),
        }
    }
}

/// Looks up a feature's owning project, so `start` can resolve its worktree
/// path instead of spawning nvim into a bare temp directory.
async fn project_id_for_feature(pool: &SqlitePool, feature_id: i64) -> Result<i64, AppError> {
    sqlx::query_scalar("SELECT project_id FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id}")))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    struct TestManager(NeovimManager);

    impl std::ops::Deref for TestManager {
        type Target = NeovimManager;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl Drop for TestManager {
        fn drop(&mut self) {
            // Assertions may panic before stop(): never strand blocking PTY
            // readers or real Neovim children in the test runtime.
            self.0.pty_manager.kill_all();
        }
    }

    pub(crate) async fn nvim_available_test() -> bool {
        let Some(login_path) = cli_discovery::login_shell_path().await else {
            return false;
        };
        std::process::Command::new("nvim")
            .arg("--version")
            .env("PATH", &login_path)
            .output()
            .is_ok()
    }

    /// Seeds an in-memory project + feature rows for every id the tests in
    /// this module use, so `start`'s `resolve_cwd` call has something to
    /// resolve. All features share one project pointing at a real temp dir
    /// (there's no worktree row, so `resolve_cwd` falls back to it).
    async fn test_manager() -> TestManager {
        use sqlx::sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, path TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (feature_id, key))",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER)")
            .execute(&pool)
            .await
            .unwrap();

        let project_path = std::env::temp_dir().to_string_lossy().into_owned();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'test', ?)")
            .bind(project_path)
            .execute(&pool)
            .await
            .unwrap();
        for feature_id in [1, 2, 3, 4, 10, 11, 12, 13, 14, 901, 902] {
            sqlx::query("INSERT INTO features (id, project_id) VALUES (?, 1)")
                .bind(feature_id)
                .execute(&pool)
                .await
                .unwrap();
        }

        TestManager(NeovimManager::new(PtyManager::new(), pool))
    }

    /// Absolute path of the buffer Neovim currently shows. Lets a test assert
    /// which file `open_file` actually landed on, rather than just that the Ex
    /// command returned without error.
    async fn current_buffer_name(manager: &NeovimManager, feature_id: i64) -> String {
        let socket = manager.control_socket_path(feature_id).await.unwrap();
        let (nvim, io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .unwrap();
        let _io = file::RpcTask(io.abort_handle());
        nvim.eval("expand('%:p')")
            .await
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn websocket_ensure_started_reuses_the_running_process() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let manager = test_manager().await;
        manager.ensure_started(1).await.unwrap();
        let first = manager.pty_id(1).await.unwrap();
        // Existing processes do not need the spawn lock or a version probe.
        let _guard = manager.spawn_lock.lock().await;
        for _ in 0..3 {
            tokio::time::timeout(
                std::time::Duration::from_millis(100),
                manager.ensure_started(1),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(manager.pty_id(1).await.as_deref(), Some(first.as_str()));
        }
    }

    #[tokio::test]
    async fn start_spawns_a_pty_and_reports_a_version() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found in test environment");
            return;
        }
        let manager = test_manager().await;
        let info = manager.start(1).await.expect("start should succeed");
        assert!(!info.version.is_empty(), "version should be reported");
        assert!(manager.is_running(1).await);
        manager.stop(1).await.unwrap();
    }

    #[tokio::test]
    async fn start_respawns_after_the_process_exits_on_its_own() {
        // Regression test: `:q`/`:qa` (or a crash) exits the process without
        // going through `stop()`, which is the only place that used to clear
        // the manager's bookkeeping. Simulated here by killing the pty
        // directly, bypassing `stop()`, exactly like an in-process `:qa` would.
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let manager = test_manager().await;
        manager.start(14).await.unwrap();
        let first_pty_id = manager.pty_id(14).await.expect("pty id after start");
        assert!(manager.is_running(14).await);

        manager
            .pty_manager
            .kill_pty(&first_pty_id)
            .expect("kill the pty directly, as if the process quit on its own");

        // The exit-watcher task runs on its own; give it a moment to observe
        // the `alive` change and clear the stale entry.
        let cleared = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while manager.is_running(14).await {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(
            cleared.is_ok(),
            "manager should notice the process exited and clear its own bookkeeping"
        );

        manager
            .start(14)
            .await
            .expect("start should respawn instead of reusing the dead process");
        let second_pty_id = manager.pty_id(14).await.expect("pty id after respawn");
        assert_ne!(
            first_pty_id, second_pty_id,
            "respawn must be a genuinely new process, not the dead one"
        );

        manager.stop(14).await.unwrap();
    }

    #[tokio::test]
    async fn start_is_idempotent_for_the_same_feature() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let manager = test_manager().await;
        manager.start(2).await.unwrap();
        let pty_id_first = manager.pty_id(2).await.expect("pty id after first start");
        manager.start(2).await.unwrap();
        let pty_id_second = manager.pty_id(2).await.expect("pty id after second start");
        assert_eq!(
            pty_id_first, pty_id_second,
            "a second start must reuse the running process, not spawn another"
        );
        manager.stop(2).await.unwrap();
    }

    #[tokio::test]
    async fn stop_removes_the_feature_and_is_reported_as_not_running() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let manager = test_manager().await;
        manager.start(3).await.unwrap();
        manager.stop(3).await.unwrap();
        assert!(!manager.is_running(3).await);
        assert!(matches!(
            manager.stop(3).await,
            Err(AppError::NeovimNotRunning { .. })
        ));
    }

    #[tokio::test]
    async fn start_creates_a_listening_control_socket() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let manager = test_manager().await;
        manager.start(4).await.unwrap();
        let socket = manager
            .control_socket_path(4)
            .await
            .expect("socket path should be recorded");
        assert!(
            socket.exists(),
            "nvim --listen should have created the socket at {}",
            socket.display()
        );
        manager.stop(4).await.unwrap();
    }

    #[tokio::test]
    async fn stopping_an_unknown_feature_errors() {
        let manager = test_manager().await;
        assert!(matches!(
            manager.stop(999).await,
            Err(AppError::NeovimNotRunning { .. })
        ));
    }

    #[tokio::test]
    async fn concurrent_starts_wait_for_shared_spawn_lock() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let manager = test_manager().await;
        let guard = manager.spawn_lock.lock().await;
        let mut first = Box::pin(manager.start(901));
        let mut second = Box::pin(manager.start(902));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), async {
                tokio::join!(&mut first, &mut second)
            })
            .await
            .is_err()
        );
        assert!(manager.pty_manager.terminals.is_empty());
        drop(guard);

        let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            tokio::join!(first, second)
        })
        .await
        .expect("both starts should complete after releasing the shared spawn lock");
        first.unwrap();
        second.unwrap();
        assert_ne!(manager.pty_id(901).await, manager.pty_id(902).await);
        manager.stop(901).await.unwrap();
        manager.stop(902).await.unwrap();
    }

    #[tokio::test]
    async fn open_file_gives_each_file_its_own_tab_without_duplicating() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.txt");
        let second = dir.path().join("second.txt");
        std::fs::write(&first, "alpha\n").unwrap();
        std::fs::write(&second, "bravo\n").unwrap();

        let manager = test_manager().await;
        manager.start(11).await.unwrap();

        manager
            .open_file(11, first.to_str().unwrap(), None, None)
            .await
            .expect("open first file");
        let first_count = manager.tab_page_count(11).await.unwrap();
        assert_eq!(first_count, 1, "the initial empty buffer should be reused");
        manager
            .open_file(11, second.to_str().unwrap(), None, None)
            .await
            .expect("open second file");

        // `:edit` used to replace the visible buffer, so a second file threw the
        // first away and the pane never gained a tab.
        assert_eq!(
            manager.tab_page_count(11).await.unwrap(),
            first_count + 1,
            "each file should get its own tab page"
        );

        manager
            .open_file(11, first.to_str().unwrap(), None, None)
            .await
            .expect("reopen the first file");
        assert_eq!(
            manager.tab_page_count(11).await.unwrap(),
            first_count + 1,
            "reopening an already-open file jumps to its tab instead of duplicating it"
        );

        manager.stop(11).await.unwrap();
    }

    #[tokio::test]
    async fn open_file_places_the_cursor_at_the_requested_line_and_column() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sample.txt");
        std::fs::write(&file, "alpha\nbravo\ncharlie\ndelta\n").unwrap();

        let manager = test_manager().await;
        manager.start(10).await.unwrap();
        manager
            .open_file(10, file.to_str().unwrap(), Some(3), Some(2))
            .await
            .expect("open_file should succeed");

        let position = manager.cursor_position(10).await.expect("read cursor back");
        assert_eq!(
            position,
            (3, 1),
            "line stays 1-indexed, human column 2 becomes 0-indexed 1"
        );
        manager.stop(10).await.unwrap();
    }

    #[tokio::test]
    async fn scheduled_plugin_focus_cannot_redirect_the_requested_cursor() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor.txt");
        std::fs::write(&path, "alpha\nbravo\ncharlie\n").unwrap();
        let manager = test_manager().await;
        manager.start(10).await.unwrap();
        let socket = manager.control_socket_path(10).await.unwrap();
        let (nvim, io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .unwrap();
        let _io = file::RpcTask(io.abort_handle());
        nvim.exec_lua(
            r#"
            vim.api.nvim_create_autocmd('BufEnter', {
                once = true,
                callback = function()
                    vim.schedule(function()
                        vim.cmd('vnew')
                        vim.api.nvim_buf_set_name(0, 'test-sidebar')
                    end)
                end,
            })
        "#,
            vec![],
        )
        .await
        .unwrap();
        manager
            .open_file(10, path.to_str().unwrap(), Some(3), Some(2))
            .await
            .unwrap();
        let expected = std::fs::canonicalize(&path).unwrap();
        let mut actual = None;
        for window in nvim.list_wins().await.unwrap() {
            let buffer = window.get_buf().await.unwrap();
            if std::path::Path::new(&buffer.get_name().await.unwrap()) == expected {
                actual = Some(window.get_cursor().await.unwrap());
            }
        }
        assert_eq!(
            actual,
            Some((3, 1)),
            "cursor belongs to the file, not the plugin sidebar"
        );
        manager.stop(10).await.unwrap();
    }

    #[tokio::test]
    async fn open_file_without_line_defaults_to_the_top_of_the_file() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sample.txt");
        std::fs::write(&file, "alpha\nbravo\n").unwrap();

        let manager = test_manager().await;
        manager.start(11).await.unwrap();
        manager
            .open_file(11, file.to_str().unwrap(), None, None)
            .await
            .expect("open_file should succeed");

        let position = manager.cursor_position(11).await.expect("read cursor back");
        assert_eq!(position, (1, 0));
        manager.stop(11).await.unwrap();
    }

    #[tokio::test]
    async fn open_file_on_a_missing_file_reports_file_not_found() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let manager = test_manager().await;
        manager.start(12).await.unwrap();
        let result = manager
            .open_file(12, "/definitely/does/not/exist.txt", Some(1), None)
            .await;
        manager.stop(12).await.unwrap();
        assert!(matches!(result, Err(AppError::NeovimFileNotFound { .. })));
    }

    #[tokio::test]
    async fn open_file_without_a_running_process_errors() {
        let manager = test_manager().await;
        let result = manager.open_file(13, "/tmp/whatever.txt", None, None).await;
        assert!(matches!(result, Err(AppError::NeovimProcessNotRunning)));
    }

    /// Every one of these is a legal POSIX filename and a piece of Ex grammar:
    /// a space separates arguments, `%`/`#` are buffer shorthands, and `|`
    /// starts a second command — `tab drop a|bwd` used to run `bwd`.
    #[tokio::test]
    async fn open_file_handles_ex_metacharacters_in_the_filename() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager().await;
        manager.start(14).await.unwrap();

        for name in ["a b.txt", "100%.txt", "i#1.txt", "a|bwd.txt"] {
            let file = dir.path().join(name);
            std::fs::write(&file, "alpha\n").unwrap();
            manager
                .open_file(14, file.to_str().unwrap(), None, None)
                .await
                .unwrap_or_else(|e| panic!("open {name}: {e:?}"));
            let opened = current_buffer_name(&manager, 14).await;
            assert_eq!(
                opened,
                std::fs::canonicalize(&file).unwrap().to_string_lossy(),
                "{name} opened the wrong buffer"
            );
        }

        manager.stop(14).await.unwrap();
    }
}
