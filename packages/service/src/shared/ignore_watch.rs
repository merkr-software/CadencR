//! Watch a Git worktree without watching what Git ignores.
//!
//! inotify (Linux) spends one watch per directory of a recursive tree, so a
//! worktree with `node_modules/` or `target/` exhausts
//! `fs.inotify.max_user_watches` and floods the watcher with events Git never
//! reports. FSEvents (macOS) covers a tree with one stream but still delivers
//! those events. The backend picks the [`Strategy`], the only platform branch:
//!
//! - per-directory backends watch each non-ignored directory on its own,
//!   adding directories as they appear and dropping those a `.gitignore`
//!   change hides;
//! - tree backends keep one recursive watch and drop events from ignored paths.
//!
//! Git dirs are not ignore-filtered: their `HEAD`, `index` and refs drive Git
//! status refreshes. Per-directory backends watch each Git dir itself and its
//! `refs/` tree, never `objects/` or `logs/`.
//!
//! Only directories are pruned: a file in a watched directory always counts,
//! since a tracked file may match an ignore pattern. A tracked file under an
//! ignored directory (added with `git add -f`) is not watched; its edits show
//! up on the next refresh another change triggers. Read-only accesses never
//! count, and a lost event queue rescans and refreshes everything.

mod tree;
mod walk;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify_debouncer_mini::notify::event::{AccessKind, AccessMode};
use notify_debouncer_mini::notify::{
    self, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher, WatcherKind,
};
use tracing::{debug, warn};

pub(crate) use tree::Strategy;
use tree::WatchTree;

use crate::shared::watch_limits::{describe_watch_error, is_watch_limit_error};

/// The strategy the platform's recommended backend needs.
pub(crate) fn strategy_for(kind: WatcherKind) -> Strategy {
    match kind {
        WatcherKind::Inotify | WatcherKind::Kqueue => Strategy::PerDirectory,
        _ => Strategy::Tree,
    }
}

