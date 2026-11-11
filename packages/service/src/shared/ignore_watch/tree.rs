//! Which directories a gitignore-aware watch covers, kept current as the
//! worktree changes. Pure bookkeeping: the caller applies the watch changes.
//!
//! Ignore rules come from the `ignore` crate (nested `.gitignore` files,
//! `.git/info/exclude`, the global excludes file), so a path counts as ignored
//! exactly when a walk of its directory would skip it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use notify_debouncer_mini::notify::RecursiveMode;

use super::walk::{all_dirs, git_dir_watches, is_real_dir, module_git_dirs, scan_dirs, Listings};

/// How a file-watch backend covers a tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Strategy {
    /// One watch per directory (inotify, kqueue): an ignored directory costs
    /// nothing only if it is never watched.
    PerDirectory,
    /// One watch covers a whole tree (FSEvents): events from ignored paths are
    /// dropped instead.
    Tree,
}

/// What one event batch changes.
#[derive(Debug, Default)]
pub(super) struct Absorbed {
    /// Changed paths that are not ignored, Git-directory paths included.
    pub(super) relevant: Vec<PathBuf>,
    /// Directories to start watching (per-directory strategy only).
    pub(super) watch: Vec<PathBuf>,
    /// Directories to stop watching (per-directory strategy only).
    pub(super) unwatch: Vec<PathBuf>,
}

pub(super) struct WatchTree {
    worktree: PathBuf,
    git_dirs: Vec<PathBuf>,
    strategy: Strategy,
    /// Known non-ignored worktree directories, the worktree itself included:
    /// every one of them with the per-directory strategy, only those events
    /// reached so far with the tree strategy, which needs no walk to start.
    dirs: HashSet<PathBuf>,
    /// Watched directories of the Git dirs: each Git dir, its `info/` (the
    /// exclude file), its `refs/` tree, and the same for each submodule's Git
    /// dir under `modules/`. `objects/` and `logs/` only churn (per-directory
    /// strategy only).
    git_watched: HashSet<PathBuf>,
}

impl WatchTree {
    /// Index `worktree`. Blocking with the per-directory strategy: one walk of
    /// the non-ignored tree.
    pub(super) fn scan(worktree: PathBuf, git_dirs: Vec<PathBuf>, strategy: Strategy) -> Self {
        let mut git_watched = HashSet::new();
        let dirs = match strategy {
            Strategy::PerDirectory => {
                for git_dir in &git_dirs {
                    git_watched.extend(git_dir_watches(git_dir));
                }
                scan_dirs(&worktree)
            }
            Strategy::Tree => HashSet::from([worktree.clone()]),
        };
        Self {
            worktree,
            git_dirs,
            strategy,
            dirs,
            git_watched,
        }
    }

    /// The watches to start with.
    pub(super) fn initial_watches(&self) -> Vec<(PathBuf, RecursiveMode)> {
        match self.strategy {
            Strategy::Tree => std::iter::once(self.worktree.clone())
                .chain(self.outside_git_dirs().cloned())
                .map(|path| (path, RecursiveMode::Recursive))
                .collect(),
            Strategy::PerDirectory => {
                let mut dirs: Vec<PathBuf> = self.dirs.union(&self.git_watched).cloned().collect();
                dirs.sort();
                dirs.into_iter()
                    .map(|path| (path, RecursiveMode::NonRecursive))
                    .collect()
            }
        }
    }

    /// How many OS watches the tree holds (inotify spends one per directory).
    /// Git dirs are never among the worktree's directories: walks skip them.
    pub(super) fn watch_count(&self) -> usize {
        match self.strategy {
            Strategy::Tree => 1 + self.outside_git_dirs().count(),
            Strategy::PerDirectory => self.dirs.len() + self.git_watched.len(),
        }
    }

    pub(super) fn worktree(&self) -> &Path {
        &self.worktree
    }

