//! Watches `~/.config/alacritty/alacritty.toml` plus every file its
//! `general.import` chain touches, and broadcasts a ping whenever any of
//! them changes. Read-only — this module never writes to the files.
//!
//! The import graph is not fixed at startup: every matching event both
//! triggers a client refetch and asks the subscription thread to re-resolve
//! the chain, so a newly added `general.import` becomes watched too, and a
//! chain that was invalid when the service started — including one whose
//! import doesn't exist yet — is picked up as soon as it is fixed.
//!
//! Live reload is best-effort, but its failures are not silent: they are
//! kept in [`watch_error`] and returned by the config route, so the client
//! can tell the user that external edits won't show up until a restart.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer};
use serde::Serialize;
use tokio::sync::broadcast;
use tracing::{debug, warn};

use super::default_config_path;
use super::resolve::resolve_chain_paths;

/// Why live reload is currently degraded, or `None` while it works. Written
/// by the watcher, read by `GET /api/terminal/alacritty-config`.
static WATCH_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// Why live reload of the config chain is currently unavailable, if it is.
pub fn watch_error() -> Option<String> {
    WATCH_ERROR.lock().expect("watch error poisoned").clone()
}

/// Record the watcher's current failure (or its recovery, with `None`).
/// Returns whether the status changed, so the caller can ping clients to
/// refetch it.
fn set_watch_error(error: Option<String>) -> bool {
    let mut current = WATCH_ERROR.lock().expect("watch error poisoned");
    if *current == error {
        return false;
    }
    if let Some(e) = &error {
        warn!("alacritty config live reload degraded: {e}");
    }
    *current = error;
    true
}

/// Emitted when the config chain changes on disk. Carries no data — the
/// client re-fetches `GET /api/terminal/alacritty-config` on receiving one,
/// the same "ping, then re-fetch" convention `SettingsChangeEvent` already
/// uses for the settings directory.
#[derive(Clone, Debug, Serialize)]
pub struct AlacrittyConfigChangedEvent {}

/// Which files trigger a refetch (exact paths, not bare file names) and
/// which directories are subscribed to get events for them.
#[derive(Debug, Default, Clone, PartialEq)]
struct WatchState {
    files: HashSet<PathBuf>,
    dirs: HashSet<PathBuf>,
}

impl WatchState {
    /// The exact chain files plus each file's parent directory. `config_path`
    /// is always included so an unresolvable chain degrades to watching the
    /// root alone and can recover on the next root edit. Each file is kept
    /// under BOTH its raw and its canonical form: backends like macOS
    /// FSEvents report events with the canonical path (e.g. `/private/var`
    /// instead of `/var`, or through a symlinked `~/.config`), while a
    /// symlinked import's own deletion event arrives under the raw symlink
    /// path — exact matching must accept both sides.
    fn from_touched(config_path: &Path, touched: Vec<PathBuf>) -> Self {
        let mut files = HashSet::from([config_path.to_path_buf(), normalize(config_path)]);
        let mut dirs = HashSet::from([config_path.parent().map(normalize).unwrap_or_default()]);
        for path in touched {
            if let Some(dir) = path.parent() {
                dirs.insert(normalize(dir));
            }
            files.insert(path.clone());
            files.insert(normalize(&path));
        }
        WatchState { files, dirs }
    }
}

/// Canonical form of `path`. A path that doesn't exist (yet) gets its
/// deepest existing ancestor canonicalized and the rest re-appended, so a
/// missing import still compares equal to the canonical path event backends
/// report once it is created.
fn normalize(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => normalize(parent).join(name),
        _ => path.to_path_buf(),
    }
}

/// Re-resolve the chain and derive the new watch set. A resolution failure
/// still watches every file the chain got to, including the import that
/// broke it — creating a missing import, or fixing a malformed one, triggers
/// another recompute, which is how a broken chain recovers without a service
/// restart.
fn recompute_state(config_path: &Path) -> WatchState {
    WatchState::from_touched(config_path, resolve_chain_paths(config_path))
}