/// Whether `kind` can change what Git sees. inotify also reports every open
/// and read-only close, and `git status` opens `.git/index` and every
/// directory it scans: forwarding those would make each refresh trigger the
/// next. A close after writing still counts.
fn changes_content(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

enum Message {
    Paths(Vec<PathBuf>),
    /// The backend dropped events (inotify queue overflow).
    Rescan,
    Stop,
}

/// One debounced window of changes.
#[derive(Default)]
struct Batch {
    paths: HashSet<PathBuf>,
    rescan: bool,
}

/// A running gitignore-aware watch. Dropping it stops the watch.
pub struct IgnoreAwareWatcher {
    messages: mpsc::Sender<Message>,
    watch_count: Arc<AtomicUsize>,
}

impl IgnoreAwareWatcher {
    /// Watch `worktree` and `git_dirs`, calling `on_change` from a dedicated
    /// thread with each debounced batch of paths Git does not ignore.
    ///
    /// Blocking: walks the non-ignored tree once. Fails when the worktree
    /// itself cannot be watched or the system watch limit is reached.
    pub fn start<F>(
        worktree: PathBuf,
        git_dirs: Vec<PathBuf>,
        debounce: Duration,
        on_change: F,
    ) -> Result<Self, notify::Error>
    where
        F: FnMut(Vec<PathBuf>) + Send + 'static,
    {
        let strategy = strategy_for(RecommendedWatcher::kind());
        Self::start_with(strategy, worktree, git_dirs, debounce, on_change)
    }

    pub(crate) fn start_with<F>(
        strategy: Strategy,
        worktree: PathBuf,
        git_dirs: Vec<PathBuf>,
        debounce: Duration,
        mut on_change: F,
    ) -> Result<Self, notify::Error>
    where
        F: FnMut(Vec<PathBuf>) + Send + 'static,
    {
        let tree = WatchTree::scan(worktree, git_dirs, strategy);
        let (messages, inbox) = mpsc::channel();
        let mut watcher = RecommendedWatcher::new(
            {
                let messages = messages.clone();
                let label = tree.worktree().display().to_string();
                move |result: notify::Result<Event>| match result {
                    Ok(event) if event.need_rescan() => {
                        warn!(dir = %label, "file watcher lost events; rescanning");
                        // Fails only once the watch is stopping.
                        let _ = messages.send(Message::Rescan);
                    }
                    Ok(event) if changes_content(&event.kind) => {
                        // Fails only once the watch is stopping.
                        let _ = messages.send(Message::Paths(event.paths));
                    }
                    Ok(_) => {}
                    Err(error) => warn!(dir = %label, "file watcher error: {error:?}"),
                }
            },
            notify::Config::default(),
        )?;
        start_watches(&mut watcher, &tree)?;
        let watch_count = Arc::new(AtomicUsize::new(tree.watch_count()));
        std::thread::Builder::new()
            .name("ignore-aware-watch".into())
            .spawn({
                let watch_count = watch_count.clone();
                move || {
                    let mut maintenance = Maintenance {
                        watcher,
                        tree,
                        watch_count,
                    };
                    while let Some(batch) = next_batch(&inbox, debounce) {
                        maintenance.absorb(batch, &mut on_change);
                    }
                }
            })
            .map_err(notify::Error::io)?;
        Ok(Self {
            messages,
            watch_count,
        })
    }

    /// How many OS watches this watch holds: one per directory with inotify.
    pub fn watch_count(&self) -> usize {
        self.watch_count.load(Ordering::Relaxed)
    }
}

impl Drop for IgnoreAwareWatcher {
    fn drop(&mut self) {
        // Fails only when the maintenance thread already exited.
        let _ = self.messages.send(Message::Stop);
    }
}

/// Start the initial watches. Only the worktree root and a watch-limit error
/// are fatal: a Git dir or subdirectory that cannot be watched costs live
/// refresh for its paths alone.
fn start_watches(watcher: &mut RecommendedWatcher, tree: &WatchTree) -> Result<(), notify::Error> {
    for (path, mode) in tree.initial_watches() {
        let Err(error) = watcher.watch(&path, mode) else {
            continue;
        };
        if path == tree.worktree() || is_watch_limit_error(&error.kind) {
            return Err(error);
        }
        warn!(path = %path.display(), %error, "file watcher: continuing without this directory");
    }
    Ok(())
}

/// The changes within `debounce` of the first one, once it elapsed; `None`
/// once the watch stops. Sustained churn yields one batch per window.
fn next_batch(inbox: &mpsc::Receiver<Message>, debounce: Duration) -> Option<Batch> {
    let mut batch = Batch::default();
    let mut deadline: Option<Instant> = None;
    loop {
        let message = match deadline {
            None => inbox.recv().ok()?,
            Some(deadline) => {
                match inbox.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(message) => message,
                    Err(mpsc::RecvTimeoutError::Timeout) => return Some(batch),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return None,
                }
            }
        };
        match message {
            Message::Paths(paths) => batch.paths.extend(paths),
            Message::Rescan => batch.rescan = true,
            Message::Stop => return None,
        }
        deadline.get_or_insert_with(|| Instant::now() + debounce);
    }
}

/// The watch's state, owned by its maintenance thread.
struct Maintenance {
    watcher: RecommendedWatcher,
    tree: WatchTree,
    watch_count: Arc<AtomicUsize>,
}

impl Maintenance {
    fn absorb(&mut self, batch: Batch, on_change: &mut impl FnMut(Vec<PathBuf>)) {
        let mut absorbed = if batch.rescan {
            self.tree.rescan_all()
        } else {
            let paths: Vec<PathBuf> = batch.paths.into_iter().collect();
            self.tree.absorb(&paths)
        };
        let mut relevant = std::mem::take(&mut absorbed.relevant);
        // A directory created under a new one between its walk and its watch
        // reported nothing: look again once the watches are in place.
        while !absorbed.watch.is_empty() || !absorbed.unwatch.is_empty() {
            let watched = self.apply(&absorbed);
            let missed = self.tree.missed_subdirectories(&watched);
            if missed.is_empty() {
                break;
            }
            absorbed = self.tree.absorb(&missed);
            relevant.append(&mut absorbed.relevant);
        }
        self.watch_count
            .store(self.tree.watch_count(), Ordering::Relaxed);
        if !relevant.is_empty() {
            on_change(relevant);
        }
    }

