//! Cheap entry count for `/api/editor/tree-count`.
//!
//! The editor file tree uses a hybrid loading strategy: small/medium repos
//! load the whole tracked tree up front (`tree-all`), while giant repos switch
//! to expand-on-demand. The frontend decides which mode to use from this count,
//! so it must be cheap — we reuse the same `ignore`-crate walker as
//! [`super::tree_all`] but only *count* entries, with no per-entry allocation,
//! sorting, or boundary/env-file passes.

use std::path::Path;

use crate::error::AppError;

/// Count the entries the editor tree would walk. With `exclude_gitignored`
/// the walker skips ignored sub-trees wholesale (so `node_modules`, `target`,
/// … are never descended), matching the fast `tree-all` pass. Runs the
/// blocking filesystem walk, so call it from `spawn_blocking`.
pub fn count_entries(project_root: &Path, exclude_gitignored: bool) -> Result<u64, AppError> {
    let mut walker = ignore::WalkBuilder::new(project_root);
    walker
        .hidden(false)
        .git_ignore(exclude_gitignored)
        .git_global(exclude_gitignored)
        .git_exclude(exclude_gitignored)
        .filter_entry(|entry| entry.file_name() != ".git");

    let mut count: u64 = 0;
    for result in walker.build() {
        let entry = result.map_err(|e| AppError::Internal(e.to_string()))?;
        // Skip the project root itself, mirroring `tree_all::walk_entries`.
        if entry.depth() == 0 {
            continue;
        }
        count += 1;
    }

    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `ignore` crate only applies `.gitignore` inside a git repo
    /// (`require_git` defaults to true); an empty `.git` dir is enough.
    fn init_repo(root: &Path) {
        std::fs::create_dir_all(root.join(".git")).unwrap();
    }

    #[test]
    fn excludes_gitignored_subtrees_when_requested() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(root);
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "a").unwrap();
        std::fs::write(root.join("app.ts"), "b").unwrap();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();

        // Tracked-only: `app.ts` + `.gitignore` (node_modules skipped). The
        // `.git` dir is filtered out.
        let tracked = count_entries(root, true).unwrap();
        assert_eq!(tracked, 2, "node_modules subtree must not be counted");

        // Full walk counts everything except `.git`: app.ts, .gitignore,
        // node_modules, node_modules/pkg, node_modules/pkg/index.js.
        let full = count_entries(root, false).unwrap();
        assert_eq!(full, 5);
    }
}