/// Whether `path` is exactly one of the chain's own files — the root or one
/// of its imports, not some unrelated file that merely shares a name with
/// one of them (e.g. a `font.toml` in another watched directory). Both the
/// raw form and the canonical form are accepted: a deleted file can't be
/// canonicalized anymore, but the deletion event still deserves a reload.
fn is_watched_config_file(path: &Path, files: &HashSet<PathBuf>) -> bool {
    files.contains(path) || files.contains(&normalize(path))
}

/// Whether the event batch touches one of the chain's directories itself —
/// typically a missing import's directory being created inside a watched
/// parent. It is no config change for clients, but the watch set must be
/// recomputed so the new directory gets subscribed.
fn touches_watched_dir(events: &[DebouncedEvent], dirs: &HashSet<PathBuf>) -> bool {
    events
        .iter()
        .any(|e| dirs.contains(&e.path) || dirs.contains(&normalize(&e.path)))
}

/// Result of aligning the OS subscriptions with a wanted set of directories.
#[derive(Debug)]
struct Alignment {
    /// The directories actually subscribed afterwards.
    subscribed: HashSet<PathBuf>,
    /// One message per directory whose (un)subscription failed.
    errors: Vec<String>,
}

impl Alignment {
    fn error(&self) -> Option<String> {
        (!self.errors.is_empty()).then(|| self.errors.join("; "))
    }
}

/// Align the OS subscriptions with `wanted`: subscribe to newly needed
/// directories, unsubscribe from the ones no chain member lives in anymore.
/// A wanted directory that doesn't exist yet is skipped, not reported — it
/// stays out of `subscribed`, so a later recompute retries it once it
/// exists. A failed subscription is retried the same way.
fn apply_subscriptions(
    debouncer: &mut Debouncer<RecommendedWatcher>,
    subscribed: &HashSet<PathBuf>,
    wanted: &HashSet<PathBuf>,
) -> Alignment {
    let mut now = subscribed.clone();
    let mut errors = Vec::new();
    for dir in subscribed.difference(wanted) {
        match debouncer.watcher().unwatch(dir) {
            Ok(()) => {
                now.remove(dir);
            }
            // A deleted directory took its OS subscription with it.
            Err(_) if !dir.exists() => {
                now.remove(dir);
            }
            Err(e) => errors.push(format!("failed to unwatch {}: {e}", dir.display())),
        }
    }
    for dir in wanted.difference(subscribed) {
        if !dir.is_dir() {
            continue;
        }
        match debouncer.watcher().watch(dir, RecursiveMode::NonRecursive) {
            Ok(()) => {
                now.insert(dir.clone());
            }
            Err(e) => errors.push(format!("failed to watch {}: {e}", dir.display())),
        }
    }
    Alignment {
        subscribed: now,
        errors,
    }
}

/// Watch the root config and every file its import chain touches, and
/// broadcast a ping on `tx` whenever any of them changes. Best-effort: a
/// failure is never fatal — the config still loads via the HTTP route, just
/// without live external-edit refresh — and is reported through
/// [`watch_error`]. No-ops (does not start a watcher, reports nothing) when
/// the home directory can't be resolved at all.
pub fn start_watcher(tx: broadcast::Sender<AlacrittyConfigChangedEvent>) {
    let Some(config_path) = default_config_path() else {
        return;
    };
    spawn_watcher(config_path, tx);
}

