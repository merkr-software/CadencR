use crate::shared::discard::IgnoreClosed;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ignore::gitignore::Gitignore;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tracing::debug;

use crate::domain::editor::service::{
    build_gitignore, clear_gitignore_cache, is_gitignored_or_ancestor,
};
use crate::shared::ignore_watch::IgnoreAwareWatcher;
use crate::shared::watch_limits::describe_watch_error;

mod changed_documents;
mod subscriptions;
use changed_documents::ChangedDocuments;
pub use subscriptions::EditorWatchers;

/// Minimum gap between successive change emissions under sustained churn.
/// Mirrors the git watcher's `MIN_RECOMPUTE_GAP_MS` so an agent (or a build)
/// writing files can't drive a `file_tree.changed` flood — the raw debounced
/// events still fire, but at most one emission leaves per second.
const MIN_EMIT_GAP_MS: i64 = 1000;

/// Lightweight signal sent when watched files change.
#[derive(Clone, Debug)]
pub struct FileChangeEvent {
    pub project_path: String,
    /// Feature whose editor root is watched (`None` for a project root).
    pub feature_id: Option<i64>,
    /// Previewable documents (PDF / Office) written since the last event,
    /// relative to `project_path`, most recent last.
    pub documents: Vec<String>,
}

impl FileChangeEvent {
    /// The `editor/file_tree.changed` WS payload.
    pub fn payload(&self) -> serde_json::Value {
        serde_json::json!({
            "project_path": self.project_path,
            "feature_id": self.feature_id,
            "documents": self.documents,
        })
    }
}

/// One recursive file-system watcher over an editor root. Dropping it stops
/// the watch.
#[derive(Default)]
pub struct FileWatcher {
    watcher: Option<IgnoreAwareWatcher>,
    watched_path: Option<PathBuf>,
    /// Ping sender feeding the churn-cap emit task. Dropping it (via `stop`)
    /// closes the channel and lets the task exit.
    ping_tx: Option<mpsc::UnboundedSender<()>>,
    emit_task: Option<JoinHandle<()>>,
}

impl FileWatcher {
    /// Start watching `project_path` recursively. Events are sent to `tx`.
    /// Any previous watcher is stopped first.
    ///
    /// Two layers keep this from flooding the frontend on a churny monorepo:
    ///  - [`IgnoreAwareWatcher`] prunes gitignored directories (avoiding
    ///    inotify watch exhaustion on Linux and skipping read-only access
    ///    events) while a lightweight file-level gitignore check drops noisy
    ///    ignored files (like `*.log`) and `.git` internals;
    ///  - a churn-cap emit task collapses sustained bursts to ~1 emission/sec.
    pub fn start(
        &mut self,
        project_path: &str,
        feature_id: Option<i64>,
        tx: broadcast::Sender<FileChangeEvent>,
    ) -> Result<(), String> {
        self.stop();

        let canonical = std::fs::canonicalize(project_path)
            .map_err(|e| format!("Invalid project path: {e}"))?;
        let project_str = canonical.to_string_lossy().to_string();

        let (ping_tx, ping_rx) = mpsc::unbounded_channel::<()>();
        let documents = Arc::new(ChangedDocuments::new(canonical.clone()));
        let source = EventSource {
            project_path: project_str,
            feature_id,
            documents: documents.clone(),
        };
        let emit_task = spawn_emit_task(tx, source, ping_rx);

        let watcher = build_watcher(canonical.clone(), documents, ping_tx.clone())?;

        debug!(path = %canonical.display(), "file watcher started");
        self.watcher = Some(watcher);
        self.watched_path = Some(canonical);
        self.ping_tx = Some(ping_tx);
        self.emit_task = Some(emit_task);
        Ok(())
    }

