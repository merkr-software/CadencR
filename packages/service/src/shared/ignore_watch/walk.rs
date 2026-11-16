//! Directory walks for the gitignore-aware watch: what the ignore rules let
//! through, and which Git directories to follow.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use tracing::warn;

/// What to watch for one Git dir: itself, `info/`, `refs/**`, and the same
/// for each submodule's Git dir under `modules/`.
pub(super) fn git_dir_watches(git_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![git_dir.to_path_buf()];
    dirs.extend(all_dirs(&git_dir.join("info")));
    dirs.extend(all_dirs(&git_dir.join("refs")));
    let modules = git_dir.join("modules");
    if is_real_dir(&modules) {
        dirs.push(modules.clone());
        for module in module_git_dirs(&modules) {
            dirs.extend(git_dir_watches(&module));
        }
    }
    dirs
}

/// The submodule Git dirs under a `modules/` directory, whose names may span
/// several segments (`modules/libs/core`). A Git dir is not descended into.
pub(super) fn module_git_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_real_dir(path))
        .flat_map(|path| {
            if path.join("HEAD").is_file() {
                vec![path]
            } else {
                module_git_dirs(&path)
            }
        })
        .collect()
}

/// A directory itself, not a symlink to one.
pub(super) fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// Children of a directory that are not ignored, listed once per batch.
#[derive(Default)]
pub(super) struct Listings(HashMap<PathBuf, HashSet<PathBuf>>);

impl Listings {
    pub(super) fn visible(&mut self, dir: &Path, child: &Path) -> bool {
        if let Some(children) = self.0.get(dir) {
            return children.contains(child);
        }
        let mut walker = gitignore_walker(dir);
        walker.max_depth(Some(1));
        let children: HashSet<PathBuf> = walk(walker)
            .filter(|entry| entry.depth() == 1)
            .map(ignore::DirEntry::into_path)
            .collect();
        let visible = children.contains(child);
        self.0.insert(dir.to_path_buf(), children);
        visible
    }
}

/// A walk that skips what Git ignores, and Git dirs. `.ignore` files are a
/// ripgrep convention Git does not honor, so they are not read.
fn gitignore_walker(root: &Path) -> WalkBuilder {
    let mut walker = WalkBuilder::new(root);
    walker
        .hidden(false)
        .ignore(false)
        .parents(true)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    walker
}

fn walk(walker: WalkBuilder) -> impl Iterator<Item = ignore::DirEntry> {
    walker.build().filter_map(|entry| {
        entry
            .map_err(|error| warn!(%error, "file watcher: skipping an unreadable path"))
            .ok()
    })
}

fn is_dir_entry(entry: &ignore::DirEntry) -> bool {
    entry.file_type().is_some_and(|kind| kind.is_dir())
}

/// Non-ignored directories under `root`, `root` included.
pub(super) fn scan_dirs(root: &Path) -> HashSet<PathBuf> {
    walk(gitignore_walker(root))
        .filter(is_dir_entry)
        .map(ignore::DirEntry::into_path)
        .collect()
}

/// Every directory under `root`, `root` included; empty when it is missing.
pub(super) fn all_dirs(root: &Path) -> Vec<PathBuf> {
    if !is_real_dir(root) {
        return Vec::new();
    }
    let mut walker = WalkBuilder::new(root);
    walker.standard_filters(false).follow_links(false);
    walk(walker)
        .filter(is_dir_entry)
        .map(ignore::DirEntry::into_path)
        .collect()
}