fn spawn_watcher(config_path: PathBuf, tx: broadcast::Sender<AlacrittyConfigChangedEvent>) {
    // Events arrive on notify's own thread; subscriptions must change from
    // event context, but watcher methods may not be called from there
    // safely. Instead, each relevant event also signals this channel, and
    // the subscription thread below owns the debouncer and re-aligns the
    // watch set off the event path.
    let (recompute_tx, recompute_rx) = mpsc::channel::<()>();
    let shared = Arc::new(Mutex::new(recompute_state(&config_path)));
    let handler = event_handler(Arc::clone(&shared), tx.clone(), recompute_tx);
    let mut debouncer = match new_debouncer(Duration::from_millis(500), handler) {
        Ok(debouncer) => debouncer,
        Err(e) => {
            set_watch_error(Some(format!("failed to start the file watcher: {e}")));
            return;
        }
    };

    // Apply the initial subscriptions synchronously, before spawning the
    // recompute thread, so `start_watcher` returns with the chain already
    // under watch — an edit racing service startup is still caught.
    let watched = shared.lock().expect("watch state poisoned").clone();
    let alignment = apply_subscriptions(&mut debouncer, &HashSet::new(), &watched.dirs);
    set_watch_error(alignment.error());
    debug!(dirs = ?alignment.subscribed, "alacritty config watcher started");

    let resubscriber = Resubscriber {
        config_path,
        debouncer,
        shared,
        watched,
        subscribed: alignment.subscribed,
        reload_tx: tx,
    };
    if let Err(e) = std::thread::Builder::new()
        .name("alacritty-config-watch".to_string())
        .spawn(move || resubscriber.run(recompute_rx))
    {
        // The closure — and the debouncer it owned — is dropped with it.
        set_watch_error(Some(format!(
            "failed to start the file watcher thread: {e}"
        )));
    }
}

/// The debouncer callback: pings clients when a chain file changes, and asks
/// the subscription thread to recompute whenever the chain (or a directory
/// it needs) may have changed.
fn event_handler(
    shared: Arc<Mutex<WatchState>>,
    tx: broadcast::Sender<AlacrittyConfigChangedEvent>,
    recompute_tx: mpsc::Sender<()>,
) -> impl FnMut(DebounceEventResult) + Send + 'static {
    move |result| {
        let events = match result {
            Ok(events) => events,
            Err(e) => {
                // Events may have been lost: refetch and recompute rather
                // than leave the terminal on a stale config.
                warn!("alacritty config watcher error: {e:?}");
                let _ = tx.send(AlacrittyConfigChangedEvent {});
                let _ = recompute_tx.send(());
                return;
            }
        };
        let watched = shared.lock().expect("watch state poisoned").clone();
        if events
            .iter()
            .any(|e| is_watched_config_file(&e.path, &watched.files))
        {
            debug!("alacritty.toml change detected");
            let _ = tx.send(AlacrittyConfigChangedEvent {});
            // The edit may also have changed the import graph itself (a
            // `general.import` added or removed) — recompute it so the new
            // files become watched too.
            let _ = recompute_tx.send(());
        } else if touches_watched_dir(&events, &watched.dirs) {
            let _ = recompute_tx.send(());
        }
    }
}

/// Everything the subscription thread owns. It holds the debouncer for the
/// process lifetime (same reasoning as the settings watcher's static):
/// dropping it would silently stop notifications. The keep-alive chain is
/// circular by design — the debouncer's callback holds the recompute
/// sender, which keeps the channel (and thus this thread and the debouncer
/// it owns) alive; no static is needed.
///
/// Watching each directory (not the files themselves) survives editors that
/// save by replacing the file rather than writing in place.
struct Resubscriber {
    config_path: PathBuf,
    debouncer: Debouncer<RecommendedWatcher>,
    /// The watch set the event callback filters against.
    shared: Arc<Mutex<WatchState>>,
    /// This thread's copy of the last watch set it published.
    watched: WatchState,
    subscribed: HashSet<PathBuf>,
    reload_tx: broadcast::Sender<AlacrittyConfigChangedEvent>,
}

impl Resubscriber {
    fn run(mut self, recompute_rx: mpsc::Receiver<()>) {
        while recompute_rx.recv() == Ok(()) {
            // One recompute covers every request queued meanwhile.
            while recompute_rx.try_recv().is_ok() {}
            self.recompute();
        }
    }

