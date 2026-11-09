//! Recursive listing for `/api/editor/tree-all`.
//!
//! The fast pass (`exclude_gitignored=true`, used by the editor) walks the
//! non-ignored tree but treats every ignored directory as a *leaf*: ignored
//! files and the top of ignored directories are shown (dimmed by the UI),
//! but we never descend into them — so `node_modules` / `target` / `dist`
//! stay cheap, while a path added to `.gitignore` stays visible instead of
//! vanishing (issue #41). Contents of an ignored directory load lazily when
//! the user expands it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::routes::FileTreeEntry;
use super::service;
use crate::error::AppError;
use crate::shared::env_file;

/// Build the recursive entry list for the `tree-all` endpoint. Runs the
/// blocking filesystem walk, so call it from `spawn_blocking`.
pub fn build_entries(
    project_root: &Path,
    exclude_gitignored: bool,
) -> Result<Vec<FileTreeEntry>, AppError> {
    // Always build the matcher so the env-file pass can mark files correctly
    // even when the walk skipped gitignored entries.
    let gitignore_matcher = service::build_gitignore(project_root);
    let mut entries = walk_entries(project_root, exclude_gitignored, gitignore_matcher.as_ref())?;

    if exclude_gitignored {
        // The walk pruned every ignored path. Re-surface the ones sitting at
        // the boundary of the non-ignored tree (issue #41) so they show
        // dimmed instead of disappearing.
        add_boundary_ignored_entries(&mut entries, project_root)?;
    }

    append_env_files(&mut entries, project_root, gitignore_matcher.as_ref());

    // Directories first, then case-insensitive name. Pierre re-sorts
    // internally, but a stable order avoids hydration jitter and keeps the
    // per-directory `tree` endpoint behaviour consistent across the surface.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// The `ignore`-crate recursive walk. When `exclude_gitignored` is true the
/// walker skips ignored entries entirely (fast — `node_modules`, `target`,
/// `dist`, … are typically gitignored). When false it traverses everything
/// and marks ignored entries. `.git` is always excluded.
fn walk_entries(
    project_root: &Path,
    exclude_gitignored: bool,
    gitignore_matcher: Option<&ignore::gitignore::Gitignore>,
) -> Result<Vec<FileTreeEntry>, AppError> {
    // The walk loop only needs a matcher when it's walking gitignored
    // entries too; otherwise the helper short-circuits to `false`.
    let gitignore_for_walk = if exclude_gitignored {
        None
    } else {
        gitignore_matcher
    };

    let mut walker = ignore::WalkBuilder::new(project_root);
    walker
        .hidden(false)
        .git_ignore(exclude_gitignored)
        .git_global(exclude_gitignored)
        .git_exclude(exclude_gitignored)
        .filter_entry(|entry| entry.file_name() != ".git");

    let mut entries: Vec<FileTreeEntry> = Vec::new();
    for result in walker.build() {
        let entry = result.map_err(|e| AppError::internal(e.to_string()))?;
        // Skip the project root itself.
        if entry.depth() == 0 {
            continue;
        }

        let path = entry.path();
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        entries.push(make_entry(project_root, path, is_dir, gitignore_for_walk)?);
    }

    Ok(entries)
}

/// Re-surface gitignored entries that sit at the boundary of the walked
/// (non-ignored) tree. The fast walk omits every ignored path; for each
/// non-ignored directory (and the root) we list its immediate children and
/// add any the walk left out — those are exactly the gitignored ones. Ignored
/// directories are added but **not** descended into; their contents load
/// lazily on expand.
fn add_boundary_ignored_entries(
    entries: &mut Vec<FileTreeEntry>,
    project_root: &Path,
) -> Result<(), AppError> {
    // Relative paths already in the non-ignored tree.
    let present = existing_paths(entries);

    // Scan the root plus every non-ignored directory.
    let mut dirs: Vec<PathBuf> = vec![project_root.to_path_buf()];
    for entry in entries.iter() {
        if entry.is_dir {
            dirs.push(project_root.join(&entry.path));
        }
    }

    let mut additions: Vec<FileTreeEntry> = Vec::new();
    for dir in dirs {
        // A directory may be unreadable (permissions) — skip it rather than
        // failing the whole tree.
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for child in read_dir.flatten() {
            let path = child.path();
            if child.file_name() == *".git" {
                continue;
            }
            let relative = match path.strip_prefix(project_root) {
                Ok(rel) => rel.to_string_lossy().to_string(),
                Err(_) => continue,
            };
            // Present in the walk → it's a non-ignored entry, already added.
            if present.contains(&relative) {
                continue;
            }
            let is_dir = child.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            additions.push(FileTreeEntry {
                name: child.file_name().to_string_lossy().to_string(),
                path: relative,
                is_dir,
                is_gitignored: true,
            });
        }
    }

    entries.extend(additions);
    Ok(())
}

/// Env files (`.env`, `.env.local`, `local.env`, …) are almost always
/// gitignored and would otherwise be invisible on the fast pass. Humans need
/// to edit them by hand, so we always surface them. Deduped against entries
/// already produced by the walk / boundary pass.
fn append_env_files(
    entries: &mut Vec<FileTreeEntry>,
    project_root: &Path,
    gitignore_matcher: Option<&ignore::gitignore::Gitignore>,
) {
    let mut seen = existing_paths(entries);
    for rel in env_file::find_env_files(project_root) {
        if seen.contains(&rel) {
            continue;
        }
        let full = project_root.join(&rel);
        let name = full
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rel.clone());
        let is_gitignored = service::is_gitignored(gitignore_matcher, &full, false);
        entries.push(FileTreeEntry {
            name,
            path: rel.clone(),
            is_dir: false,
            is_gitignored,
        });
        seen.insert(rel);
    }
}

