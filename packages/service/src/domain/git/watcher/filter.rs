//! Path filter for raw fs events. Drops chatty `.git/` internals while
//! letting through ref/index/MERGE_MSG and any worktree path. We don't
//! enforce gitignore here — `git status` does that automatically when the
//! debouncer triggers a recompute.

use std::path::Path;

/// Return `true` when an event at `path` should trigger a recompute.
///
/// `worktree_root` is the canonicalized worktree path; `extra_git_roots`
/// are the worktree-specific gitdir and the shared common dir for linked
/// worktrees (see `debouncer::build_debouncer`). Events under any of those
/// roots are eligible after the chatty-internals filter is applied.
pub(super) fn is_relevant(
    worktree_root: &Path,
    extra_git_roots: &[std::path::PathBuf],
    path: &Path,
) -> bool {
    let _ = worktree_root;
    // Filter chatty internals first — we treat any path with `objects`,
    // `logs`, or `index.lock` after a `.git` segment as noise. This catches
    // both `<repo>/.git/objects/...` (main worktree) and
    // `<main>/.git/worktrees/<name>/objects/...` (linked worktree gitdir).
    if let Some(rest) = strip_until_git(path) {
        for comp in rest {
            let s = comp.as_os_str();
            if s == "objects" || s == "logs" {
                return false;
            }
            if s == "index.lock" {
                return false;
            }
        }
        // Anything else under `.git/` (HEAD, refs, index, MERGE_MSG, …) is
        // relevant. This holds for both worktree-specific gitdir paths and
        // shared common-dir paths.
        return true;
    }
    // No `.git` component: the path is either inside the worktree itself or
    // inside one of the extra git roots that was canonicalized without a
    // literal `.git` prefix (rare, but possible if the user points
    // GIT_DIR somewhere unusual). Either way, treat it as relevant — git
    // will sort out what actually changed when the recompute runs.
    let _ = extra_git_roots;
    true
}

/// If `path` contains a `.git` component, return the components that follow
/// it (so the caller can scan for `objects`, `logs`, `index.lock`). Returns
/// `None` if there is no `.git` segment.
fn strip_until_git(path: &Path) -> Option<Vec<std::path::Component<'_>>> {
    let mut iter = path.components();
    let mut found = false;
    for comp in iter.by_ref() {
        if comp.as_os_str() == ".git" {
            found = true;
            break;
        }
    }
    if !found {
        return None;
    }
    Some(iter.collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    #[test]
    fn is_relevant_drops_objects_and_logs() {
        let root = PathBuf::from("/repo");
        assert!(!is_relevant(
            &root,
            &[],
            &PathBuf::from("/repo/.git/objects/aa/bb")
        ));
        assert!(!is_relevant(
            &root,
            &[],
            &PathBuf::from("/repo/.git/logs/HEAD")
        ));
        assert!(!is_relevant(
            &root,
            &[],
            &PathBuf::from("/repo/.git/index.lock")
        ));
    }

    #[test]
    fn is_relevant_keeps_head_and_refs_and_index() {
        let root = PathBuf::from("/repo");
        assert!(is_relevant(&root, &[], &PathBuf::from("/repo/.git/HEAD")));
        assert!(is_relevant(
            &root,
            &[],
            &PathBuf::from("/repo/.git/refs/heads/main")
        ));
        assert!(is_relevant(&root, &[], &PathBuf::from("/repo/.git/index")));
        assert!(is_relevant(
            &root,
            &[],
            &PathBuf::from("/repo/.git/MERGE_MSG")
        ));
    }

    #[test]
    fn is_relevant_keeps_worktree_files() {
        let root = PathBuf::from("/repo");
        assert!(is_relevant(&root, &[], &PathBuf::from("/repo/src/main.rs")));
        assert!(is_relevant(&root, &[], &PathBuf::from("/repo/README.md")));
    }

    #[test]
    fn is_relevant_keeps_linked_worktree_index_and_head() {
        // Linked-worktree gitdir lives at `<main>/.git/worktrees/<name>/`;
        // the watcher needs to see `index` and `HEAD` updates there.
        let root = PathBuf::from("/main");
        let extras = vec![PathBuf::from("/main/.git/worktrees/feat")];
        assert!(is_relevant(
            &root,
            &extras,
            &PathBuf::from("/main/.git/worktrees/feat/index")
        ));
        assert!(is_relevant(
            &root,
            &extras,
            &PathBuf::from("/main/.git/worktrees/feat/HEAD")
        ));
        // index.lock under a linked worktree's gitdir is still noise.
        assert!(!is_relevant(
            &root,
            &extras,
            &PathBuf::from("/main/.git/worktrees/feat/index.lock")
        ));
    }

    #[test]
    fn is_relevant_keeps_common_dir_refs() {
        // The shared common dir's refs/ must be observed for branch/tag updates.
        let root = PathBuf::from("/main/wt-feat");
        let extras = vec![PathBuf::from("/main/.git")];
        assert!(is_relevant(
            &root,
            &extras,
            &PathBuf::from("/main/.git/refs/heads/main")
        ));
        // But not the common dir's objects/ or logs/.
        assert!(!is_relevant(
            &root,
            &extras,
            &PathBuf::from("/main/.git/objects/aa/bb")
        ));
        assert!(!is_relevant(
            &root,
            &extras,
            &PathBuf::from("/main/.git/logs/HEAD")
        ));
    }

    #[tokio::test]
    async fn linked_worktree_index_path_is_covered_by_filter() {
        let main_dir = tempfile::tempdir().unwrap();
        git_init(main_dir.path());
        std::fs::write(main_dir.path().join("seed.txt"), "seed").unwrap();
        for args in [["add", "seed.txt"].as_slice(), &["commit", "-m", "s", "-q"]] {
            Command::new("git")
                .args(args.iter().copied())
                .current_dir(main_dir.path())
                .status()
                .unwrap();
        }
        let linked_dir = tempfile::tempdir().unwrap();
        let linked_path = linked_dir.path().join("wt");
        let st = Command::new("git")
            .args([
                "worktree",
                "add",
                "-b",
                "f/wt",
                linked_path.to_str().unwrap(),
            ])
            .current_dir(main_dir.path())
            .status()
            .unwrap();
        assert!(st.success(), "git worktree add should succeed");
        let canonical_linked = std::fs::canonicalize(&linked_path).unwrap();

        let gitdir_raw = String::from_utf8(
            Command::new("git")
                .args(["rev-parse", "--git-dir"])
                .current_dir(&canonical_linked)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let gitdir_raw = gitdir_raw.trim();
        let gitdir = if Path::new(gitdir_raw).is_absolute() {
            PathBuf::from(gitdir_raw)
        } else {
            canonical_linked.join(gitdir_raw)
        };
        let gitdir = std::fs::canonicalize(&gitdir).unwrap();
        assert!(
            !gitdir.starts_with(&canonical_linked),
            "linked-worktree gitdir must live outside the worktree path: {}",
            gitdir.display()
        );
        let index_path = gitdir.join("index");
        assert!(
            is_relevant(&canonical_linked, &[gitdir.clone()], &index_path),
            "filter must accept linked-worktree index path: {}",
            index_path.display()
        );
    }

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
        Command::new("git")
            .args(["config", "commit.gpgsign", "false"])
            .current_dir(dir)
            .status()
            .unwrap();
    }
}
