#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::Message;
use tokio::sync::{mpsc, Mutex};

#[cfg(test)]
use super::handle::Subscriber;
use super::handle::{repo_lock, schedule_grace_drop, sender_eq, spawn_handle, RegistryInner};
use super::pending::PendingSubscriptions;
use super::subscription::{push_subscriber_dedup, resolve_paths};
use crate::app_state::AppState;
use crate::domain::git::git_status::{self, GitStatusSnapshot};
use crate::domain::git::workflow_service;
use crate::error::AppError;
use crate::shared::keyed_locks::KeyedLocks;

/// Public registry held by `AppState`. Cheap to clone (it's all an `Arc`).
pub struct GitWatcherRegistry {
    pub(super) inner: Arc<Mutex<RegistryInner>>,
    pending: Arc<PendingSubscriptions>,
}

impl GitWatcherRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                handles: std::collections::HashMap::new(),
                repo_locks: Arc::new(KeyedLocks::default()),
            })),
            pending: Arc::default(),
        }
    }

    /// [`Self::subscribe`] without holding up the caller: a WebSocket hands
    /// the result to `respond` while it goes on with its next commands. A
    /// later unsubscribe or disconnect of `sender` cancels it.
    pub fn subscribe_in_background<R>(
        &self,
        state: &AppState,
        feature_id: i64,
        sender: mpsc::UnboundedSender<Message>,
        respond: R,
    ) where
        R: FnOnce(Result<GitStatusSnapshot, AppError>) + Send + 'static,
    {
        let state = state.clone();
        let subscriber = sender.clone();
        self.pending.start(feature_id, sender, async move {
            respond(
                state
                    .git_watcher
                    .subscribe(&state, feature_id, subscriber)
                    .await,
            );
        });
    }

    /// Register a `(feature_id, sender)` subscription. Returns an initial
    /// snapshot the caller should send as the first envelope on this WS.
    /// Spawns the underlying fs watcher if this is the first subscriber for
    /// the resolved worktree path.
    ///
    /// Git runs under the repository's own lock, never under the registry's:
    /// a repository whose Git hangs (network filesystem, huge checkout) only
    /// delays its own subscribers.
    pub async fn subscribe(
        &self,
        state: &AppState,
        feature_id: i64,
        sender: mpsc::UnboundedSender<Message>,
    ) -> Result<GitStatusSnapshot, AppError> {
        let (worktree_path, target_branch) = resolve_paths(state, feature_id).await?;
        let repo_lock = repo_lock(&self.inner, &worktree_path).await;
        let _repo = repo_lock.lock().await;
        let mut snapshot =
            git_status::compute_status_or_empty(&worktree_path, feature_id, &target_branch).await?;
        workflow_service::enrich_snapshot(state, &mut snapshot, &worktree_path.to_string_lossy())
            .await;

        if !crate::shared::git_context::has_git_metadata(&worktree_path).await? {
            return Ok(snapshot);
        }
        if self.attach(&worktree_path, feature_id, &sender).await {
            return Ok(snapshot);
        }
        // The repository lock keeps a concurrent subscriber of this worktree
        // from starting a second watcher while this one is being built.
        let mut handle =
            spawn_handle(self.inner.clone(), worktree_path.clone(), state.clone()).await?;
        push_subscriber_dedup(&mut handle.subscribers, feature_id, sender);
        self.inner
            .lock()
            .await
            .handles
            .insert(worktree_path, handle);
        Ok(snapshot)
    }

    /// Add the subscriber to an existing watcher; false when there is none.
    async fn attach(
        &self,
        worktree_path: &std::path::Path,
        feature_id: i64,
        sender: &mpsc::UnboundedSender<Message>,
    ) -> bool {
        let mut inner = self.inner.lock().await;
        let Some(handle) = inner.handles.get_mut(worktree_path) else {
            return false;
        };
        push_subscriber_dedup(&mut handle.subscribers, feature_id, sender.clone());
        handle.cancel_grace();
        handle.epoch.fetch_add(1, Ordering::Relaxed);
        true
    }

    /// Drop every subscription for a given `feature_id`. Provided for
    /// completeness; the WS layer prefers `unsubscribe_one` so it doesn't
    /// kick other sessions watching the same feature.
    #[allow(dead_code)]
    pub async fn unsubscribe(&self, feature_id: i64) {
        self.pending.cancel(|pending, _| pending == feature_id);
        let mut inner = self.inner.lock().await;
        let mut empty_paths: Vec<PathBuf> = Vec::new();
        for (path, handle) in inner.handles.iter_mut() {
            handle.subscribers.retain(|s| s.feature_id != feature_id);
            if handle.subscribers.is_empty() {
                empty_paths.push(path.clone());
            }
            handle.epoch.fetch_add(1, Ordering::Relaxed);
        }
        for path in empty_paths {
            schedule_grace_drop(&mut inner, &path, self.inner.clone());
        }
    }

    /// Drop the subscription tied to one `(feature_id, sender)` pair.
    pub async fn unsubscribe_one(&self, feature_id: i64, sender: &mpsc::UnboundedSender<Message>) {
        self.pending
            .cancel(|pending, other| pending == feature_id && sender_eq(other, sender));
        let mut inner = self.inner.lock().await;
        let mut empty_paths: Vec<PathBuf> = Vec::new();
        for (path, handle) in inner.handles.iter_mut() {
            handle
                .subscribers
                .retain(|s| !(s.feature_id == feature_id && sender_eq(&s.sender, sender)));
            if handle.subscribers.is_empty() {
                empty_paths.push(path.clone());
            }
            handle.epoch.fetch_add(1, Ordering::Relaxed);
        }
        for path in empty_paths {
            schedule_grace_drop(&mut inner, &path, self.inner.clone());
        }
    }

    /// Drop every subscription tied to a specific (closed/about-to-close)
    /// WS sender. Called from the WS connection cleanup hook.
    pub async fn unsubscribe_sender(&self, sender: &mpsc::UnboundedSender<Message>) {
        self.pending.cancel(|_, other| sender_eq(other, sender));
        let mut inner = self.inner.lock().await;
        let mut empty_paths: Vec<PathBuf> = Vec::new();
        for (path, handle) in inner.handles.iter_mut() {
            handle.subscribers.retain(|s| !sender_eq(&s.sender, sender));
            if handle.subscribers.is_empty() {
                empty_paths.push(path.clone());
            }
            handle.epoch.fetch_add(1, Ordering::Relaxed);
        }
        for path in empty_paths {
            schedule_grace_drop(&mut inner, &path, self.inner.clone());
        }
    }

    #[cfg(test)]
    pub(super) async fn handle_count(&self) -> usize {
        self.inner.lock().await.handles.len()
    }

    #[cfg(test)]
    async fn subscriber_count(&self, path: &Path) -> usize {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let inner = self.inner.lock().await;
        inner
            .handles
            .get(&canonical)
            .map(|h| h.subscribers.len())
            .unwrap_or(0)
    }
}

