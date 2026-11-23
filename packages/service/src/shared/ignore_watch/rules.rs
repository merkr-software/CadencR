//! Git's ignore rules as a matcher for single paths, agreeing with the
//! gitignore-aware walks of [`super::walk`]: nested `.gitignore` files (each
//! relative to its own directory, the deepest match winning), the
//! repository's `info/exclude`, then the global excludes file
//! (`core.excludesFile`). Nothing is ignored outside a Git repository, and no
//! rule above the repository root applies.
//!
//! Rules are read lazily, one directory at a time, and kept until
//! [`GitIgnoreRules::rules_file_changed`] says a directory's `.gitignore`
//! changed: answering a question costs no walk of the tree. Whether a
//! directory holds a repository is checked again on every question (one
//! stat), so a `git init` or a removed `.git` is seen at once. A
//! repository's `info/exclude` and the global excludes file are read once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use tracing::warn;

/// What one directory contributes to the rules.
struct DirRules {
    /// Its `.gitignore`, rooted at the directory.
    gitignore: Option<Gitignore>,
    /// Its repository's `info/exclude` when the directory holds a `.git`;
    /// `Some(None)` for a repository without one.
    repository: Option<Option<Gitignore>>,
}

type DirCache = HashMap<PathBuf, Arc<DirRules>>;

/// The rules of the directories from a path's parent up to its repository
/// root, deepest first: the last one is the repository's.
type Chain = Vec<Arc<DirRules>>;

pub struct GitIgnoreRules {
    global: Gitignore,
    dirs: Mutex<DirCache>,
}

impl Default for GitIgnoreRules {
    fn default() -> Self {
        Self::new()
    }
}

impl GitIgnoreRules {
    /// Reads the global excludes file now; directory rules come on demand.
    pub fn new() -> Self {
        let (global, error) = Gitignore::global();
        if let Some(error) = error {
            // Git itself skips a line it cannot parse and keeps the rest; a
            // walk does the same, so the two stay in agreement.
            warn!(%error, "global gitignore: skipping unreadable rules");
        }
        Self {
            global,
            dirs: Mutex::new(HashMap::new()),
        }
    }

    /// Whether `path` itself matches an ignore rule. A path inside an
    /// ignored directory may not: see [`Self::is_ignored_or_ancestor`].
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        let Some(parent) = path.parent() else {
            return false;
        };
        self.repository_chain(parent)
            .is_some_and(|chain| self.matches(path, is_dir, &chain))
    }

    /// Whether Git ignores `path`: it or one of its directories below its
    /// repository root matches. The root and what lies above it are never
    /// judged, as a walk never judges where it starts: a worktree inside a
    /// directory its enclosing repository ignores is not ignored.
    pub fn is_ignored_or_ancestor(&self, path: &Path, is_dir: bool) -> bool {
        let Some(parent) = path.parent() else {
            return false;
        };
        let Some(chain) = self.repository_chain(parent) else {
            return false;
        };
        let dirs: Vec<&Path> = parent.ancestors().take(chain.len()).collect();
        // Below the root, shallowest first: `dirs[i]` is judged by the
        // rules of the directories above it.
        (0..chain.len() - 1)
            .rev()
            .any(|index| self.matches(dirs[index], true, &chain[index + 1..]))
            || self.matches(path, is_dir, &chain)
    }

    /// `path` is a `.gitignore` that changed: drop what was read from its
    /// directory.
    pub fn rules_file_changed(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            self.lock().remove(dir);
        }
    }

    /// Whether the rules of `chain` (deepest first, the repository's last)
    /// ignore `path`, in Git's precedence: the deepest `.gitignore` that
    /// matches, then `info/exclude`, then the global excludes.
    fn matches(&self, path: &Path, is_dir: bool, chain: &[Arc<DirRules>]) -> bool {
        let nested = chain
            .iter()
            .filter_map(|rules| rules.gitignore.as_ref())
            .map(|gitignore| gitignore.matched(path, is_dir))
            .find(|found| !found.is_none());
        if let Some(found) = nested {
            return found.is_ignore();
        }
        let exclude = chain
            .last()
            .and_then(|repository| repository.repository.as_ref())
            .and_then(Option::as_ref)
            .map(|exclude| exclude.matched(path, is_dir))
            .filter(|found| !found.is_none());
        match exclude {
            Some(found) => found.is_ignore(),
            None => self.global.matched(path, is_dir).is_ignore(),
        }
    }

    /// The rules from `start` up to its repository, or `None` outside one.
    /// Read under one lock, so rules read before a change cannot be cached
    /// after it.
    fn repository_chain(&self, start: &Path) -> Option<Chain> {
        let mut dirs = self.lock();
        let chain = cached_chain(&mut dirs, start);
        let root = start.ancestors().nth(chain.len() - 1)?;
        let found = chain.last().is_some_and(|rules| rules.repository.is_some());
        if found && holds_repository(root) {
            return Some(chain);
        }
        // A repository appeared or went away since these were read.
        let stale: Vec<&Path> = start
            .ancestors()
            .take(chain.len())
            .filter(|dir| {
                dirs.get(*dir)
                    .is_some_and(|rules| rules.repository.is_some() != holds_repository(dir))
            })
            .collect();
        if stale.is_empty() {
            return None;
        }
        for dir in stale {
            dirs.remove(dir);
        }
        let chain = cached_chain(&mut dirs, start);
        chain
            .last()
            .is_some_and(|rules| rules.repository.is_some())
            .then_some(chain)
    }

    fn lock(&self) -> MutexGuard<'_, DirCache> {
        self.dirs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The rules from `start` upwards, up to the first repository or `/`.