    /// Stop the current watcher if any.
    pub fn stop(&mut self) {
        if let Some(path) = self.watched_path.take() {
            debug!(path = %path.display(), "file watcher stopped");
            clear_gitignore_cache(&path);
        }
        // Drop the watcher (sending Stop to its maintenance thread without
        // blocking) and our own ping sender so the emit task exits.
        self.watcher = None;
        self.ping_tx = None;
        if let Some(task) = self.emit_task.take() {
            task.abort();
        }
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(crate) fn watch_count(&self) -> usize {
        self.watcher
            .as_ref()
            .map_or(0, IgnoreAwareWatcher::watch_count)
    }
}

/// [`FileWatcher::start`] off the async runtime: starting walks the tree for
/// `.gitignore`s and registers the watch, which can take seconds on a large
/// repository.
pub async fn start_off_runtime(
    root: &Path,
    feature_id: Option<i64>,
    tx: broadcast::Sender<FileChangeEvent>,
) -> Result<FileWatcher, String> {
    let root = root.to_string_lossy().into_owned();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let _runtime = runtime.enter();
        let mut watcher = FileWatcher::default();
        watcher.start(&root, feature_id, tx).map(|()| watcher)
    })
    .await
    .map_err(|error| format!("file watcher start failed: {error}"))?
}

impl Drop for FileWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start an [`IgnoreAwareWatcher`] for the editor root. Directory pruning and
/// debouncing run on its dedicated maintenance thread; `on_change` filters
/// file-level gitignore noise (e.g. `*.log`), refreshes the matcher in place
/// when `.gitignore` changes, records previewable documents, and pings the
/// churn-cap emit task.
fn build_watcher(
    canonical: PathBuf,
    documents: Arc<ChangedDocuments>,
    ping_tx: mpsc::UnboundedSender<()>,
) -> Result<IgnoreAwareWatcher, String> {
    let project_root = canonical.clone();
    let mut gitignore = build_gitignore(&project_root);
    IgnoreAwareWatcher::start(
        canonical,
        Vec::new(),
        Duration::from_millis(500),
        move |paths| {
            if paths
                .iter()
                .any(|path| !is_git_path(path) && is_gitignore_file(path))
            {
                clear_gitignore_cache(&project_root);
                gitignore = build_gitignore(&project_root);
            }

            let mut has_relevant = false;
            for path in &paths {
                if is_noise(gitignore.as_ref(), path) {
                    continue;
                }
                has_relevant = true;
                documents.record(path);
            }
            if has_relevant {
                ping_tx.send(()).ignore_closed();
            }
        },
    )
    .map_err(|e| describe_watch_error("Failed to watch directory", &e))
}

/// What every emission of one watcher carries besides the change itself.
struct EventSource {
    project_path: String,
    feature_id: Option<i64>,
    documents: Arc<ChangedDocuments>,
}

/// The churn-cap emit task: mirrors the git watcher's `MIN_RECOMPUTE_GAP_MS`
/// pacing. The first change after a quiet period emits immediately; sustained
/// churn is paced to one emission per `MIN_EMIT_GAP_MS`, and the final change
/// after a burst still emits (so the tree never settles stale).
fn spawn_emit_task(
    tx: broadcast::Sender<FileChangeEvent>,
    source: EventSource,
    mut ping_rx: mpsc::UnboundedReceiver<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_emit_ms: i64 = 0;
        while ping_rx.recv().await.is_some() {
            let delay = emit_delay_ms(last_emit_ms, now_ms());
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay as u64)).await;
                // Coalesce every ping that piled up during the wait.
                while ping_rx.try_recv().is_ok() {}
            }
            last_emit_ms = now_ms();
            tx.send(FileChangeEvent {
                project_path: source.project_path.clone(),
                feature_id: source.feature_id,
                documents: source.documents.drain(),
            })
            .ignore_closed();
        }
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// How long to wait before the next emission, given when we last emitted and
/// the current time. `0` means emit now (leading edge or the gap has already
/// elapsed); otherwise it's the remaining slice of `MIN_EMIT_GAP_MS`.
fn emit_delay_ms(last_emit_ms: i64, now_ms: i64) -> i64 {
    (MIN_EMIT_GAP_MS - (now_ms - last_emit_ms)).max(0)
}