    /// Apply watch changes; the directories now watched. One that cannot be
    /// watched (the system limit) is forgotten, so a later event or rescan
    /// retries it, and its parent's refresh still covers what it held.
    fn apply(&mut self, absorbed: &tree::Absorbed) -> Vec<PathBuf> {
        for dir in &absorbed.unwatch {
            // inotify already released the watch of a deleted directory.
            if let Err(error) = self.watcher.unwatch(dir) {
                debug!(path = %dir.display(), %error, "file watcher: unwatch skipped");
            }
        }
        let (mut watched, mut failed) = (Vec::new(), Vec::new());
        for dir in &absorbed.watch {
            match self.watcher.watch(dir, RecursiveMode::NonRecursive) {
                Ok(()) => watched.push(dir.clone()),
                Err(error) => {
                    warn!(
                        path = %dir.display(),
                        "{}",
                        describe_watch_error("file watcher: directory not watched", &error)
                    );
                    failed.push(dir.clone());
                }
            }
        }
        self.tree.unwatched(&failed);
        watched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        (dir, root)
    }

    /// This process's inotify watches, as the kernel counts them.
    #[cfg(target_os = "linux")]
    fn inotify_watches() -> usize {
        std::fs::read_dir("/proc/self/fdinfo")
            .unwrap()
            .filter_map(|entry| std::fs::read_to_string(entry.ok()?.path()).ok())
            .map(|info| {
                info.lines()
                    .filter(|line| line.starts_with("inotify wd:"))
                    .count()
            })
            .sum()
    }

