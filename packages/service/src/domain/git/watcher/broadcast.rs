use std::path::Path;
use std::sync::atomic::Ordering;

use axum::extract::ws::Message;
use tokio::sync::mpsc;

use super::debouncer::{self, now_ms};
use super::handle::RecomputePing;
use super::registry::GitWatcherRegistry;
use super::subscription::broadcast_envelope;
use crate::app_state::AppState;

impl GitWatcherRegistry {
    /// Send an arbitrary envelope to every WS subscriber registered for
    /// `feature_id`, regardless of which worktree they're attached to.
    #[allow(dead_code)]
    pub async fn broadcast_to_feature(
        &self,
        feature_id: i64,
        envelope: &crate::domain::ws_session::protocol::WsEnvelope,
    ) {
        let senders = self.snapshot_subscribers(feature_id).await;
        broadcast_envelope(&senders, envelope);
    }

    /// Clone every WS sender currently subscribed for `feature_id`. Used by
    /// long-running streaming endpoints (commit) that want to broadcast many
    /// chunks without re-acquiring the registry lock per chunk.
    pub async fn snapshot_subscribers(
        &self,
        feature_id: i64,
    ) -> Vec<mpsc::UnboundedSender<Message>> {
        let inner = self.inner.lock().await;
        inner
            .handles
            .values()
            .flat_map(|h| h.subscribers.iter())
            .filter(|s| s.feature_id == feature_id)
            .map(|s| s.sender.clone())
            .collect()
    }

    /// Send `envelope` synchronously to every cloned WS sender in `senders`.
    /// This is the lock-free path used by streaming chunk emissions.
    pub fn broadcast_to_senders(
        senders: &[mpsc::UnboundedSender<Message>],
        envelope: &crate::domain::ws_session::protocol::WsEnvelope,
    ) {
        broadcast_envelope(senders, envelope);
    }

    /// Synchronously run `compute_status` for every feature subscribed to
    /// `worktree_path` and broadcast the resulting `git.status` envelopes.
    #[cfg(test)]
    async fn recompute_now(&self, worktree_path: &Path, state: &AppState) {
        let canonical =
            std::fs::canonicalize(worktree_path).unwrap_or_else(|_| worktree_path.to_path_buf());
        debouncer::recompute_for_path(&self.inner, &canonical, state, None).await;
    }

    /// Stamp the self-write dedupe window and supersede queued fs work without
    /// scheduling a recompute.
    async fn nudge(&self, canonical: &Path) {
        let inner = self.inner.lock().await;
        if let Some(handle) = inner.handles.get(canonical) {
            handle.last_nudge_ms.store(now_ms(), Ordering::Relaxed);
            handle.write_generation.fetch_add(1, Ordering::AcqRel);
        }
    }

    /// Suppress self-induced fs events and synchronously confirm one fresh
    /// status (or status-error) snapshot for a user-initiated write.
    pub async fn confirm_after_write(&self, worktree_path: &Path, state: &AppState) {
        let canonical =
            std::fs::canonicalize(worktree_path).unwrap_or_else(|_| worktree_path.to_path_buf());
        self.nudge(&canonical).await;
        debouncer::recompute_for_path(&self.inner, &canonical, state, None).await;
    }