impl Default for GitWatcherRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_init(dir: &Path) {
        Command::new("git")
            .arg("init")
            .arg("-q")
            .current_dir(dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir)
            .status()
            .unwrap();
    }

    #[tokio::test]
    async fn plain_folder_subscription_does_not_start_a_git_watcher() {
        let dir = tempfile::tempdir().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(":memory:")
            .await
            .unwrap();
        for sql in [
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT)",
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER, type TEXT, title TEXT)",
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT)",
            "INSERT INTO features VALUES (1, 1, 'ws-session', 'Plain project')",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO projects VALUES (1, ?)")
            .bind(dir.path().to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        let state = AppState::with_pool(pool);
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();
        let snapshot = state
            .git_watcher
            .subscribe(&state, 1, tx.clone())
            .await
            .unwrap();
        assert_eq!(snapshot.current_branch, "");
        assert_eq!(state.git_watcher.handle_count().await, 0);

        // Detection is not cached: initializing Git later enables the watcher
        // on the next subscription without recreating the project.
        git_init(dir.path());
        state.git_watcher.subscribe(&state, 1, tx).await.unwrap();
        assert_eq!(state.git_watcher.handle_count().await, 1);
        state.git_watcher.shutdown().await;
    }

    fn commit_all(dir: &Path) {
        for args in [
            ["add", "-A"].as_slice(),
            &["-c", "commit.gpgsign=false", "commit", "-qm", "init"],
        ] {
            assert!(Command::new("git")
                .args(args)
                .current_dir(dir)
                .status()
                .unwrap()
                .success());
        }
    }

    /// A repository with one commit.
    fn committed_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git_init(dir.path());
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        commit_all(dir.path());
        dir
    }

    /// A repository whose every Git command hangs for `hold`, like a checkout
    /// on a stalled network filesystem: its config includes a FIFO, and Git
    /// blocks reading it until the releaser thread closes its write end.
    struct StalledRepo {
        dir: tempfile::TempDir,
        _fifo_dir: tempfile::TempDir,
        fifo: PathBuf,
        stop: Arc<std::sync::atomic::AtomicBool>,
        releaser: Option<std::thread::JoinHandle<()>>,
    }

    impl StalledRepo {
        fn new(hold: std::time::Duration) -> Self {
            let dir = tempfile::tempdir().unwrap();
            git_init(dir.path());
            std::fs::write(dir.path().join("tracked.txt"), "tracked").unwrap();
            commit_all(dir.path());
            let fifo_dir = tempfile::tempdir().unwrap();
            let fifo = fifo_dir.path().join("config.fifo");
            let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
            let mut config = std::fs::OpenOptions::new()
                .append(true)
                .open(dir.path().join(".git/config"))
                .unwrap();
            std::io::Write::write_all(
                &mut config,
                format!("[include]\n\tpath = {}\n", fifo.display()).as_bytes(),
            )
            .unwrap();
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let releaser = std::thread::spawn({
                let (fifo, stop) = (fifo.clone(), stop.clone());
                move || {
                    while !stop.load(Ordering::Relaxed) {
                        release_readers(&fifo, hold);
                    }
                }
            });
            Self {
                dir,
                _fifo_dir: fifo_dir,
                fifo,
                stop,
                releaser: Some(releaser),
            }
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }
    }

    /// Hold the FIFO open for `hold` once a reader waits on it, then let every
    /// waiting reader see end-of-file.
    fn release_readers(fifo: &Path, hold: std::time::Duration) {
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(fifo)
        {
            Ok(writer) => {
                std::thread::sleep(hold);
                drop(writer);
            }
            // ENXIO: no reader yet.
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(5)),
        }
    }

    impl Drop for StalledRepo {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(releaser) = self.releaser.take() {
                releaser.join().unwrap();
            }
            // Release Git processes a dropped task left waiting on the FIFO.
            for _ in 0..20 {
                release_readers(&self.fifo, std::time::Duration::ZERO);
            }
        }
    }

    async fn state_with_projects(paths: &[&Path]) -> AppState {
        let pool = crate::domain::subagents::repository::test_support::migrated_pool().await;
        for path in paths {
            let project_id: i64 = sqlx::query_scalar(
                "INSERT INTO projects (name, path) VALUES ('p', ?) RETURNING id",
            )
            .bind(path.to_string_lossy().as_ref())
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO features (project_id, title) VALUES (?, 'f')")
                .bind(project_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        AppState::with_pool(pool)
    }

    /// Starting the watcher of a repository whose Git hangs must not hold the
    /// registry: every other worktree's refresh, subscription and WebSocket
    /// teardown waits on it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stalled_repository_does_not_block_the_registry() {
        let stalled = StalledRepo::new(std::time::Duration::from_millis(400));
        let fast = committed_repo();
        let state = state_with_projects(&[stalled.path(), fast.path()]).await;

        let (stalled_tx, _stalled_rx) = mpsc::unbounded_channel::<Message>();
        let slow = tokio::spawn({
            let state = state.clone();
            async move { state.git_watcher.subscribe(&state, 1, stalled_tx).await }
        });
        let (probe_tx, _probe_rx) = mpsc::unbounded_channel::<Message>();
        let mut worst = std::time::Duration::ZERO;
        let mut probes = 0;
        while !slow.is_finished() {
            let started = std::time::Instant::now();
            state.git_watcher.unsubscribe_sender(&probe_tx).await;
            let _ = state.git_watcher.snapshot_subscribers(2).await;
            worst = worst.max(started.elapsed());
            probes += 1;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        slow.await.unwrap().unwrap();
        assert!(probes > 10, "the stalled subscription should take a while");
        assert!(
            worst < std::time::Duration::from_millis(200),
            "registry blocked for {worst:?} behind a stalled repository"
        );

        // The other repository subscribes promptly meanwhile too.
        let (fast_tx, _fast_rx) = mpsc::unbounded_channel::<Message>();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            state.git_watcher.subscribe(&state, 2, fast_tx),
        )
        .await
        .expect("subscribing a healthy repository must not wait")
        .unwrap();
        state.git_watcher.shutdown().await;
    }

    /// A WebSocket subscribing to a hung repository goes on with its next
    /// subscription at once, and leaving cancels the hung one: no watcher or
    /// subscriber appears once its Git finally answers.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_background_subscription_never_holds_up_the_next_one() {
        let stalled = StalledRepo::new(std::time::Duration::from_millis(1500));
        let fast = committed_repo();
        let state = state_with_projects(&[stalled.path(), fast.path()]).await;
        let (socket, _socket_rx) = mpsc::unbounded_channel::<Message>();
        let (results_tx, mut results) = mpsc::unbounded_channel::<(i64, bool)>();

        for feature_id in [1, 2] {
            let results_tx = results_tx.clone();
            state.git_watcher.subscribe_in_background(
                &state,
                feature_id,
                socket.clone(),
                move |result| results_tx.send((feature_id, result.is_ok())).unwrap(),
            );
        }
        let first = tokio::time::timeout(std::time::Duration::from_secs(5), results.recv())
            .await
            .expect("the healthy repository answers while the hung one waits");
        assert_eq!(first, Some((2, true)));

        state.git_watcher.unsubscribe_one(1, &socket).await;
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        assert!(
            results.try_recv().is_err(),
            "the cancelled subscription answered"
        );
        let stalled_path = std::fs::canonicalize(stalled.path()).unwrap();
        assert_eq!(state.git_watcher.subscriber_count(&stalled_path).await, 0);
        assert_eq!(state.git_watcher.pending.len(), 0);
        state.git_watcher.shutdown().await;
    }

    #[tokio::test]
    async fn subscribe_unsubscribe_refcount_transitions() {
        let dir = tempfile::tempdir().unwrap();
        git_init(dir.path());

        let registry = GitWatcherRegistry::new();
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();
        let state = AppState::with_pool(pool);
        let handle = spawn_handle(registry.inner.clone(), canonical.clone(), state)
            .await
            .unwrap();
        {
            let mut inner = registry.inner.lock().await;
            inner.handles.insert(canonical.clone(), handle);
        }

        let (tx1, _rx1) = mpsc::unbounded_channel::<Message>();
        let (tx2, _rx2) = mpsc::unbounded_channel::<Message>();
        {
            let mut inner = registry.inner.lock().await;
            let h = inner.handles.get_mut(&canonical).unwrap();
            h.subscribers.push(Subscriber {
                feature_id: 1,
                sender: tx1,
            });
            h.subscribers.push(Subscriber {
                feature_id: 2,
                sender: tx2,
            });
        }
        assert_eq!(registry.subscriber_count(&canonical).await, 2);

        registry.unsubscribe(1).await;
        assert_eq!(registry.subscriber_count(&canonical).await, 1);

        registry.unsubscribe(2).await;
        assert_eq!(registry.handle_count().await, 1);
        registry.shutdown().await;
        assert_eq!(registry.handle_count().await, 0);
    }
}