    fn recompute(&mut self) {
        let next = recompute_state(&self.config_path);
        let alignment = apply_subscriptions(&mut self.debouncer, &self.subscribed, &next.dirs);
        let status_changed = set_watch_error(alignment.error());
        let changed =
            status_changed || next != self.watched || alignment.subscribed != self.subscribed;
        *self.shared.lock().expect("watch state poisoned") = next.clone();
        debug!(files = ?next.files, "alacritty config watch set recomputed");
        self.watched = next;
        self.subscribed = alignment.subscribed;
        // Close the subscription-installation window: events for newly
        // watched files couldn't fire before this point, so clients get one
        // more refetch now that they can — and one to pick up a changed
        // `watch_error`. An ordinary edit to an already-watched file changes
        // none of this and already got its ping from the event callback.
        if changed {
            let _ = self.reload_tx.send(AlacrittyConfigChangedEvent {});
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files_of(paths: &[&str]) -> HashSet<PathBuf> {
        paths.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn matches_only_the_exact_config_chain_paths() {
        let files = files_of(&[
            "/nonexistent/user/.config/alacritty/alacritty.toml",
            "/nonexistent/user/.config/alacritty/themes/font.toml",
        ]);
        assert!(is_watched_config_file(
            Path::new("/nonexistent/user/.config/alacritty/alacritty.toml"),
            &files
        ));
        assert!(is_watched_config_file(
            Path::new("/nonexistent/user/.config/alacritty/themes/font.toml"),
            &files
        ));
        // An unrelated file that merely shares a basename with a chain file
        // must NOT match — the old basename-based check did.
        assert!(!is_watched_config_file(
            Path::new("/nonexistent/user/.config/alacritty/other-dir/font.toml"),
            &files
        ));
        assert!(!is_watched_config_file(
            Path::new("/nonexistent/user/.config/alacritty/alacritty.toml.swp"),
            &files
        ));
        assert!(!is_watched_config_file(
            Path::new("/nonexistent/user/.config/alacritty/themes/other.toml"),
            &files
        ));
    }

    #[test]
    fn watch_state_covers_each_files_directory_and_always_the_root() {
        let state = WatchState::from_touched(
            Path::new("/nonexistent/user/.config/alacritty/alacritty.toml"),
            vec![
                PathBuf::from("/nonexistent/user/.config/alacritty/themes/font.toml"),
                PathBuf::from("/nonexistent/user/.config/alacritty/alacritty.toml"),
            ],
        );
        assert_eq!(
            state.files,
            files_of(&[
                "/nonexistent/user/.config/alacritty/alacritty.toml",
                "/nonexistent/user/.config/alacritty/themes/font.toml",
            ])
        );
        assert_eq!(
            state.dirs,
            files_of(&[
                "/nonexistent/user/.config/alacritty",
                "/nonexistent/user/.config/alacritty/themes",
            ])
        );
    }

    #[test]
    fn empty_touched_still_watches_the_root_directory() {
        let state = WatchState::from_touched(
            Path::new("/nonexistent/user/.config/alacritty/alacritty.toml"),
            Vec::new(),
        );
        assert_eq!(
            state.files,
            files_of(&["/nonexistent/user/.config/alacritty/alacritty.toml"])
        );
        assert_eq!(
            state.dirs,
            files_of(&["/nonexistent/user/.config/alacritty"])
        );
    }

    #[test]
    fn recompute_picks_up_every_import_of_a_valid_chain() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("font.toml"),
            "[font.normal]\nfamily = \"Iosevka\"\n",
        )
        .unwrap();
        let root = dir.path().join("alacritty.toml");
        std::fs::write(
            &root,
            "general.import = [\"font.toml\"]\n[scrolling]\nhistory = 5000\n",
        )
        .unwrap();
        let state = recompute_state(&root);
        assert!(state.files.contains(&normalize(&root)));
        assert!(state
            .files
            .contains(&normalize(&dir.path().join("font.toml"))));
    }

    #[test]
    fn recompute_keeps_watching_the_missing_import_of_an_invalid_chain() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("alacritty.toml");
        std::fs::write(&root, "general.import = [\"themes/missing.toml\"]\n").unwrap();
        let missing = dir.path().join("themes").join("missing.toml");
        let state = recompute_state(&root);
        // The root stays under watch, and so does the import that broke
        // the chain: creating it later is a matching event.
        assert!(state.files.contains(&root));
        assert!(state.files.contains(&normalize(&root)));
        assert!(is_watched_config_file(&missing, &state.files));
        // Its directory is wanted even though it doesn't exist yet;
        // `apply_subscriptions` skips it until it does.
        assert!(state.dirs.contains(&normalize(dir.path())));
        assert!(state.dirs.contains(&normalize(dir.path()).join("themes")));
    }