    /// Drop every handle and abort their compute tasks.
    #[allow(dead_code)]
    pub async fn shutdown(&self) {
        let mut inner = self.inner.lock().await;
        let drained: Vec<_> = inner.handles.drain().collect();
        drop(inner);
        for (_, mut handle) in drained {
            let _ = handle.ping_tx.send(RecomputePing::Shutdown);
            handle.cancel_grace();
            handle.compute_task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;

    use super::super::handle::{spawn_handle, RecomputePing, Subscriber};

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

    struct WatchFixture {
        _dir: tempfile::TempDir,
        registry: GitWatcherRegistry,
        state: AppState,
        canonical: PathBuf,
        rx: mpsc::UnboundedReceiver<Message>,
        fs_event_tx: mpsc::UnboundedSender<RecomputePing>,
        last_nudge: Arc<std::sync::atomic::AtomicI64>,
        write_generation: Arc<std::sync::atomic::AtomicU64>,
    }

    async fn subscribed_fixture() -> WatchFixture {
        let dir = tempfile::tempdir().unwrap();
        git_init(dir.path());
        let commit_status = Command::new("git")
            .args([
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "init",
                "-q",
            ])
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(commit_status.success(), "fixture commit should succeed");
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();
        let state = AppState::with_pool(pool);
        let registry = GitWatcherRegistry::new();
        let mut handle =
            spawn_handle(registry.inner.clone(), canonical.clone(), state.clone()).unwrap();
        let fs_event_tx = handle.ping_tx.clone();
        let last_nudge = handle.last_nudge_ms.clone();
        let write_generation = handle.write_generation.clone();
        let (tx, rx) = mpsc::unbounded_channel::<Message>();
        handle.subscribers.push(Subscriber {
            feature_id: 42,
            sender: tx,
        });
        registry
            .inner
            .lock()
            .await
            .handles
            .insert(canonical.clone(), handle);
        WatchFixture {
            _dir: dir,
            registry,
            state,
            canonical,
            rx,
            fs_event_tx,
            last_nudge,
            write_generation,
        }
    }

    #[tokio::test]
    async fn nudge_only_sets_the_dedupe_window() {
        let fixture = subscribed_fixture().await;
        fixture.registry.nudge(&fixture.canonical).await;
        let stamped = fixture.last_nudge.load(Ordering::Relaxed);
        assert!(stamped > 0, "nudge should stamp last_nudge_ms");
        assert!(now_ms() - stamped < debouncer::NUDGE_DEDUPE_MS);
        assert_eq!(fixture.write_generation.load(Ordering::Relaxed), 1);

        fixture.registry.shutdown().await;
    }

    #[tokio::test]
    async fn confirm_after_write_supersedes_queued_fs_event_and_later_events_refresh() {
        let mut fixture = subscribed_fixture().await;
        let original_generation = fixture.write_generation.load(Ordering::Relaxed);
        fixture
            .fs_event_tx
            .send(RecomputePing::FsEvent(original_generation))
            .unwrap();
        fixture
            .registry
            .confirm_after_write(&fixture.canonical, &fixture.state)
            .await;
        let confirmation = fixture
            .rx
            .try_recv()
            .expect("confirmation must broadcast synchronously");
        assert!(
            matches!(confirmation, Message::Text(text) if text.contains("\"action\":\"status\""))
        );

        tokio::task::yield_now().await;
        assert!(matches!(
            fixture.rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        let dedupe_wait = std::time::Duration::from_millis(
            u64::try_from(debouncer::NUDGE_DEDUPE_MS).unwrap() + 50,
        );
        tokio::time::sleep(dedupe_wait).await;
        let current_generation = fixture.write_generation.load(Ordering::Relaxed);
        fixture
            .fs_event_tx
            .send(RecomputePing::FsEvent(current_generation))
            .unwrap();
        let message = tokio::time::timeout(std::time::Duration::from_secs(3), fixture.rx.recv())
            .await
            .expect("later fs-event ping should trigger a recompute")
            .expect("subscriber should remain connected");
        assert!(matches!(message, Message::Text(text) if text.contains("\"action\":\"status\"")));
        fixture.registry.shutdown().await;
    }

    #[tokio::test]
    async fn recompute_now_broadcasts_synchronously() {
        let mut fixture = subscribed_fixture().await;
        fixture
            .registry
            .recompute_now(&fixture.canonical, &fixture.state)
            .await;
        let msg = fixture
            .rx
            .try_recv()
            .expect("recompute_now must broadcast synchronously");
        let Message::Text(text) = msg else {
            panic!("expected text envelope, got {msg:?}");
        };
        assert!(text.contains("\"action\":\"status\""), "got: {text}");

        fixture.registry.shutdown().await;
    }

    #[tokio::test]
    async fn recompute_is_suppressed_during_a_foreground_mutation() {
        let mut fixture = subscribed_fixture().await;
        let permit = fixture
            .state
            .git_mutations
            .try_acquire(&fixture.canonical)
            .unwrap();

        fixture
            .registry
            .recompute_now(&fixture.canonical, &fixture.state)
            .await;
        assert!(matches!(
            fixture.rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        drop(permit);
        fixture
            .registry
            .confirm_after_write(&fixture.canonical, &fixture.state)
            .await;
        assert!(matches!(
            fixture.rx.try_recv(),
            Ok(Message::Text(text)) if text.contains("\"action\":\"status\"")
        ));
        fixture.registry.shutdown().await;
    }

    #[tokio::test]
    async fn recompute_now_surfaces_refresh_failures_as_status_errors() {
        let mut fixture = subscribed_fixture().await;
        std::fs::remove_dir_all(fixture.canonical.join(".git")).unwrap();
        fixture
            .registry
            .recompute_now(&fixture.canonical, &fixture.state)
            .await;

        let messages = std::iter::from_fn(|| fixture.rx.try_recv().ok()).collect::<Vec<_>>();
        assert!(messages.iter().any(|message| {
            matches!(message, Message::Text(text) if text.contains("\"action\":\"status_error\""))
        }));
        fixture.registry.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_drops_all_handles() {
        let dir = tempfile::tempdir().unwrap();
        git_init(dir.path());
        let canonical = std::fs::canonicalize(dir.path()).unwrap();

        let registry = GitWatcherRegistry::new();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();
        let state = AppState::with_pool(pool);
        let handle = spawn_handle(registry.inner.clone(), canonical.clone(), state).unwrap();
        {
            let mut inner = registry.inner.lock().await;
            inner.handles.insert(canonical, handle);
        }
        assert_eq!(registry.handle_count().await, 1);
        registry.shutdown().await;
        assert_eq!(registry.handle_count().await, 0);
    }
}