    fn outside_git_dirs(&self) -> impl Iterator<Item = &PathBuf> {
        self.git_dirs
            .iter()
            .filter(|dir| !dir.starts_with(&self.worktree))
    }

    /// Sort one debounced batch into relevant paths and watch changes.
    pub(super) fn absorb(&mut self, paths: &[PathBuf]) -> Absorbed {
        let mut out = Absorbed::default();
        let mut listings = Listings::default();
        let mut rules_changed = false;
        // Parents first, so a new directory is known before its contents.
        let mut sorted: Vec<&PathBuf> = paths.iter().collect();
        sorted.sort_by_cached_key(|path| path.components().count());
        for path in sorted {
            let relevant = if self.in_git_dir(path) {
                rules_changed |= path.ends_with("info/exclude");
                self.track_git_dir(path, &mut out);
                true
            } else {
                let relevant = self.track_worktree(path, &mut listings, &mut out);
                // A rule file inside an ignored directory (`.venv/`, tool
                // caches write their own) changes nothing Git sees.
                rules_changed |=
                    relevant && path.file_name().is_some_and(|name| name == ".gitignore");
                relevant
            };
            if relevant {
                out.relevant.push(path.clone());
            }
        }
        if rules_changed {
            self.rescan(&mut out);
        }
        out
    }

    /// The backend lost events (an inotify queue overflow): rebuild the index
    /// and report the whole worktree as changed.
    pub(super) fn rescan_all(&mut self) -> Absorbed {
        let mut out = Absorbed::default();
        self.rescan(&mut out);
        out.relevant.push(self.worktree.clone());
        out
    }

    fn in_git_dir(&self, path: &Path) -> bool {
        self.git_dirs.iter().any(|dir| path.starts_with(dir))
    }

    /// Follow the watched Git directories as they come and go: `refs/`
    /// namespaces with branches, `info/`, a submodule's Git dir. A directory
    /// named by an event is watched again even when known: it may have been
    /// deleted and recreated within one batch, which drops its old watch.
    fn track_git_dir(&mut self, path: &Path, out: &mut Absorbed) {
        if self.strategy != Strategy::PerDirectory {
            return;
        }
        let followed = self.git_dirs.iter().any(|dir| {
            path.starts_with(dir.join("refs"))
                || path.starts_with(dir.join("info"))
                || path.starts_with(dir.join("modules"))
        });
        if !followed {
            return;
        }
        if is_real_dir(path) {
            let found = if path.join("HEAD").is_file() {
                git_dir_watches(path)
            } else if path.components().any(|part| part.as_os_str() == "modules")
                && !path.components().any(|part| part.as_os_str() == "refs")
            {
                // A submodule path segment (`modules/libs/`): watch down to
                // the Git dirs below it.
                module_git_dirs(path)
                    .iter()
                    .flat_map(|dir| git_dir_watches(dir))
                    .collect()
            } else {
                all_dirs(path)
            };
            for dir in found {
                self.git_watched.insert(dir.clone());
                out.watch.push(dir);
            }
        } else if !path.exists() && self.git_watched.contains(path) {
            let gone: Vec<PathBuf> = self
                .git_watched
                .iter()
                .filter(|dir| dir.starts_with(path))
                .cloned()
                .collect();
            for dir in gone {
                self.git_watched.remove(&dir);
                out.unwatch.push(dir);
            }
        }
    }