    #[test]
    fn creating_a_watched_directory_asks_for_a_recompute() {
        let dirs = files_of(&["/nonexistent/user/.config/alacritty/themes"]);
        let event = |path: &str| DebouncedEvent {
            path: PathBuf::from(path),
            kind: notify_debouncer_mini::DebouncedEventKind::Any,
        };
        assert!(touches_watched_dir(
            &[event("/nonexistent/user/.config/alacritty/themes")],
            &dirs
        ));
        assert!(!touches_watched_dir(
            &[event("/nonexistent/user/.config/alacritty/other")],
            &dirs
        ));
    }

    fn test_debouncer() -> Debouncer<RecommendedWatcher> {
        new_debouncer(Duration::from_millis(50), |_: DebounceEventResult| {}).unwrap()
    }

    #[test]
    fn alignment_skips_a_missing_directory_until_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let existing = normalize(dir.path());
        let later = existing.join("themes");
        let wanted = HashSet::from([existing.clone(), later.clone()]);
        let mut debouncer = test_debouncer();

        let first = apply_subscriptions(&mut debouncer, &HashSet::new(), &wanted);
        assert_eq!(first.subscribed, HashSet::from([existing.clone()]));
        assert_eq!(first.error(), None, "a missing directory is not an error");

        std::fs::create_dir(&later).unwrap();
        let second = apply_subscriptions(&mut debouncer, &first.subscribed, &wanted);
        assert_eq!(second.subscribed, wanted);
        assert_eq!(second.error(), None);
    }

    #[test]
    fn alignment_drops_a_deleted_directory_without_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let root_dir = normalize(dir.path());
        let themes = root_dir.join("themes");
        std::fs::create_dir(&themes).unwrap();
        let mut debouncer = test_debouncer();
        let both = HashSet::from([root_dir.clone(), themes.clone()]);
        let first = apply_subscriptions(&mut debouncer, &HashSet::new(), &both);
        assert_eq!(first.subscribed, both);

        std::fs::remove_dir(&themes).unwrap();
        let wanted = HashSet::from([root_dir.clone()]);
        let second = apply_subscriptions(&mut debouncer, &first.subscribed, &wanted);
        assert_eq!(second.subscribed, wanted);
        assert_eq!(second.error(), None);
    }

    #[test]
    fn alignment_errors_are_joined_into_one_message() {
        let alignment = Alignment {
            subscribed: HashSet::new(),
            errors: vec![
                "failed to watch /a: x".into(),
                "failed to watch /b: y".into(),
            ],
        };
        assert_eq!(
            alignment.error().as_deref(),
            Some("failed to watch /a: x; failed to watch /b: y")
        );
    }

    /// Wait until the watcher broadcasts at least one event, polling instead
    /// of sleeping a fixed amount: real FS events + the 500ms debounce are
    /// asynchronous, and FSEvents needs a moment after stream start before
    /// it reports reliably.
    fn wait_for_event(rx: &mut broadcast::Receiver<AlacrittyConfigChangedEvent>) -> bool {
        use broadcast::error::TryRecvError;

        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(_) => return true,
                // Events occurred but the receiver fell behind: still a
                // change notification.
                Err(TryRecvError::Lagged(_)) => return true,
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Closed) => return false,
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// Write `contents` and wait for the resulting reload event, retrying a
    /// couple of times so a single missed FS event (FSEvents startup
    /// latency, a write racing the subscription thread) can't produce a
    /// false failure.
    fn write_and_expect_reload(
        rx: &mut broadcast::Receiver<AlacrittyConfigChangedEvent>,
        path: &Path,
        contents: &str,
    ) -> bool {
        for _ in 0..2 {
            std::fs::write(path, contents).unwrap();
            if wait_for_event(rx) {
                return true;
            }
        }
        false
    }

    /// Drain every event already delivered to `rx`, then wait out the
    /// debounce window so no further events can be in flight. Used between
    /// the two phases of the end-to-end test: the subscription thread also
    /// sends a follow-up reload ping once a new import is under watch, and
    /// phase two must not succeed on that leftover ping.
    fn drain_and_settle(rx: &mut broadcast::Receiver<AlacrittyConfigChangedEvent>) {
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
    }

    #[test]
    fn a_newly_added_import_becomes_watched_and_triggers_live_reload() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("alacritty");
        let themes = config_dir.join("themes");
        std::fs::create_dir_all(&themes).unwrap();
        let root = config_dir.join("alacritty.toml");
        std::fs::write(&root, "[scrolling]\nhistory = 1000\n").unwrap();
        let import = themes.join("font.toml");
        std::fs::write(&import, "[font]\nsize = 14\n").unwrap();

        let (tx, _keep) = broadcast::channel(16);
        spawn_watcher(root.clone(), tx.clone());
        let mut rx = tx.subscribe();
        // Let the OS event stream settle before the first edit — FSEvents
        // can drop writes that race stream startup.
        std::thread::sleep(Duration::from_millis(500));

        // Add the import to the root: this must trigger a reload event for
        // clients AND extend the subscriptions to themes/.
        assert!(
            write_and_expect_reload(
                &mut rx,
                &root,
                "general.import = [\"themes/font.toml\"]\n[scrolling]\nhistory = 1000\n",
            ),
            "editing the root must trigger a reload event"
        );
        // Flush the follow-up ping the subscription thread sends once
        // themes/ is under watch, so phase two can only pass on a real
        // event for the imported file itself.
        drain_and_settle(&mut rx);

        // Editing the newly imported file is the reviewer's exact scenario:
        // before the recompute fix, its directory was never subscribed, so
        // this edit triggered nothing and only a service restart helped.
        assert!(
            write_and_expect_reload(&mut rx, &import, "[font]\nsize = 18\n"),
            "editing a newly imported file must trigger a reload event"
        );
    }

    #[test]
    fn creating_a_missing_import_triggers_live_reload() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("alacritty");
        std::fs::create_dir_all(&config_dir).unwrap();
        let root = config_dir.join("alacritty.toml");
        std::fs::write(&root, "general.import = [\"themes/font.toml\"]\n").unwrap();

        let (tx, _keep) = broadcast::channel(16);
        spawn_watcher(root.clone(), tx.clone());
        let mut rx = tx.subscribe();
        std::thread::sleep(Duration::from_millis(500));

        // Neither the import nor its directory exists at startup. Creating
        // the directory gets it subscribed, which pings clients once...
        std::fs::create_dir(config_dir.join("themes")).unwrap();
        assert!(
            wait_for_event(&mut rx),
            "subscribing the new directory must ping clients"
        );
        // ...and from then on creating the file itself is a real event.
        drain_and_settle(&mut rx);
        assert!(
            write_and_expect_reload(
                &mut rx,
                &config_dir.join("themes").join("font.toml"),
                "[font]\nsize = 16\n"
            ),
            "creating the missing import must trigger a reload event"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_import_is_matched_under_both_of_its_paths() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("theme-real.toml");
        std::fs::write(&target, "[colors.primary]\nbackground = \"#1e1e2e\"\n").unwrap();
        let link = dir.path().join("theme-link.toml");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let root = dir.path().join("alacritty.toml");
        std::fs::write(&root, "general.import = [\"theme-link.toml\"]\n").unwrap();

        let state = recompute_state(&root);
        // The raw symlink path must be watched too: its deletion event
        // arrives under that path, and once the link is gone it can no
        // longer be canonicalized to the target's path.
        assert!(state.files.contains(&link));
        assert!(state.files.contains(&normalize(&link)));
        assert!(state.files.contains(&normalize(&target)));
        assert!(is_watched_config_file(&link, &state.files));
        assert!(is_watched_config_file(&normalize(&target), &state.files));
    }
}
