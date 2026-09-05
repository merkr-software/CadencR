use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use portable_pty::CommandBuilder;
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use tracing::{debug, warn};

use crate::domain::terminal::cwd::resolve_cwd;
use crate::domain::terminal::service::{PtyKind, PtyManager};
use crate::error::AppError;

use nvim_rs::rpc::handler::Dummy;

use super::protocol::NeovimStartResponse;

/// How long a first-time spawn may take before it is treated as failed. Kept
/// wide because a fresh user config's plugin manager installs everything on
/// its first launch, which routinely takes tens of seconds.
const SPAWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

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
        if self.is_running(feature_id).await {
            return Ok(NeovimStartResponse {
                version: nvim_version().await,
            });
        }

        let _spawn_guard = self.spawn_lock.lock().await;

        // Re-check under the lock: another task may have spawned this feature
        // while we waited.
        if self.is_running(feature_id).await {
            return Ok(NeovimStartResponse {
                version: nvim_version().await,
            });
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

        wait_for_socket(&control_socket).await?;

        self.processes.lock().await.insert(
            feature_id,
            NeovimHandle {
                pty_id: pty_id.clone(),
                control_socket,
                _socket_dir: socket_dir,
            },
        );

        // `:q`/`:qa` (or a crash) exits the process without telling this
        // manager — nothing else observes `alive`. Without this, `is_running`
        // keeps reporting true forever, so a later reconnect or open_file call
        // reuses a dead pty_id/socket pair instead of respawning. Only clears
        // the entry it just inserted: a restart in between already replaced
        // it with a fresh pty_id, and that one owns the removal.
        let processes = self.processes.clone();
        let mut alive = pty_handle.alive.subscribe();
        tokio::spawn(async move {
            if alive.changed().await.is_err() {
                return;
            }
            let mut processes = processes.lock().await;
            if processes.get(&feature_id).map(|h| &h.pty_id) == Some(&pty_id) {
                processes.remove(&feature_id);
            }
        });

        Ok(NeovimStartResponse {
            version: nvim_version().await,
        })
    }

    /// Kill the feature's Neovim process and forget it.
    pub async fn stop(&self, feature_id: i64) -> Result<(), AppError> {
        let handle =
            self.processes
                .lock()
                .await
                .remove(&feature_id)
                .ok_or(AppError::NeovimNotRunning {
                    feature_id: feature_id.to_string(),
                })?;
        self.pty_manager
            .kill_pty(&handle.pty_id)
            .map_err(|e| AppError::NeovimSpawnError {
                detail: format!("failed to kill neovim pty: {e}"),
            })?;
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

        let (nvim, _io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: format!("control socket unavailable: {e}"),
            })?;

        // Asked of Neovim rather than the filesystem: callers send paths
        // relative to the project, and Neovim is the process actually running
        // there — resolving them against the service's own working directory
        // would reject every relative path. Needed because `:tab drop` opens an
        // empty buffer for a missing path, where `:edit` used to fail.
        //
        // Passed as an RPC argument rather than interpolated into an expression,
        // so no quoting rule applies to it at all.
        let readable = call_str_fn(&nvim, "filereadable", path).await?;
        if readable.as_i64() != Some(1) {
            return Err(AppError::NeovimFileNotFound {
                path: path.to_string(),
            });
        }

        // Escaped by Neovim itself: the path is about to be interpolated into an
        // Ex command line, where `|` starts a second command and a newline ends
        // the line outright, on top of the space / `%` / `#` cases. `fnameescape`
        // is the authority on that grammar, and all of these are legal
        // characters in a POSIX filename.
        let escaped = call_str_fn(&nvim, "fnameescape", path).await?;
        let escaped = escaped.as_str().ok_or_else(|| AppError::NeovimSpawnError {
            detail: "fnameescape() returned a non-string".to_string(),
        })?;

        // `:tab drop`, not `:edit`: `edit` replaces the current window's buffer,
        // so every open from the file tree threw away the previous file. `drop`
        // jumps to the file if it is already open and opens a new tab page
        // otherwise — the same semantics the CodeMirror pane gives its tabs. An
        // empty unnamed buffer is reused rather than leaving a blank first tab.
        nvim.command(&format!("tab drop {escaped}"))
            .await
            .map_err(|_| AppError::NeovimFileNotFound {
                path: path.to_string(),
            })?;

        let target_line = line.unwrap_or(1).max(1) as i64;
        let target_col = col.unwrap_or(1).max(1) as i64 - 1;
        let window = nvim
            .get_current_win()
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })?;
        window
            .set_cursor((target_line, target_col))
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })?;

        Ok(())
    }

    /// Current cursor position as Neovim reports it: (1-indexed line,
    /// 0-indexed column). Used by tests to assert `open_file` landed correctly.
    #[cfg(test)]
    pub(crate) async fn cursor_position(&self, feature_id: i64) -> Result<(i64, i64), AppError> {
        let socket = self
            .control_socket_path(feature_id)
            .await
            .ok_or(AppError::NeovimProcessNotRunning)?;
        let (nvim, _io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })?;
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
        let (nvim, _io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .map_err(|e| AppError::NeovimSpawnError {
                detail: e.to_string(),
            })?;
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

/// Poll until `nvim --listen` has created its socket, or the spawn ceiling
/// elapses. Neovim creates the socket only once startup (including any
/// first-time plugin installation) has progressed far enough to serve RPC.
async fn wait_for_socket(path: &std::path::Path) -> Result<(), AppError> {
    let deadline = tokio::time::Instant::now() + SPAWN_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if path.exists() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(AppError::NeovimHandshakeTimeout)
}

/// Version string from `nvim --version`'s first line (e.g. "NVIM v0.10.2"),
/// resolving PATH the same way the spawn path does so both agree on which
/// binary is in play. Empty when nvim is unavailable.
async fn nvim_version() -> String {
    let mut cmd = tokio::process::Command::new("nvim");
    cmd.arg("--version");
    match cli_discovery::login_shell_path().await {
        Some(login_path) => {
            debug!(path = %login_path, "resolved login-shell PATH for nvim detection");
            cmd.env("PATH", login_path);
        }
        None => {
            debug!("no login-shell PATH resolved; falling back to inherited process PATH for nvim detection");
        }
    }
    let output = match cmd.output().await {
        Ok(output) => output,
        Err(error) => {
            warn!(%error, "failed to spawn `nvim --version`");
            return String::new();
        }
    };
    if !output.status.success() {
        warn!(
            status = %output.status,
            stderr = %String::from_utf8_lossy(&output.stderr),
            "`nvim --version` exited non-zero"
        );
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Whether `nvim` is spawnable, resolving PATH the same way `start` does.
pub async fn nvim_available() -> bool {
    !nvim_version().await.is_empty()
}

/// Call a Neovim function taking a single string argument. Keeps the path out
/// of any interpolated expression: it travels as a msgpack value, so neither
/// vimscript string quoting nor Ex-command grammar can reinterpret it.
async fn call_str_fn<W>(
    nvim: &nvim_rs::Neovim<W>,
    name: &str,
    arg: &str,
) -> Result<nvim_rs::Value, AppError>
where
    W: futures::AsyncWrite + Send + Unpin + 'static,
{
    nvim.call_function(name, vec![nvim_rs::Value::from(arg)])
        .await
        .map_err(|e| AppError::NeovimSpawnError {
            detail: format!("{name}(): {e}"),
        })
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;
    use tokio::sync::Mutex;

    use super::*;

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
    async fn test_manager() -> NeovimManager {
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

        NeovimManager::new(PtyManager::new(), pool)
    }

    /// Absolute path of the buffer Neovim currently shows. Lets a test assert
    /// which file `open_file` actually landed on, rather than just that the Ex
    /// command returned without error.
    async fn current_buffer_name(manager: &NeovimManager, feature_id: i64) -> String {
        let socket = manager.control_socket_path(feature_id).await.unwrap();
        let (nvim, _io) = nvim_rs::create::tokio::new_path(&socket, Dummy::new())
            .await
            .unwrap();
        nvim.eval("expand('%:p')")
            .await
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
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
    async fn concurrent_first_time_spawns_do_not_overlap() {
        if !nvim_available_test().await {
            eprintln!("SKIP: nvim binary not found");
            return;
        }
        let events: Arc<Mutex<Vec<(i64, &'static str, std::time::Instant)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let manager = test_manager().await;

        let events_a = events.clone();
        let manager_a = manager.clone();
        let handle_a = tokio::spawn(async move {
            events_a
                .lock()
                .await
                .push((901, "start", std::time::Instant::now()));
            manager_a.start(901).await.unwrap();
            events_a
                .lock()
                .await
                .push((901, "end", std::time::Instant::now()));
        });

        let events_b = events.clone();
        let manager_b = manager.clone();
        let handle_b = tokio::spawn(async move {
            events_b
                .lock()
                .await
                .push((902, "start", std::time::Instant::now()));
            manager_b.start(902).await.unwrap();
            events_b
                .lock()
                .await
                .push((902, "end", std::time::Instant::now()));
        });

        let _ = tokio::join!(handle_a, handle_b);

        let log = events.lock().await;
        let at = |id: i64, kind: &str| {
            log.iter()
                .find(|(i, k, _)| *i == id && *k == kind)
                .unwrap()
                .2
        };
        let (first_end, second_start) = if at(901, "start") <= at(902, "start") {
            (at(901, "end"), at(902, "start"))
        } else {
            (at(902, "end"), at(901, "start"))
        };
        assert!(
            second_start >= first_end - std::time::Duration::from_millis(50),
            "spawns overlapped despite the spawn lock"
        );
        drop(log);

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
        manager
            .open_file(11, second.to_str().unwrap(), None, None)
            .await
            .expect("open second file");

        // `:edit` used to replace the visible buffer, so a second file threw the
        // first away and the pane never gained a tab.
        assert_eq!(
            manager.tab_page_count(11).await.unwrap(),
            2,
            "each file should get its own tab page"
        );

        manager
            .open_file(11, first.to_str().unwrap(), None, None)
            .await
            .expect("reopen the first file");
        assert_eq!(
            manager.tab_page_count(11).await.unwrap(),
            2,
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
                file.to_string_lossy(),
                "{name} opened the wrong buffer"
            );
        }

        manager.stop(14).await.unwrap();
    }
}