fn cached_chain(dirs: &mut DirCache, start: &Path) -> Chain {
    let mut chain = Vec::new();
    for dir in start.ancestors() {
        let rules = match dirs.get(dir) {
            Some(rules) => rules.clone(),
            None => {
                let rules = Arc::new(read_dir_rules(dir));
                dirs.insert(dir.to_path_buf(), rules.clone());
                rules
            }
        };
        let is_repository = rules.repository.is_some();
        chain.push(rules);
        if is_repository {
            break;
        }
    }
    chain
}

fn holds_repository(dir: &Path) -> bool {
    dir.join(".git").exists() || dir.join(".jj").exists()
}

fn read_dir_rules(dir: &Path) -> DirRules {
    let gitignore = read_rules(dir, &dir.join(".gitignore"));
    let repository = holds_repository(dir).then(|| {
        common_git_dir(&dir.join(".git")).and_then(|git| read_rules(dir, &git.join("info/exclude")))
    });
    DirRules {
        gitignore,
        repository,
    }
}

/// The rules in `file`, relative to `root`; `None` when there is no file.
fn read_rules(root: &Path, file: &Path) -> Option<Gitignore> {
    if !file.is_file() {
        return None;
    }
    let mut builder = GitignoreBuilder::new(root);
    if let Some(error) = builder.add(file) {
        // As Git does, an unparsable line is skipped and the rest applies.
        warn!(path = %file.display(), %error, "gitignore: skipping unreadable rules");
    }
    match builder.build() {
        Ok(rules) => Some(rules),
        Err(error) => {
            warn!(path = %file.display(), %error, "gitignore: rules not applied");
            None
        }
    }
}