    /// Measures what a recursive inotify watch costs on a worktree with a
    /// large `node_modules/`, against the gitignore-aware one. Counts are
    /// process-wide, so run it alone:
    /// `cargo test -p cadencr-service --lib inotify_watch_budget -- --ignored --nocapture`
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "counts process-wide inotify watches; run alone"]
    fn inotify_watch_budget() {
        let (_dir, root) = repo();
        for package in 0..2_000 {
            std::fs::create_dir_all(root.join(format!("node_modules/p{package}/lib"))).unwrap();
        }
        for module in 0..20 {
            std::fs::create_dir_all(root.join(format!("src/m{module}"))).unwrap();
        }
        let wait_for = |expected: usize| {
            for _ in 0..100 {
                if inotify_watches() == expected {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            panic!("inotify watches never settled at {expected}");
        };
        let baseline = inotify_watches();
        // What the git watcher did before: one recursive watch.
        let mut plain =
            RecommendedWatcher::new(|_: notify::Result<Event>| {}, notify::Config::default())
                .unwrap();
        plain.watch(&root, RecursiveMode::Recursive).unwrap();
        let recursive = inotify_watches() - baseline;
        drop(plain);
        wait_for(baseline);
        let watcher = IgnoreAwareWatcher::start(
            root.clone(),
            vec![root.join(".git")],
            Duration::from_millis(50),
            |_| {},
        )
        .unwrap();
        let pruned = inotify_watches() - baseline;
        println!("inotify watches: recursive {recursive}, gitignore-aware {pruned}");
        assert_eq!(pruned, watcher.watch_count());
        assert!(recursive > 4_000 && pruned < 40, "{recursive} → {pruned}");
    }

    #[test]
    fn reads_are_not_changes() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind};
        assert!(!changes_content(&EventKind::Access(AccessKind::Open(
            AccessMode::Any
        ))));
        assert!(!changes_content(&EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(changes_content(&EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        assert!(changes_content(&EventKind::Create(CreateKind::File)));
        assert!(changes_content(&EventKind::Modify(ModifyKind::Any)));
        assert!(changes_content(&EventKind::Remove(RemoveKind::Any)));
        assert!(changes_content(&EventKind::Any));
    }

    /// inotify reports opens: before they were filtered, reading a watched
    /// file (as every `git status` reads `.git/index`) refreshed again,
    /// forever. FSEvents reports no reads, so this only bites on Linux.
    #[test]
    fn reading_watched_files_reaches_no_callback() {
        let (_dir, root) = repo();
        std::fs::write(root.join("src/lib.rs"), "x").unwrap();
        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        let _watcher = IgnoreAwareWatcher::start(
            root.clone(),
            vec![root.join(".git")],
            Duration::from_millis(50),
            move |paths| tx.send(paths).unwrap(),
        )
        .unwrap();
        // FSEvents replays the fixture's setup writes; let them pass.
        std::thread::sleep(Duration::from_millis(500));
        while rx.try_recv().is_ok() {}
        for _ in 0..5 {
            std::fs::read(root.join("src/lib.rs")).unwrap();
            std::fs::read_dir(root.join("src")).unwrap().for_each(drop);
            std::fs::read(root.join(".git/HEAD")).unwrap();
        }
        let batch = rx.recv_timeout(Duration::from_millis(800));
        assert!(batch.is_err(), "reads reached the callback: {batch:?}");
    }

    #[test]
    fn the_platform_backend_picks_its_strategy() {
        assert_eq!(strategy_for(WatcherKind::Inotify), Strategy::PerDirectory);
        assert_eq!(strategy_for(WatcherKind::Kqueue), Strategy::PerDirectory);
        assert_eq!(strategy_for(WatcherKind::Fsevent), Strategy::Tree);
        #[cfg(target_os = "linux")]
        assert_eq!(
            strategy_for(RecommendedWatcher::kind()),
            Strategy::PerDirectory
        );
        #[cfg(target_os = "macos")]
        assert_eq!(strategy_for(RecommendedWatcher::kind()), Strategy::Tree);
    }

    /// End to end on the real backend, with each strategy: an ignored change
    /// never reaches the callback, a source change does, and a directory
    /// created after start is watched.
    #[test]
    fn only_changes_git_sees_reach_the_callback() {
        for strategy in [Strategy::PerDirectory, Strategy::Tree] {
            let (_dir, root) = repo();
            let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
            let watcher = IgnoreAwareWatcher::start_with(
                strategy,
                root.clone(),
                vec![root.join(".git")],
                Duration::from_millis(50),
                move |paths| tx.send(paths).unwrap(),
            )
            .unwrap();
            // FSEvents also replays the fixture's own setup writes: let them
            // arrive before the writes under test.
            std::thread::sleep(Duration::from_millis(500));
            while rx.try_recv().is_ok() {}
            let ignored = root.join("node_modules/pkg/index.js");
            std::fs::write(&ignored, "x").unwrap();
            let leaked: Vec<Vec<PathBuf>> =
                std::iter::from_fn(|| rx.recv_timeout(Duration::from_millis(800)).ok())
                    .filter(|batch| {
                        batch
                            .iter()
                            .any(|path| path.starts_with(root.join("node_modules")))
                    })
                    .collect();
            assert!(
                leaked.is_empty(),
                "{strategy:?}: an ignored change reached the callback: {leaked:?}"
            );
            std::fs::create_dir_all(root.join("src/new")).unwrap();
            let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(
                batch.contains(&root.join("src/new")),
                "{strategy:?}: {batch:?}"
            );
            std::thread::sleep(Duration::from_millis(200));
            std::fs::write(root.join("src/new/a.rs"), "x").unwrap();
            let file = root.join("src/new/a.rs");
            let seen = std::iter::from_fn(|| rx.recv_timeout(Duration::from_secs(5)).ok())
                .any(|batch| batch.contains(&file));
            assert!(seen, "{strategy:?}: a file in a new directory was missed");
            drop(watcher);
        }
    }
}
