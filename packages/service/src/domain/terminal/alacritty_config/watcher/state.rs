//! Pure computation of what the watcher needs to watch: the exact chain
//! files, the directories that must be subscribed for them, and why part of
//! the chain cannot be observed at all. No threads and no subscriptions
//! here — the watcher machinery lives in the parent module and only feeds
//! filesystem events in and gets watch sets out.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::links::watch_paths;

/// Which files trigger a refetch (exact paths, not bare file names) and
/// which directories are subscribed to get events for them.
#[derive(Debug, Default, Clone, PartialEq)]
pub(super) struct WatchState {
    pub(super) files: HashSet<PathBuf>,
    pub(super) dirs: HashSet<PathBuf>,
    /// Missing wanted directories that no existing directory above can
    /// observe, because their deepest existing ancestor is the filesystem
    /// root, which is never subscribed. Live reload cannot cover them; the
    /// watcher reports that instead of staying silently stale.
    pub(super) unwatchable: Vec<PathBuf>,
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
    ///
    /// A symlinked import's parent directories are wanted under both forms
    /// too: the link's own directory (its deletion event arrives there) and
    /// the resolved target's directory (edits to the target file arrive
    /// there, and that directory is often outside every other watched path).
    /// Links in intermediate directories are reload triggers too: switching
    /// one changes the import graph even without editing a chain file.
    /// Dangling links retain their target paths and target directories so
    /// recreating the target can recover live reload.
    ///
    /// A wanted directory that doesn't exist yet can't be subscribed, and
    /// nothing below it can produce events either — unless one of its
    /// ancestors is watched. The deepest existing ancestor of every missing
    /// directory is therefore watched too (never the filesystem root), so
    /// creating the tree is observed and each recompute can subscribe one
    /// level deeper. A missing directory whose only existing ancestor is
    /// the filesystem root can never be observed: it is recorded in
    /// `unwatchable` and reported through [`Self::degraded_reload_error`]
    /// instead of failing silently.
    pub(super) fn from_touched(config_path: &Path, touched: Vec<PathBuf>) -> Self {
        let mut files = HashSet::new();
        let mut dirs = HashSet::new();
        for path in std::iter::once(config_path.to_path_buf()).chain(touched) {
            if let Some(dir) = path.parent() {
                dirs.insert(normalize(dir));
            }
            for watched_path in watch_paths(&path) {
                if let Some(dir) = watched_path.parent() {
                    dirs.insert(normalize(dir));
                }
                files.insert(watched_path);
            }
            files.insert(path);
        }
        let wanted: Vec<PathBuf> = dirs.iter().cloned().collect();
        let mut unwatchable = Vec::new();
        for dir in wanted {
            if dir.is_dir() {
                continue;
            }
            match deepest_existing_ancestor(&dir) {
                Some(ancestor) => {
                    dirs.insert(ancestor);
                }
                None => unwatchable.push(dir),
            }
        }
        unwatchable.sort();
        WatchState {
            files,
            dirs,
            unwatchable,
        }
    }

    /// Why live reload cannot cover part of the chain, or `None` when the
    /// watch set observes everything it wants. The watcher publishes it
    /// through `watch_error`, and it clears on the next recompute once a
    /// nearer directory exists above the missing tree (creating that
    /// nearer directory itself is what a watched ancestor observes).
    pub(super) fn degraded_reload_error(&self) -> Option<String> {
        if self.unwatchable.is_empty() {
            return None;
        }
        let paths = self
            .unwatchable
            .iter()
            .map(|dir| dir.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        Some(format!(
            "live reload cannot watch {paths}: the only existing directory \
             above them is the filesystem root, which is never watched. Editing \
             an existing config file re-checks the chain."
        ))
    }
}

/// The deepest ancestor of `path` that exists as a directory, so a missing
/// directory tree can be observed from its nearest watched ancestor. `None`
/// when no ancestor exists at all — or when the only existing ancestor is
/// the filesystem root: watching `/` would recompute the chain for every
/// top-level creation, which is not a subscription worth keeping.
fn deepest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut ancestor = path.parent()?;
    while !ancestor.is_dir() {
        ancestor = ancestor.parent()?;
    }
    ancestor.parent()?;
    Some(ancestor.to_path_buf())
}