/// The Git dir holding `info/exclude`: `.git` itself, or for a linked
/// worktree (a `.git` file) the common dir its `gitdir` points into.
fn common_git_dir(dot_git: &Path) -> Option<PathBuf> {
    if dot_git.is_dir() {
        return Some(dot_git.to_path_buf());
    }
    let contents = std::fs::read_to_string(dot_git).ok()?;
    let git_dir = PathBuf::from(contents.lines().next()?.strip_prefix("gitdir: ")?);
    let common = std::fs::read_to_string(git_dir.join("commondir")).ok()?;
    let common = PathBuf::from(common.lines().next()?);
    Some(if common.is_relative() {
        git_dir.join(common)
    } else {
        common
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]);
        (dir, root)
    }

    #[test]
    fn a_nested_gitignore_is_relative_to_its_own_directory() {
        let (_dir, root) = repo();
        write(&root.join("packages/app/.gitignore"), "/build\n");
        write(&root.join("packages/app/build/out.js"), "");
        write(&root.join("build/keep.js"), "");
        let rules = GitIgnoreRules::new();
        assert!(rules.is_ignored(&root.join("packages/app/build"), true));
        assert!(rules.is_ignored_or_ancestor(&root.join("packages/app/build/out.js"), false));
        assert!(!rules.is_ignored(&root.join("build"), true));
        assert!(!rules.is_ignored_or_ancestor(&root.join("build/keep.js"), false));
    }

    #[test]
    fn the_deepest_rule_wins_and_an_ignored_directory_hides_its_contents() {
        let (_dir, root) = repo();
        write(&root.join(".gitignore"), "*.log\nvendor/\n");
        write(&root.join("app/.gitignore"), "!keep.log\n");
        write(&root.join("vendor/.gitignore"), "!*\n");
        let rules = GitIgnoreRules::new();
        assert!(!rules.is_ignored(&root.join("app/keep.log"), false));
        assert!(rules.is_ignored(&root.join("app/drop.log"), false));
        assert!(!rules.is_ignored(&root.join("vendor/lib.rs"), false));
        assert!(rules.is_ignored_or_ancestor(&root.join("vendor/lib.rs"), false));
    }

    #[test]
    fn info_exclude_applies_and_rules_above_the_repository_do_not() {
        let (_dir, root) = repo();
        write(&root.join(".git/info/exclude"), "scratch/\n");
        write(&root.parent().unwrap().join(".gitignore"), "src/\n");
        let rules = GitIgnoreRules::new();
        assert!(rules.is_ignored(&root.join("scratch"), true));
        assert!(!rules.is_ignored(&root.join("src"), true));
    }

    #[test]
    fn nothing_is_ignored_outside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        write(&root.join(".gitignore"), "*.log\n");
        assert!(!GitIgnoreRules::new().is_ignored(&root.join("a.log"), false));
    }

    #[test]
    fn a_linked_worktree_reads_the_common_info_exclude() {
        let (_dir, root) = repo();
        git(
            &root,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        write(&root.join(".git/info/exclude"), "local-notes/\n");
        let linked = root.parent().unwrap().join("linked");
        git(&root, &["worktree", "add", "-q", linked.to_str().unwrap()]);
        let rules = GitIgnoreRules::new();
        assert!(rules.is_ignored(&linked.join("local-notes"), true));
    }

    /// A worktree inside a directory its enclosing repository ignores (as
    /// `<repo>/.worktrees/x` or `<repo>/.claude/worktrees/x`) keeps its own
    /// rules: the enclosing repository's never reach past its root.
    #[test]
    fn an_enclosing_repository_never_ignores_a_nested_one() {
        let (_dir, outer) = repo();
        write(&outer.join(".gitignore"), ".worktrees/\n");
        let inner = outer.join(".worktrees/feature");
        std::fs::create_dir_all(&inner).unwrap();
        git(&inner, &["init", "-q"]);
        write(&inner.join("src/main.rs"), "");
        let rules = GitIgnoreRules::new();
        assert!(!rules.is_ignored_or_ancestor(&inner.join("src/main.rs"), false));
        assert!(
            rules.is_ignored(&outer.join(".worktrees"), true),
            "the outer repository still ignores the directory holding it"
        );
    }

    #[test]
    fn a_repository_created_or_removed_later_is_seen() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        write(&root.join(".gitignore"), "out/\n");
        let rules = GitIgnoreRules::new();
        assert!(!rules.is_ignored(&root.join("out"), true));
        git(&root, &["init", "-q"]);
        assert!(
            rules.is_ignored(&root.join("out"), true),
            "git init is seen"
        );
        std::fs::remove_dir_all(root.join(".git")).unwrap();
        assert!(
            !rules.is_ignored(&root.join("out"), true),
            "a removed .git is seen"
        );
    }

    #[test]
    fn a_changed_gitignore_is_read_again() {
        let (_dir, root) = repo();
        let rules = GitIgnoreRules::new();
        assert!(!rules.is_ignored(&root.join("out"), true));
        write(&root.join(".gitignore"), "out/\n");
        assert!(
            !rules.is_ignored(&root.join("out"), true),
            "rules are cached"
        );
        rules.rules_file_changed(&root.join(".gitignore"));
        assert!(rules.is_ignored(&root.join("out"), true));
    }

    /// Every path of `root` (`.git` aside), and those the watch walk keeps.
    fn walked(root: &Path) -> (BTreeSet<PathBuf>, BTreeSet<PathBuf>) {
        let mut all = ignore::WalkBuilder::new(root);
        all.standard_filters(false)
            .filter_entry(|entry| entry.file_name() != ".git");
        let all = all
            .build()
            .map(|entry| entry.unwrap().into_path())
            .collect();
        let kept = super::super::walk::gitignore_walker(root)
            .build()
            .map(|entry| entry.unwrap().into_path())
            .collect();
        (all, kept)
    }

    /// The single-path rules and the watcher's walk agree on every path,
    /// the global excludes file of an isolated `HOME` included. Runs in a
    /// child process, since the global rules come from `HOME`.
    #[test]
    fn the_rules_agree_with_the_watch_walk_including_global_excludes() {
        use crate::shared::test_env::{home_with_global_excludes, is_rerun_child, rerun_in_child};
        if !is_rerun_child() {
            let home = home_with_global_excludes(".vscode/\n*.swp\n");
            rerun_in_child(
                concat!(
                    module_path!(),
                    "::the_rules_agree_with_the_watch_walk_including_global_excludes"
                ),
                &[("HOME", home.path().as_os_str())],
                &["XDG_CONFIG_HOME"],
            );
            return;
        }
        let (_dir, root) = repo();
        write(
            &root.join(".gitignore"),
            "node_modules/\n*.log\n!keep.log\n",
        );
        write(&root.join(".git/info/exclude"), "scratch/\n");
        write(&root.join("packages/app/.gitignore"), "/build\n");
        for file in [
            ".vscode/settings.json",
            "notes.swp",
            "node_modules/pkg/index.js",
            "scratch/todo.md",
            "packages/app/build/out.js",
            "packages/app/src/build/keep.ts",
            "build/keep.js",
            "src/debug.log",
            "src/keep.log",
            "src/main.rs",
        ] {
            write(&root.join(file), "");
        }
        let rules = GitIgnoreRules::new();
        assert!(rules.is_ignored(&root.join(".vscode"), true));
        let (all, kept) = walked(&root);
        let visible: BTreeSet<PathBuf> = all
            .into_iter()
            .filter(|path| !rules.is_ignored_or_ancestor(path, path.is_dir()))
            .collect();
        assert_eq!(visible, kept);
        assert!(!kept.contains(&root.join(".vscode/settings.json")));
    }
}