    /// Whether a worktree change can matter to Git, adopting directories that
    /// appeared and forgetting those that disappeared. Only directories are
    /// judged by the ignore rules: a file in a known directory always counts,
    /// since a tracked file can match an ignore pattern (`git add -f`).
    fn track_worktree(&mut self, path: &Path, listings: &mut Listings, out: &mut Absorbed) -> bool {
        let Ok(relative) = path.strip_prefix(&self.worktree) else {
            return false;
        };
        if relative.as_os_str().is_empty() {
            return true;
        }
        // Nested repositories' internals; this worktree's own Git dir is
        // handled by `track_git_dir`.
        if relative.components().any(|part| part.as_os_str() == ".git") {
            return false;
        }
        let Some(parent) = path.parent() else {
            return false;
        };
        let Ok(metadata) = std::fs::symlink_metadata(path) else {
            // Gone: relevant when Git could see it, i.e. when the nearest
            // directory still on disk is not ignored.
            if self.dirs.contains(path) {
                self.forget(path, out);
            }
            return path
                .ancestors()
                .skip(1)
                .find(|ancestor| ancestor.exists())
                .is_some_and(|ancestor| self.ensure_known(ancestor, listings, out));
        };
        if !self.ensure_known(parent, listings, out) {
            return false;
        }
        // A symlink is never followed: its target may be anywhere.
        if !metadata.is_dir() {
            return true;
        }
        if self.dirs.contains(path) {
            // An event naming a known directory: it may have been deleted
            // and recreated within this batch (a checkout does that), which
            // drops its inotify watch. Index and watch it afresh.
            if self.strategy == Strategy::PerDirectory {
                self.forget(path, out);
                self.adopt(path, out);
            }
            return true;
        }
        if !listings.visible(parent, path) {
            return false;
        }
        self.adopt(path, out);
        true
    }

    /// Make sure `dir` is a known directory, adopting the chain of new,
    /// non-ignored directories above it. False when `dir` is ignored.
    fn ensure_known(&mut self, dir: &Path, listings: &mut Listings, out: &mut Absorbed) -> bool {
        if self.dirs.contains(dir) {
            return true;
        }
        let Some(parent) = dir.parent() else {
            return false;
        };
        if !dir.starts_with(&self.worktree) || !self.ensure_known(parent, listings, out) {
            return false;
        }
        if !is_real_dir(dir) || !listings.visible(parent, dir) {
            return false;
        }
        self.adopt(dir, out);
        true
    }

    /// Know `dir`; with per-directory watches, its whole non-ignored subtree,
    /// since inotify reports nothing from a directory before it is watched.
    fn adopt(&mut self, dir: &Path, out: &mut Absorbed) {
        if self.strategy == Strategy::Tree {
            self.dirs.insert(dir.to_path_buf());
            return;
        }
        for found in scan_dirs(dir) {
            if self.dirs.insert(found.clone()) {
                out.watch.push(found);
            }
        }
    }

    fn forget(&mut self, dir: &Path, out: &mut Absorbed) {
        let gone: Vec<PathBuf> = self
            .dirs
            .iter()
            .filter(|known| known.starts_with(dir))
            .cloned()
            .collect();
        for known in gone {
            self.dirs.remove(&known);
            if self.strategy == Strategy::PerDirectory {
                out.unwatch.push(known);
            }
        }
    }

    /// Ignore rules changed: re-walk and diff the directory set, or with the
    /// tree strategy start discovering again.
    fn rescan(&mut self, out: &mut Absorbed) {
        if self.strategy == Strategy::Tree {
            self.dirs = HashSet::from([self.worktree.clone()]);
            return;
        }
        // Every directory is watched again, not only new paths: one may
        // have been replaced since its watch was added (watching a watched
        // directory again is harmless).
        let fresh = scan_dirs(&self.worktree);
        out.unwatch.extend(self.dirs.difference(&fresh).cloned());
        out.watch.extend(fresh.iter().cloned());
        self.dirs = fresh;
    }

    /// Directories whose watch failed: forget them so the next rescan or
    /// event retries them.
    pub(super) fn unwatched(&mut self, dirs: &[PathBuf]) {
        for dir in dirs {
            self.dirs.remove(dir);
            self.git_watched.remove(dir);
        }
    }