/// The set of relative paths already represented in `entries`, used to
/// dedupe before appending boundary-ignored / env-file entries.
fn existing_paths(entries: &[FileTreeEntry]) -> HashSet<String> {
    entries.iter().map(|e| e.path.clone()).collect()
}

/// Build a `FileTreeEntry` for `path` relative to `project_root`.
fn make_entry(
    project_root: &Path,
    path: &Path,
    is_dir: bool,
    gitignore_matcher: Option<&ignore::gitignore::Gitignore>,
) -> Result<FileTreeEntry, AppError> {
    let relative = path
        .strip_prefix(project_root)
        .map_err(|e| AppError::internal(e.to_string()))?
        .to_string_lossy()
        .to_string();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| relative.clone());
    let is_gitignored = service::is_gitignored(gitignore_matcher, path, is_dir);
    Ok(FileTreeEntry {
        name,
        path: relative,
        is_dir,
        is_gitignored,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `ignore` crate only applies `.gitignore` inside a git repo
    /// (`require_git` defaults to true); an empty `.git` dir is enough.
    fn init_repo(root: &Path) {
        std::fs::create_dir_all(root.join(".git")).unwrap();
    }

    fn find<'a>(entries: &'a [FileTreeEntry], path: &str) -> Option<&'a FileTreeEntry> {
        entries.iter().find(|e| e.path == path)
    }

    #[test]
    fn newly_ignored_nested_file_stays_visible_and_dimmed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(root);
        std::fs::create_dir_all(root.join("folder")).unwrap();
        std::fs::write(root.join("folder/keep.ts"), "y").unwrap();
        std::fs::write(root.join("folder/newfile.log"), "x").unwrap();
        // The exact repro: ignore an existing file in a folder.
        std::fs::write(root.join(".gitignore"), "folder/newfile.log\n").unwrap();

        let entries = build_entries(root, true).unwrap();

        let ignored = find(&entries, "folder/newfile.log").expect("ignored file still listed");
        assert!(ignored.is_gitignored && !ignored.is_dir);
        // Its non-ignored sibling and parent are unaffected.
        assert!(!find(&entries, "folder/keep.ts").unwrap().is_gitignored);
        assert!(!find(&entries, "folder").unwrap().is_gitignored);
    }

    #[test]
    fn ignored_directory_is_shown_as_a_leaf_not_descended() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(root);
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "a").unwrap();
        std::fs::write(root.join("app.ts"), "b").unwrap();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();

        let entries = build_entries(root, true).unwrap();

        let dir = find(&entries, "node_modules").expect("ignored dir listed");
        assert!(dir.is_dir && dir.is_gitignored);
        // We must not walk into it on the fast pass.
        assert!(
            find(&entries, "node_modules/pkg").is_none(),
            "ignored directory contents must not be eagerly listed",
        );
        assert!(!find(&entries, "app.ts").unwrap().is_gitignored);
    }

    #[test]
    fn newly_ignored_root_file_stays_visible() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join("secret.txt"), "x").unwrap();
        std::fs::write(root.join("README.md"), "y").unwrap();
        std::fs::write(root.join(".gitignore"), "secret.txt\n").unwrap();

        let entries = build_entries(root, true).unwrap();

        assert!(
            find(&entries, "secret.txt")
                .expect("root file listed")
                .is_gitignored
        );
        assert!(!find(&entries, "README.md").unwrap().is_gitignored);
    }

    #[test]
    fn non_git_directory_lists_everything_without_ignoring() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // No `.git`: nothing is ignored, the tree just lists files.
        std::fs::write(root.join(".gitignore"), "secret.txt\n").unwrap();
        std::fs::write(root.join("secret.txt"), "x").unwrap();

        let entries = build_entries(root, true).unwrap();
        assert!(find(&entries, "secret.txt").is_some());
    }

    #[test]
    fn nested_gitignored_directory_is_shown_as_leaf_not_descended() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(root);
        std::fs::create_dir_all(root.join("packages/app/node_modules/pkg")).unwrap();
        std::fs::write(root.join("packages/app/node_modules/pkg/index.js"), "a").unwrap();
        std::fs::write(root.join("packages/app/src.ts"), "b").unwrap();
        std::fs::write(root.join("packages/app/.gitignore"), "node_modules/\n").unwrap();

        let entries = build_entries(root, true).unwrap();

        let dir = find(&entries, "packages/app/node_modules").expect("ignored dir listed");
        assert!(dir.is_dir && dir.is_gitignored);
        assert!(
            find(&entries, "packages/app/node_modules/pkg").is_none(),
            "nested ignored directory contents must not be eagerly listed",
        );
        assert!(!find(&entries, "packages/app/src.ts").unwrap().is_gitignored);
    }
}