/// A change we should ignore: `.git` internals, or anything gitignored
/// (including files nested under an ignored directory like `node_modules/`).
fn is_noise(gitignore: Option<&Gitignore>, path: &Path) -> bool {
    is_git_path(path) || is_gitignored_or_ancestor(gitignore, path, false)
}

/// Check if a path is inside a `.git` directory.
fn is_git_path(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == ".git")
}

fn is_gitignore_file(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == ".gitignore")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn is_git_path_detects_git_dirs() {
        assert!(is_git_path(&PathBuf::from("/project/.git/HEAD")));
        assert!(is_git_path(&PathBuf::from("/project/.git/refs/heads/main")));
        assert!(is_git_path(&PathBuf::from(".git/config")));
    }

    #[test]
    fn is_git_path_allows_normal_paths() {
        assert!(!is_git_path(&PathBuf::from("/project/src/main.rs")));
        assert!(!is_git_path(&PathBuf::from("/project/.gitignore")));
        assert!(!is_git_path(&PathBuf::from(
            "/project/.github/workflows/ci.yml"
        )));
    }

    /// The `ignore` crate only applies `.gitignore` inside a git repo, so an
    /// empty `.git` dir is enough for the matcher to take effect.
    #[test]
    fn is_noise_filters_gitignored_paths_including_nested() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "node_modules/\ntarget/\ndist/\n").unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();

        let matcher = build_gitignore(root);
        let m = matcher.as_ref();

        // A file nested deep inside an ignored directory must be filtered.
        assert!(is_noise(m, &root.join("node_modules/pkg/index.js")));
        assert!(is_noise(m, &root.join("target/debug/build/foo")));
        assert!(is_noise(m, &root.join("dist/bundle.js")));
        // `.git` internals are always noise.
        assert!(is_noise(m, &root.join(".git/index")));
        // Real source changes are not noise.
        assert!(!is_noise(m, &root.join("src/main.rs")));
        assert!(!is_noise(m, &root.join("README.md")));
    }

    #[test]
    fn is_noise_filters_paths_from_nested_gitignore_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("packages/app/node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join("packages/app/src")).unwrap();
        std::fs::write(root.join("packages/app/.gitignore"), "node_modules/\n").unwrap();

        let matcher = build_gitignore(root);
        let m = matcher.as_ref();

        assert!(is_noise(
            m,
            &root.join("packages/app/node_modules/pkg/index.js")
        ));
        assert!(!is_noise(m, &root.join("packages/app/src/main.ts")));
    }

    #[test]
    fn is_noise_without_gitignore_only_filters_git() {
        // No matcher (project without a `.gitignore`): only `.git` is noise.
        assert!(is_noise(None, &PathBuf::from("/project/.git/index")));
        assert!(!is_noise(
            None,
            &PathBuf::from("/project/node_modules/x.js")
        ));
        assert!(!is_noise(None, &PathBuf::from("/project/src/main.rs")));
    }

    #[tokio::test]
    async fn watcher_starts_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        let mut watcher = FileWatcher::default();

        assert!(watcher
            .start(dir.path().to_str().unwrap(), None, tx)
            .is_ok());
        assert!(watcher.watched_path.is_some());

        watcher.stop();
        assert!(watcher.watched_path.is_none());
        assert!(watcher.watcher.is_none());
        assert!(watcher.ping_tx.is_none());
    }

    #[tokio::test]
    async fn reading_watched_files_and_dirs_triggers_no_event() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub fn hi() {}\n").unwrap();

        let (tx, mut rx) = broadcast::channel(16);
        let mut watcher = FileWatcher::default();
        watcher.start(root.to_str().unwrap(), None, tx).unwrap();

        // Let any initial FSEvents replay of fixture setup settle and drain it.
        tokio::time::sleep(Duration::from_millis(900)).await;
        while rx.try_recv().is_ok() {}

        for _ in 0..5 {
            std::fs::read(root.join("src/lib.rs")).unwrap();
            std::fs::read_dir(root.join("src")).unwrap().for_each(drop);
        }

        let event = tokio::time::timeout(Duration::from_millis(900), rx.recv()).await;
        assert!(
            event.is_err(),
            "reading watched files/dirs must never trigger a FileChangeEvent: {event:?}"
        );
        watcher.stop();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn watch_budget_skips_node_modules_and_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "node_modules/\ntarget/\n").unwrap();
        std::fs::create_dir_all(root.join("src/lib")).unwrap();
        for pkg in 0..50 {
            std::fs::create_dir_all(root.join(format!("node_modules/pkg{pkg}/dist"))).unwrap();
        }
        std::fs::create_dir_all(root.join("target/debug/build")).unwrap();

        let (tx, _rx) = broadcast::channel(16);
        let mut watcher = FileWatcher::default();
        watcher.start(root.to_str().unwrap(), None, tx).unwrap();

        // Only root, src, src/lib should be watched (3 directories), never node_modules/target/.git.
        assert_eq!(
            watcher.watch_count(),
            3,
            "expected only non-ignored directories to consume inotify watches"
        );
        watcher.stop();
    }

    #[tokio::test]
    async fn watcher_start_replaces_previous() {
        let dir1 = tempfile::tempdir().unwrap();
        let dir2 = tempfile::tempdir().unwrap();
        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        let mut watcher = FileWatcher::default();

        watcher
            .start(dir1.path().to_str().unwrap(), None, tx.clone())
            .unwrap();
        let first_path = watcher.watched_path.clone();

        watcher
            .start(dir2.path().to_str().unwrap(), Some(7), tx)
            .unwrap();
        assert_ne!(first_path, watcher.watched_path);

        watcher.stop();
    }

    /// The churn-cap pacing, tested deterministically without the wall clock:
    /// a fresh emit (or a fully-elapsed gap) waits 0ms; a change mid-gap waits
    /// the remaining slice so emissions can't leave faster than one per gap.
    #[test]
    fn emit_delay_enforces_min_gap() {
        // Leading edge: last_emit far in the past → emit immediately.
        assert_eq!(emit_delay_ms(0, 1_700_000_000_000), 0);
        // A change 200ms after the last emit waits the remaining 800ms.
        assert_eq!(emit_delay_ms(1_000, 1_200), MIN_EMIT_GAP_MS - 200);
        // A change once the full gap has elapsed emits immediately.
        assert_eq!(emit_delay_ms(1_000, 1_000 + MIN_EMIT_GAP_MS), 0);
        assert_eq!(emit_delay_ms(1_000, 5_000), 0);
    }

    /// The emit task delivers a change for the first ping. Uses a generous
    /// timeout (not a fixed sleep) so it stays robust under parallel test load.
    #[tokio::test]
    async fn emit_task_delivers_leading_change() {
        let (tx, mut rx) = broadcast::channel::<FileChangeEvent>(64);
        let (ping_tx, ping_rx) = mpsc::unbounded_channel::<()>();
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("report.pdf"), b"%PDF").unwrap();
        let documents = Arc::new(ChangedDocuments::new(tmp.path().to_path_buf()));
        documents.record(&tmp.path().join("report.pdf"));
        let source = EventSource {
            project_path: "/proj".to_string(),
            feature_id: Some(3),
            documents,
        };
        let task = spawn_emit_task(tx, source, ping_rx);

        ping_tx.send(()).unwrap();
        let received = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("leading change should be emitted")
            .expect("channel open");
        assert_eq!(received.project_path, "/proj");
        assert_eq!(received.feature_id, Some(3));
        assert_eq!(received.documents, vec!["report.pdf"]);

        drop(ping_tx);
        let _ = task.await;
    }
}
