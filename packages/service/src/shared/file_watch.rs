//! Debounced directory watching, shared by the settings and theme stores and
//! the custom tabs folder.
//!
//! Both exist for the same reason: the app owns a directory of JSON documents
//! the user is invited to edit in their own editor, and an external save has to
//! reach connected clients live. The only per-caller differences are the
//! debounce window, whether the walk is recursive, and which paths count — so
//! those are the parameters and everything else lives here.
//!
//! Uses `notify::RecommendedWatcher` directly (instead of `notify-debouncer-mini`)
//! so read-only access events (`EventKind::Access`, notably `IN_OPEN` and
//! `IN_CLOSE_NOWRITE`/`IN_CLOSE_WRITE` on Linux inotify) are dropped before
//! debouncing and can never trigger self-amplifying reload loops.
//!
//! Best-effort by design: a watcher that fails to start costs live refresh, not
//! the documents themselves, so failures are logged and never fatal.
//!
//! Lost events are not silent, though. An event queue overflow (inotify
//! `IN_Q_OVERFLOW`, FSEvents dropped events: a pathless `Rescan` event), a
//! watcher error, or the watched directory itself being removed or renamed all
//! mean some changes will never be reported. They reach the caller as one
//! "reset" per debounce window, so a cache can drop everything it holds.

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use notify_debouncer_mini::notify::event::ModifyKind;
use notify_debouncer_mini::notify::{
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Result as NotifyResult, Watcher,
};
use tokio::sync::broadcast;
use tracing::{debug, warn};

use crate::shared::discard::IgnoreClosed;

/// Keeps every started process-lifetime watcher alive. Dropping a handle stops
/// its OS watcher and exits its debounce thread.
static WATCHERS: Mutex<Vec<WatchHandle>> = Mutex::new(Vec::new());

/// Owns a live OS watcher. Dropping it unregisters the watch and causes its
/// debounce thread to exit cleanly.
pub struct WatchHandle {
    _watcher: RecommendedWatcher,
}

/// Watch `dir`, mapping each changed path to an event via `to_event` and
/// broadcasting the ones that map to `Some`.
pub fn watch_dir<T, F>(
    dir: &Path,
    mode: RecursiveMode,
    debounce: Duration,
    tx: broadcast::Sender<T>,
    to_event: F,
) where
    T: Clone + Send + 'static,
    F: Fn(&Path) -> Option<T> + Send + 'static,
{
    let on_reset = Vec::new;
    if let Some(handle) = start(dir, mode, debounce, tx, path_events(to_event), on_reset) {
        keep_for_process(handle);
    }
}

/// A poisoned registry only means another thread panicked while pushing; the
/// list itself is intact, and dropping the handle would stop the watcher.
fn keep_for_process(handle: WatchHandle) {
    WATCHERS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(handle);
}

fn path_events<T, F>(to_event: F) -> impl Fn(&mut dyn Iterator<Item = &Path>) -> Vec<T>
where
    F: Fn(&Path) -> Option<T>,
{
    move |paths| paths.filter_map(&to_event).collect()
}

/// [`watch_dir`], returning an owned [`WatchHandle`] so callers can track
/// whether watching started and cleanly stop it on drop. `on_reset` runs when
/// changes may have been lost (see the module docs) and returns the events to
/// broadcast for it.
pub fn watch_dir_managed<T, F, R>(
    dir: &Path,
    mode: RecursiveMode,
    debounce: Duration,
    tx: broadcast::Sender<T>,
    to_event: F,
    on_reset: R,
) -> Option<WatchHandle>
where
    T: Clone + Send + 'static,
    F: Fn(&Path) -> Option<T> + Send + 'static,
    R: Fn() -> Vec<T> + Send + 'static,
{
    start(dir, mode, debounce, tx, path_events(to_event), on_reset)
}