    /// Subdirectories created under `watched` between their walk and their
    /// watch: no event reported them. Their paths, for another `absorb`.
    pub(super) fn missed_subdirectories(&self, watched: &[PathBuf]) -> Vec<PathBuf> {
        watched
            .iter()
            .filter(|dir| self.dirs.contains(*dir))
            .filter_map(|dir| std::fs::read_dir(dir).ok())
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| !self.dirs.contains(path) && is_real_dir(path))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    impl Fixture {
        fn path(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }

        fn mkdir(&self, relative: &str) -> PathBuf {
            let path = self.path(relative);
            std::fs::create_dir_all(&path).unwrap();
            path
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.path(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, contents).unwrap();
            path
        }

        fn tree(&self, strategy: Strategy) -> WatchTree {
            WatchTree::scan(self.root.clone(), vec![self.path(".git")], strategy)
        }
    }

    /// A repository with a 50-package `node_modules/`, a `target/` and an
    /// ignored `*.log` pattern.
    fn repo() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        let fixture = Fixture { _dir: dir, root };
        fixture.write(".gitignore", "node_modules/\ntarget/\n*.log\n");
        fixture.write("src/lib/mod.rs", "");
        for package in 0..50 {
            fixture.write(&format!("node_modules/pkg{package}/lib/index.js"), "");
        }
        fixture.mkdir("target/debug/build");
        fixture
    }

    #[test]
    fn per_directory_watches_skip_ignored_trees() {
        let fixture = repo();
        let tree = fixture.tree(Strategy::PerDirectory);
        let all = all_dirs(&fixture.root).len();
        // root, src, src/lib + the Git dir, its info/ and refs/{,heads,tags}.
        assert_eq!(tree.watch_count(), 8, "{:?}", tree.initial_watches());
        assert!(all > 100, "the fixture has {all} directories");
        let watched: Vec<PathBuf> = tree.initial_watches().into_iter().map(|(p, _)| p).collect();
        assert!(watched.contains(&fixture.path("src/lib")));
        assert!(watched.contains(&fixture.path(".git/info")));
        assert!(watched.contains(&fixture.path(".git/refs/heads")));
        assert!(!watched
            .iter()
            .any(|path| path.starts_with(fixture.path("node_modules"))));
        assert!(!watched.contains(&fixture.path(".git/objects")));
    }

    #[test]
    fn tree_strategy_keeps_one_recursive_watch() {
        let fixture = repo();
        let tree = fixture.tree(Strategy::Tree);
        assert_eq!(
            tree.initial_watches(),
            vec![(fixture.root.clone(), RecursiveMode::Recursive)]
        );
        assert_eq!(tree.watch_count(), 1);
    }

    #[test]
    fn ignored_paths_are_not_relevant() {
        for strategy in [Strategy::PerDirectory, Strategy::Tree] {
            let fixture = repo();
            let mut tree = fixture.tree(strategy);
            let ignored = [
                fixture.write("node_modules/pkg1/lib/index.js", "changed"),
                fixture.write("target/debug/build/out.o", "noise"),
            ];
            let absorbed = tree.absorb(&ignored);
            assert!(absorbed.relevant.is_empty(), "{strategy:?}: {absorbed:?}");
            let source = fixture.write("src/lib/mod.rs", "changed");
            let head = fixture.path(".git/HEAD");
            let absorbed = tree.absorb(&[source.clone(), head.clone()]);
            assert_eq!(absorbed.relevant, vec![head, source], "{strategy:?}");
        }
    }

    /// `git status` reports a tracked file whatever the ignore rules say, so
    /// a file matching one (`*.log` added with `-f`) still refreshes.
    #[test]
    fn files_matching_an_ignore_pattern_in_known_directories_count() {
        for strategy in [Strategy::PerDirectory, Strategy::Tree] {
            let fixture = repo();
            let mut tree = fixture.tree(strategy);
            let tracked_log = fixture.write("src/kept.log", "edited");
            assert_eq!(
                tree.absorb(std::slice::from_ref(&tracked_log)).relevant,
                vec![tracked_log]
            );
        }
    }

    /// The tree strategy starts without a walk and learns directories from
    /// events, deletions inside a directory it has not seen yet included.
    #[test]
    fn tree_strategy_discovers_directories_lazily() {
        let fixture = repo();
        let mut tree = fixture.tree(Strategy::Tree);
        assert_eq!(tree.dirs.len(), 1);
        let gone = fixture.path("src/lib/mod.rs");
        std::fs::remove_file(&gone).unwrap();
        assert_eq!(
            tree.absorb(std::slice::from_ref(&gone)).relevant,
            vec![gone]
        );
        assert!(tree.dirs.contains(&fixture.path("src/lib")));
        let ignored_gone = fixture.path("node_modules/pkg3/lib/index.js");
        std::fs::remove_file(&ignored_gone).unwrap();
        assert!(tree.absorb(&[ignored_gone]).relevant.is_empty());
    }

    #[test]
    fn a_rule_file_inside_an_ignored_directory_triggers_no_rescan() {
        let fixture = repo();
        let mut tree = fixture.tree(Strategy::PerDirectory);
        let cache_rules = fixture.write("node_modules/.cache/.gitignore", "*\n");
        fixture.mkdir("target/fresh");
        let absorbed = tree.absorb(&[cache_rules]);
        assert!(absorbed.relevant.is_empty());
        assert!(absorbed.watch.is_empty(), "rescanned: {:?}", absorbed.watch);
    }

    #[test]
    fn symlinked_directories_are_not_followed() {
        let fixture = repo();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("deep/tree")).unwrap();
        let link = fixture.path("src/linked");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let mut tree = fixture.tree(Strategy::PerDirectory);
        let absorbed = tree.absorb(std::slice::from_ref(&link));
        assert_eq!(absorbed.relevant, vec![link]);
        assert!(absorbed.watch.is_empty(), "followed: {:?}", absorbed.watch);
    }

    #[test]
    fn a_lost_event_queue_rescans_and_refreshes() {
        let fixture = repo();
        let mut tree = fixture.tree(Strategy::PerDirectory);
        fixture.mkdir("src/missed");
        let absorbed = tree.rescan_all();
        assert_eq!(absorbed.relevant, vec![fixture.root.clone()]);
        // Every directory is watched again: any may have been replaced while
        // events were lost.
        assert!(absorbed.watch.contains(&fixture.path("src/missed")));
        assert!(absorbed.watch.contains(&fixture.path("src/lib")));
    }

    /// A checkout deletes and recreates a directory within one batch: the
    /// new directory has a new inode and no watch, though its path is known.
    #[test]
    fn a_directory_recreated_within_a_batch_is_watched_again() {
        let fixture = repo();
        let mut tree = fixture.tree(Strategy::PerDirectory);
        std::fs::remove_dir_all(fixture.path("src/lib")).unwrap();
        fixture.mkdir("src/lib/inner");
        let absorbed = tree.absorb(&[fixture.path("src/lib")]);
        assert!(
            absorbed.watch.contains(&fixture.path("src/lib")),
            "{absorbed:?}"
        );
        assert!(absorbed.watch.contains(&fixture.path("src/lib/inner")));
    }

    /// A commit inside a submodule changes no worktree file: only its Git
    /// dir under `.git/modules/` (here two segments deep) shows it.
    #[test]
    fn submodule_git_dirs_are_watched() {
        let fixture = repo();
        let module = fixture.mkdir(".git/modules/libs/core");
        std::fs::write(module.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fixture.mkdir(".git/modules/libs/core/refs/heads");
        fixture.mkdir(".git/modules/libs/core/objects/aa");
        let tree = fixture.tree(Strategy::PerDirectory);
        let watched: Vec<PathBuf> = tree.initial_watches().into_iter().map(|(p, _)| p).collect();
        assert!(watched.contains(&module));
        assert!(watched.contains(&fixture.path(".git/modules/libs/core/refs/heads")));
        assert!(!watched.contains(&fixture.path(".git/modules/libs/core/objects/aa")));
    }

    #[test]
    fn subdirectories_created_after_an_adoption_walk_are_found() {
        let fixture = repo();
        let tree = fixture.tree(Strategy::PerDirectory);
        let late = fixture.mkdir("src/lib/late");
        assert_eq!(
            tree.missed_subdirectories(&[fixture.path("src/lib")]),
            vec![late]
        );
    }

    #[test]
    fn new_directories_are_watched_unless_ignored() {
        let fixture = repo();
        let mut tree = fixture.tree(Strategy::PerDirectory);
        let file = fixture.write("src/feature/deep/a.rs", "");
        fixture.mkdir("node_modules/fresh-package/dist");
        let absorbed = tree.absorb(&[file.clone(), fixture.path("node_modules/fresh-package")]);
        assert_eq!(absorbed.relevant, vec![file]);
        let mut watch = absorbed.watch;
        watch.sort();
        assert_eq!(
            watch,
            vec![
                fixture.path("src/feature"),
                fixture.path("src/feature/deep")
            ]
        );
    }

    #[test]
    fn deleted_paths_stay_relevant_and_release_their_watches() {
        let fixture = repo();
        let mut tree = fixture.tree(Strategy::PerDirectory);
        std::fs::remove_dir_all(fixture.path("src/lib")).unwrap();
        let absorbed = tree.absorb(&[fixture.path("src/lib/mod.rs"), fixture.path("src/lib")]);
        assert_eq!(absorbed.relevant.len(), 2);
        assert_eq!(absorbed.unwatch, vec![fixture.path("src/lib")]);
        std::fs::remove_dir_all(fixture.path("node_modules/pkg2")).unwrap();
        let absorbed = tree.absorb(&[fixture.path("node_modules/pkg2/lib/index.js")]);
        assert!(absorbed.relevant.is_empty());
    }

    #[test]
    fn gitignore_changes_rescan_the_tree() {
        let fixture = repo();
        let mut tree = fixture.tree(Strategy::PerDirectory);
        let rules = fixture.write(".gitignore", "node_modules/\n*.log\nsrc/lib/\n");
        let absorbed = tree.absorb(std::slice::from_ref(&rules));
        assert_eq!(absorbed.relevant, vec![rules]);
        assert_eq!(absorbed.unwatch, vec![fixture.path("src/lib")]);
        for now_visible in ["target", "target/debug", "target/debug/build"] {
            assert!(
                absorbed.watch.contains(&fixture.path(now_visible)),
                "{now_visible}"
            );
        }
        assert!(!absorbed.watch.contains(&fixture.path("src/lib")));
    }

    #[test]
    fn new_ref_directories_are_followed() {
        let fixture = repo();
        let mut tree = fixture.tree(Strategy::PerDirectory);
        let namespace = fixture.mkdir(".git/refs/heads/feature");
        let absorbed = tree.absorb(std::slice::from_ref(&namespace));
        assert_eq!(absorbed.relevant, vec![namespace.clone()]);
        assert_eq!(absorbed.watch, vec![namespace]);
    }

    /// A project registered on a monorepo subfolder still honors the rules of
    /// the checkout root above it.
    #[test]
    fn a_subfolder_worktree_honors_parent_gitignore_files() {
        let fixture = repo();
        fixture.write("packages/app/node_modules/x/index.js", "");
        fixture.write("packages/app/src/main.ts", "");
        let tree = WatchTree::scan(
            fixture.path("packages/app"),
            vec![fixture.path(".git")],
            Strategy::PerDirectory,
        );
        assert!(tree.dirs.contains(&fixture.path("packages/app/src")));
        assert!(!tree
            .dirs
            .contains(&fixture.path("packages/app/node_modules")));
    }
}
