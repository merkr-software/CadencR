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

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

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
    if let Some(handle) = watch_dir_managed(dir, mode, debounce, tx, to_event) {
        if let Ok(mut watchers) = WATCHERS.lock() {
            watchers.push(handle);
        }
    }
}

/// [`watch_dir`], returning an owned [`WatchHandle`] so callers can track
/// whether watching started and cleanly stop it on drop.
pub fn watch_dir_managed<T, F>(
    dir: &Path,
    mode: RecursiveMode,
    debounce: Duration,
    tx: broadcast::Sender<T>,
    to_event: F,
) -> Option<WatchHandle>
where
    T: Clone + Send + 'static,
    F: Fn(&Path) -> Option<T> + Send + 'static,
{
    start(dir, mode, debounce, tx, move |paths| {
        paths.filter_map(&to_event).collect()
    })
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
    if let Some(handle) = start(dir, mode, debounce, tx, move |paths| {
        let mut events: Vec<T> = Vec::new();
        for event in paths.filter_map(&to_event) {
            if !events.contains(&event) {
                events.push(event);
            }
        }
        events
    }) {
        if let Ok(mut watchers) = WATCHERS.lock() {
            watchers.push(handle);
        }
    }
}

/// Ignore pure access events (`Open`, `Close`, `Read`) so reading a watched
/// file never looks like a modification on Linux inotify.
fn is_change_event(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

fn start<T, B>(
    dir: &Path,
    mode: RecursiveMode,
    debounce: Duration,
    tx: broadcast::Sender<T>,
    to_events: B,
) -> Option<WatchHandle>
where
    T: Clone + Send + 'static,
    B: Fn(&mut dyn Iterator<Item = &Path>) -> Vec<T> + Send + 'static,
{
    let label = dir.display().to_string();
    let (event_tx, event_rx) = mpsc::channel::<Vec<PathBuf>>();

    let mut watcher = match RecommendedWatcher::new(
        {
            let label = label.clone();
            move |result: NotifyResult<Event>| {
                let event = match result {
                    Ok(event) => event,
                    Err(e) => {
                        warn!(dir = %label, "watcher error: {e:?}");
                        return;
                    }
                };
                if !is_change_event(&event.kind) || event.paths.is_empty() {
                    return;
                }
                event_tx.send(event.paths).ignore_closed();
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
        .spawn(move || run_debounce_loop(event_rx, debounce, tx, to_events))
    {
        warn!(dir = %label, "failed to spawn watcher debounce thread: {e}");
        return None;
    }

    debug!(dir = %label, "watcher started");
    Some(WatchHandle { _watcher: watcher })
}

/// Cap retained heap capacity on the debounce scratch buffer after a large burst.
const MAX_RETAINED_PENDING_CAPACITY: usize = 256;

fn run_debounce_loop<T, B>(
    event_rx: mpsc::Receiver<Vec<PathBuf>>,
    debounce: Duration,
    tx: broadcast::Sender<T>,
    to_events: B,
) where
    T: Clone + Send + 'static,
    B: Fn(&mut dyn Iterator<Item = &Path>) -> Vec<T> + Send + 'static,
{
    let mut pending: Vec<PathBuf> = Vec::new();
    while let Ok(paths) = event_rx.recv() {
        pending.extend(paths);
        let deadline = Instant::now() + debounce;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match event_rx.recv_timeout(remaining) {
                Ok(more) => pending.extend(more),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
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

        let (event_tx, event_rx) = mpsc::channel::<Vec<PathBuf>>();
        let (tx, mut rx) = broadcast::channel::<PathBuf>(16);
        let callback_calls = Arc::new(AtomicUsize::new(0));
        let callback_calls_worker = Arc::clone(&callback_calls);

        let worker = std::thread::spawn(move || {
            run_debounce_loop(event_rx, Duration::from_millis(40), tx, move |paths| {
                paths
                    .map(|path| {
                        callback_calls_worker.fetch_add(1, Ordering::Relaxed);
                        path.to_path_buf()
                    })
                    .collect()
            });
        });

        let a = PathBuf::from("/watched/settings.json");
        let b = PathBuf::from("/watched/project.settings.json");
        event_tx.send(vec![a.clone(), a.clone()]).unwrap();
        event_tx.send(vec![b.clone(), a.clone()]).unwrap();
        event_tx.send(vec![a.clone(), b.clone()]).unwrap();

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
}