/// [`watch_dir`], broadcasting each distinct event once per debounced batch:
/// one save that touches many files (a rebuild) is one event, however far
/// apart the batches arrive.
pub fn watch_dir_coalesced<T, F>(
    dir: &Path,
    mode: RecursiveMode,
    debounce: Duration,
    tx: broadcast::Sender<T>,
    to_event: F,
) where
    T: Clone + PartialEq + Send + 'static,
    F: Fn(&Path) -> Option<T> + Send + 'static,
{
    let to_events = move |paths: &mut dyn Iterator<Item = &Path>| {
        let mut events: Vec<T> = Vec::new();
        for event in paths.filter_map(&to_event) {
            if !events.contains(&event) {
                events.push(event);
            }
        }
        events
    };
    if let Some(handle) = start(dir, mode, debounce, tx, to_events, Vec::new) {
        keep_for_process(handle);
    }
}

/// Ignore pure access events (`Open`, `Close`, `Read`) so reading a watched
/// file never looks like a modification on Linux inotify.
fn is_change_event(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

/// What one raw notify callback means for the debounce loop.
#[derive(Debug, PartialEq)]
enum Signal {
    Paths(Vec<PathBuf>),
    /// Changes may have been lost: the caller must forget what it cached.
    Reset,
}

/// `roots` is the watched directory as given, then its canonical form when
/// that differs: FSEvents reports canonical paths (`/private/var/…`).
fn classify(result: NotifyResult<Event>, roots: &[PathBuf]) -> Option<Signal> {
    let root = roots.first().map_or(Path::new(""), PathBuf::as_path);
    let event = match result {
        Ok(event) => event,
        Err(error) => {
            warn!(dir = %root.display(), "watcher error, resetting: {error:?}");
            return Some(Signal::Reset);
        }
    };
    if event.need_rescan() {
        warn!(dir = %root.display(), info = ?event.info(), "watcher dropped events, resetting");
        return Some(Signal::Reset);
    }
    if !is_change_event(&event.kind) || event.paths.is_empty() {
        return None;
    }
    let root_gone = matches!(
        event.kind,
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    ) && event.paths.iter().any(|path| roots.contains(path));
    if root_gone {
        // The OS watch died with the directory (inotify drops it on
        // DELETE_SELF/MOVE_SELF): nothing inside it is reported any more.
        warn!(dir = %root.display(), "watched directory was removed or renamed, resetting");
        return Some(Signal::Reset);
    }
    Some(Signal::Paths(event.paths))
}

fn watched_roots(dir: &Path) -> Vec<PathBuf> {
    let mut roots = vec![dir.to_path_buf()];
    // A directory that cannot be resolved cannot be watched either: `watch`
    // reports that error right after.
    if let Ok(canonical) = std::fs::canonicalize(dir) {
        if canonical != dir {
            roots.push(canonical);
        }
    }
    roots
}

fn start<T, B, R>(
    dir: &Path,
    mode: RecursiveMode,
    debounce: Duration,
    tx: broadcast::Sender<T>,
    to_events: B,
    on_reset: R,
) -> Option<WatchHandle>
where
    T: Clone + Send + 'static,
    B: Fn(&mut dyn Iterator<Item = &Path>) -> Vec<T> + Send + 'static,
    R: Fn() -> Vec<T> + Send + 'static,
{
    let label = dir.display().to_string();
    let (event_tx, event_rx) = mpsc::channel::<Signal>();

    let mut watcher = match RecommendedWatcher::new(
        {
            let roots = watched_roots(dir);
            move |result: NotifyResult<Event>| {
                if let Some(signal) = classify(result, &roots) {
                    event_tx.send(signal).ignore_closed();
                }
            }
        },
        Config::default(),
    ) {
        Ok(watcher) => watcher,
        Err(e) => {
            warn!(dir = %label, "failed to create watcher: {e}");
            return None;
        }
    };

    if let Err(e) = watcher.watch(dir, mode) {
        warn!(dir = %label, "failed to watch dir: {e}");
        return None;
    }

    if let Err(e) = std::thread::Builder::new()
        .name("file-watch".to_string())
        .spawn(move || run_debounce_loop(event_rx, debounce, tx, to_events, on_reset))
    {
        warn!(dir = %label, "failed to spawn watcher debounce thread: {e}");
        return None;
    }

    debug!(dir = %label, "watcher started");
    Some(WatchHandle { _watcher: watcher })
}

/// Fold one signal into the window's pending paths; true when it was a reset.
fn absorb(signal: Signal, pending: &mut Vec<PathBuf>) -> bool {
    match signal {
        Signal::Paths(paths) => {
            pending.extend(paths);
            false
        }
        Signal::Reset => true,
    }
}

/// Cap retained heap capacity on the debounce scratch buffer after a large burst.
const MAX_RETAINED_PENDING_CAPACITY: usize = 256;

fn run_debounce_loop<T, B, R>(
    event_rx: mpsc::Receiver<Signal>,
    debounce: Duration,
    tx: broadcast::Sender<T>,
    to_events: B,
    on_reset: R,
) where
    T: Clone + Send + 'static,
    B: Fn(&mut dyn Iterator<Item = &Path>) -> Vec<T> + Send + 'static,
    R: Fn() -> Vec<T> + Send + 'static,
{
    let mut pending: Vec<PathBuf> = Vec::new();
    while let Ok(signal) = event_rx.recv() {
        let mut reset = absorb(signal, &mut pending);
        let deadline = Instant::now() + debounce;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match event_rx.recv_timeout(remaining) {
                Ok(more) => reset |= absorb(more, &mut pending),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if reset {
            for payload in on_reset() {
                tx.send(payload).ignore_closed();
            }
        }
        pending.sort_unstable();
        pending.dedup();
        let mut iter = pending.iter().map(PathBuf::as_path);
        for payload in to_events(&mut iter) {
            tx.send(payload).ignore_closed();
        }
        pending.clear();
        if pending.capacity() > MAX_RETAINED_PENDING_CAPACITY {
            pending.shrink_to(MAX_RETAINED_PENDING_CAPACITY);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_debouncer_mini::notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode,
    };

    #[test]
    fn filters_all_access_events_and_keeps_mutations() {
        assert!(!is_change_event(&EventKind::Access(AccessKind::Open(
            AccessMode::Any
        ))));
        assert!(!is_change_event(&EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(!is_change_event(&EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        assert!(!is_change_event(&EventKind::Access(AccessKind::Read)));

        assert!(is_change_event(&EventKind::Create(CreateKind::File)));
        assert!(is_change_event(&EventKind::Modify(ModifyKind::Data(
            DataChange::Content
        ))));
        assert!(is_change_event(&EventKind::Modify(ModifyKind::Name(
            RenameMode::Both
        ))));
        assert!(is_change_event(&EventKind::Remove(RemoveKind::File)));
        assert!(is_change_event(&EventKind::Any));
    }

    #[test]
    fn reading_watched_file_emits_zero_events_while_writes_emit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        crate::domain::settings_store::file::write_atomic(&file, r#"{"theme_current":"aurora"}"#)
            .unwrap();

        let (tx, mut rx) = broadcast::channel::<String>(32);
        let _guard = watch_dir_managed(
            dir.path(),
            RecursiveMode::NonRecursive,
            Duration::from_millis(80),
            tx,
            |path| {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .filter(|n| *n == "settings.json")
                    .map(str::to_string)
            },
            Vec::new,
        )
        .expect("watcher should start");

        // Let OS watch stream settle and drain any startup/initial-write events.
        std::thread::sleep(Duration::from_millis(250));
        while rx.try_recv().is_ok() {}

        for _ in 0..10 {
            let content = crate::domain::settings_store::file::read_file(&file)
                .unwrap()
                .unwrap();
            assert!(content.contains("aurora"));
        }

        std::thread::sleep(Duration::from_millis(250));
        assert!(
            rx.try_recv().is_err(),
            "reading a watched file must never emit change events"
        );

        std::fs::write(&file, r#"{"theme_current":"dracula"}"#).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut saw_write = false;
        while Instant::now() < deadline {
            if rx.try_recv().is_ok() {
                saw_write = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(saw_write, "external write must emit a change event");
    }

    #[test]
    fn debounce_loop_deduplicates_paths_within_window() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let (event_tx, event_rx) = mpsc::channel::<Signal>();
        let (tx, mut rx) = broadcast::channel::<PathBuf>(16);
        let callback_calls = Arc::new(AtomicUsize::new(0));
        let callback_calls_worker = Arc::clone(&callback_calls);

        let a = PathBuf::from("/watched/settings.json");
        let b = PathBuf::from("/watched/project.settings.json");
        event_tx
            .send(Signal::Paths(vec![a.clone(), a.clone()]))
            .unwrap();
        event_tx
            .send(Signal::Paths(vec![b.clone(), a.clone()]))
            .unwrap();
        event_tx
            .send(Signal::Paths(vec![a.clone(), b.clone()]))
            .unwrap();

        // Every signal is queued before the loop runs, so one window holds them
        // all however slowly this thread is scheduled.
        let worker = std::thread::spawn(move || {
            run_debounce_loop(
                event_rx,
                Duration::from_millis(40),
                tx,
                move |paths| {
                    paths
                        .map(|path| {
                            callback_calls_worker.fetch_add(1, Ordering::Relaxed);
                            path.to_path_buf()
                        })
                        .collect()
                },
                Vec::new,
            );
        });

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut received = Vec::new();
        while received.len() < 2 && Instant::now() < deadline {
            match rx.try_recv() {
                Ok(path) => received.push(path),
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        std::thread::sleep(Duration::from_millis(60));
        assert!(
            rx.try_recv().is_err(),
            "duplicate events in one debounce window must not emit extra broadcasts"
        );
        received.sort();
        assert_eq!(received, vec![b, a]);
        assert_eq!(
            callback_calls.load(Ordering::Relaxed),
            2,
            "callback must run once per unique path"
        );

        drop(event_tx);
        worker.join().unwrap();
    }

    #[test]
    fn lost_events_and_a_vanished_root_reset_instead_of_being_dropped() {
        use notify_debouncer_mini::notify::event::{Flag, RemoveKind, RenameMode};
        let root = Path::new("/watched");
        let roots = [PathBuf::from("/link/watched"), root.to_path_buf()];

        // inotify IN_Q_OVERFLOW / FSEvents MustScanSubDirs: no paths at all.
        let overflow = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert_eq!(classify(Ok(overflow), &roots), Some(Signal::Reset));

        let error = notify_debouncer_mini::notify::Error::generic("watch lost");
        assert_eq!(classify(Err(error), &roots), Some(Signal::Reset));

        let removed = Event::new(EventKind::Remove(RemoveKind::Folder)).add_path(root.into());
        assert_eq!(classify(Ok(removed), &roots), Some(Signal::Reset));
        let moved =
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From))).add_path(root.into());
        assert_eq!(classify(Ok(moved), &roots), Some(Signal::Reset));

        let file = root.join("settings.json");
        let changed = Event::new(EventKind::Remove(RemoveKind::File)).add_path(file.clone());
        assert_eq!(
            classify(Ok(changed), &roots),
            Some(Signal::Paths(vec![file]))
        );
        assert_eq!(classify(Ok(Event::new(EventKind::Any)), &roots), None);
    }

    #[test]
    fn debounce_loop_runs_the_reset_once_per_window() {
        let (event_tx, event_rx) = mpsc::channel::<Signal>();
        let (tx, mut rx) = broadcast::channel::<String>(16);

        event_tx.send(Signal::Reset).unwrap();
        event_tx.send(Signal::Reset).unwrap();
        event_tx
            .send(Signal::Paths(vec![PathBuf::from("/watched/a")]))
            .unwrap();

        // Every signal is queued before the loop runs, so one window holds them
        // all however slowly this thread is scheduled.
        let worker = std::thread::spawn(move || {
            run_debounce_loop(
                event_rx,
                Duration::from_millis(40),
                tx,
                |paths| paths.map(|p| p.display().to_string()).collect(),
                || vec!["reset".to_string()],
            );
        });

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut received = Vec::new();
        while received.len() < 2 && Instant::now() < deadline {
            match rx.try_recv() {
                Ok(event) => received.push(event),
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        std::thread::sleep(Duration::from_millis(60));
        assert!(rx.try_recv().is_err(), "one reset per window");
        assert_eq!(
            received,
            vec!["reset".to_string(), "/watched/a".to_string()]
        );

        drop(event_tx);
        worker.join().unwrap();
    }
}