/// Canonical form of `path`. A path that doesn't exist (yet) gets its
/// deepest existing ancestor canonicalized and the rest re-appended, so a
/// missing import still compares equal to the canonical path event backends
/// report once it is created.
pub(super) fn normalize(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => normalize(parent).join(name),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_state_covers_each_files_directory_and_always_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("alacritty");
        let themes = config_dir.join("themes");
        std::fs::create_dir_all(&themes).unwrap();
        let root = config_dir.join("alacritty.toml");
        let font = themes.join("font.toml");
        let state = WatchState::from_touched(&root, vec![font.clone(), root.clone()]);
        let mut expected_files = HashSet::new();
        for path in [&root, &font] {
            expected_files.insert(path.clone());
            expected_files.insert(normalize(path));
        }
        assert_eq!(state.files, expected_files);
        assert_eq!(
            state.dirs,
            HashSet::from([normalize(&config_dir), normalize(&themes)])
        );
        assert!(state.unwatchable.is_empty());
        assert!(state.degraded_reload_error().is_none());
    }

    #[test]
    fn empty_touched_still_watches_the_root_directory() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("alacritty");
        std::fs::create_dir_all(&config_dir).unwrap();
        let root = config_dir.join("alacritty.toml");
        let state = WatchState::from_touched(&root, Vec::new());
        assert_eq!(state.files, HashSet::from([root.clone(), normalize(&root)]));
        assert_eq!(state.dirs, HashSet::from([normalize(&config_dir)]));
        assert!(state.degraded_reload_error().is_none());
    }

    #[test]
    fn watch_state_watches_the_existing_ancestor_of_a_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("alacritty");
        std::fs::create_dir_all(&config_dir).unwrap();
        let root = config_dir.join("alacritty.toml");
        // An import under an external, entirely missing directory tree:
        // nothing between the config directory and the import exists.
        let missing_dir = normalize(dir.path())
            .join("external")
            .join("new")
            .join("dir");
        let state = WatchState::from_touched(&root, vec![missing_dir.join("font.toml")]);
        // The missing directory itself stays wanted — it gets subscribed
        // once it exists...
        assert!(state.dirs.contains(&missing_dir));
        // ...and its deepest existing ancestor is watched too, so creating
        // the tree is observed even though no chain file lives there yet.
        assert!(state.dirs.contains(&normalize(dir.path())));
        assert!(!state.dirs.contains(&normalize(dir.path()).join("external")));
        // Observable from its ancestor, so no degradation is reported.
        assert!(state.unwatchable.is_empty());
        assert!(state.degraded_reload_error().is_none());
    }

    #[test]
    fn watch_state_reports_missing_directories_only_the_filesystem_root_sees() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("alacritty");
        std::fs::create_dir_all(&config_dir).unwrap();
        let root = config_dir.join("alacritty.toml");
        // An absolute import below a top-level directory that does not
        // exist: the only existing ancestor of its directory is the
        // filesystem root, which the watcher never subscribes.
        let import = PathBuf::from("/cadencr-missing-import-top/config/font.toml");
        let state = WatchState::from_touched(&root, vec![import]);
        let missing = normalize(Path::new("/cadencr-missing-import-top/config"));
        assert_eq!(state.unwatchable, vec![missing]);
        let error = state.degraded_reload_error().expect("degradation reported");
        assert!(error.contains("filesystem root"), "{error}");
        assert!(error.contains("cadencr-missing-import-top"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn watch_state_watches_a_symlink_targets_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("alacritty");
        let dotfiles = dir.path().join("dotfiles");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&dotfiles).unwrap();
        // The import is a symlink whose target lives in a directory that no
        // other chain file touches: only the target's own parent can report
        // edits to it.
        let target = dotfiles.join("font.toml");
        std::fs::write(&target, "[font]\nsize = 14\n").unwrap();
        let link = config_dir.join("font.toml");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let root = config_dir.join("alacritty.toml");

        let state = WatchState::from_touched(&root, vec![link]);
        assert!(state.dirs.contains(&normalize(&config_dir)));
        assert!(state.dirs.contains(&normalize(&dotfiles)));
    }

    #[cfg(unix)]
    #[test]
    fn watch_state_keeps_a_dangling_symlinks_target_and_existing_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("alacritty");
        std::fs::create_dir(&config_dir).unwrap();
        let target = dir.path().join("dotfiles/new/font.toml");
        let link = config_dir.join("font.toml");
        std::os::unix::fs::symlink("../dotfiles/new/font.toml", &link).unwrap();

        let state = WatchState::from_touched(&config_dir.join("alacritty.toml"), vec![link]);
        assert!(state.files.contains(&normalize(&target)));
        assert!(state.dirs.contains(&normalize(target.parent().unwrap())));
        assert!(state.dirs.contains(&normalize(dir.path())));
        assert!(state.degraded_reload_error().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn watch_state_observes_directory_symlink_replacements() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("alacritty");
        let external = dir.path().join("external");
        let target_dir = dir.path().join("themes/a");
        for path in [&config_dir, &external, &target_dir] {
            std::fs::create_dir_all(path).unwrap();
        }
        let link = external.join("current");
        std::os::unix::fs::symlink(&target_dir, &link).unwrap();

        let state = WatchState::from_touched(
            &config_dir.join("alacritty.toml"),
            vec![link.join("font.toml")],
        );
        assert!(state.files.contains(&normalize(&external).join("current")));
        assert!(state.dirs.contains(&normalize(&external)));
        assert!(state.dirs.contains(&normalize(&target_dir)));
    }

    #[test]
    fn deepest_existing_ancestor_stops_at_the_nearest_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("a").join("b").join("c");
        assert_eq!(
            deepest_existing_ancestor(&missing),
            Some(dir.path().to_path_buf())
        );
    }

    #[test]
    fn deepest_existing_ancestor_never_returns_the_filesystem_root() {
        // A missing tree whose only existing ancestor is the filesystem
        // root yields no ancestor at all: watching `/` would recompute the
        // chain for every top-level creation.
        assert_eq!(
            deepest_existing_ancestor(Path::new("/nonexistent/deep/tree")),
            None
        );
    }
}
