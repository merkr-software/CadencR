use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::error::AppError;
use crate::shared::ignore_watch::GitIgnoreRules;

// Content search and file/directory search live in their own modules to keep
// this file focused on path validation and gitignore helpers.
#[cfg(test)]
pub use super::content_search::content_search;
pub use super::content_search::content_search_cancellable;
pub use super::file_search::{fuzzy_search_files, recent_files};

/// Validate that `relative_path` joined under `project_root` (already
/// canonical) stays within the project directory. Returns the canonical
/// absolute path.
pub fn validate_path(project_root: &Path, relative_path: &str) -> Result<PathBuf, AppError> {
    let target = project_root.join(relative_path);
    let canonical = std::fs::canonicalize(&target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(format!("Path not found: {}", target.display()))
        } else {
            AppError::BadRequest(format!("Cannot access path: {e}"))
        }
    })?;

    if !canonical.starts_with(project_root) {
        return Err(AppError::BadRequest(
            "Path is outside the project directory".to_string(),
        ));
    }

    Ok(canonical)
}

/// Validate path for writing — the file may not exist yet, so we canonicalize
/// the parent directory instead. `project_root` must already be canonical.
pub fn validate_path_for_write(
    project_root: &Path,
    relative_path: &str,
) -> Result<PathBuf, AppError> {
    let target = project_root.join(relative_path);

    let parent = target
        .parent()
        .ok_or_else(|| AppError::BadRequest("Invalid file path".to_string()))?;

    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(format!("Parent directory not found: {}", parent.display()))
        } else {
            AppError::BadRequest(format!("Cannot access path: {e}"))
        }
    })?;

    if !canonical_parent.starts_with(project_root) {
        return Err(AppError::BadRequest(
            "Path is outside the project directory".to_string(),
        ));
    }

    let file_name = target
        .file_name()
        .ok_or_else(|| AppError::BadRequest("Invalid file name".to_string()))?;

    let candidate = canonical_parent.join(file_name);
    #[cfg(unix)]
    {
        Ok(candidate)
    }
    #[cfg(not(unix))]
    {
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::BadRequest(
                "Refusing to write through a symbolic link".to_string(),
            )),
            Ok(_) => Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(candidate),
            Err(error) => Err(AppError::BadRequest(format!(
                "Cannot inspect write target: {error}"
            ))),
        }
    }
}

#[derive(Clone, Copy)]
pub enum FileWriteMode {
    CreateNew,
    Replace,
}

/// Open and write a file without ever following a final-component symlink.
/// `CreateNew` makes create-file's non-existence check atomic.
pub fn write_file_no_follow(
    path: &Path,
    contents: &[u8],
    mode: FileWriteMode,
) -> Result<(), std::io::Error> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    let create_new = matches!(mode, FileWriteMode::CreateNew);
    options
        .write(true)
        .truncate(!create_new)
        .create(!create_new);
    if create_new {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.flush()
}

/// Check if a file appears to be binary by looking for null bytes in the first 8KB.
pub fn is_binary(path: &Path) -> Result<bool, std::io::Error> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = [0u8; 8192];
    let n = file.read(&mut buf)?;
    Ok(buf[..n].contains(&0))
}

/// Git's ignore rules for an editor root, shared by the file tree and the
/// file watcher so both judge a path the same way, and the same way as the
/// watch's directory walks: nested `.gitignore` files, `info/exclude` and the
/// global excludes file, as Git applies them.
pub fn ignore_rules(project_path: &Path) -> Arc<GitIgnoreRules> {
    if let Some(rules) = lock_ignore_rules().get(project_path) {
        return rules.clone();
    }
    // Reads the git config and the global excludes file: not under the lock
    // every root's tree requests and watchers take.
    let fresh = Arc::new(GitIgnoreRules::new());
    lock_ignore_rules()
        .entry(project_path.to_path_buf())
        .or_insert(fresh)
        .clone()
}

/// A `.gitignore` under `project_path` changed: its directory's rules are
/// read again on next use. No walk of the tree.
pub fn ignore_file_changed(project_path: &Path, path: &Path) {
    ignore_rules(project_path).rules_file_changed(path);
}

/// Forget the rules read for `project_path` (its watcher stopped).
pub fn clear_ignore_rules(project_path: &Path) {
    lock_ignore_rules().remove(project_path);
}

fn lock_ignore_rules() -> MutexGuard<'static, HashMap<PathBuf, Arc<GitIgnoreRules>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<GitIgnoreRules>>>> = OnceLock::new();
    CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_ignored_without_a_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        let rules = ignore_rules(&root);
        assert!(!rules.is_ignored(&root.join("node_modules"), true));
    }

    /// A nested `.gitignore` anchors its patterns to its own directory: the
    /// former single matcher rooted every file at the project root.
    #[test]
    fn nested_rules_apply_relative_to_their_directory_after_root_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("packages/app")).unwrap();
        std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(root.join("packages/app/.gitignore"), "!keep.log\n/dist\n").unwrap();

        let rules = ignore_rules(&root);
        assert!(!rules.is_ignored(&root.join("packages/app/keep.log"), false));
        assert!(rules.is_ignored(&root.join("packages/app/drop.log"), false));
        assert!(rules.is_ignored(&root.join("packages/app/dist"), true));
        assert!(!rules.is_ignored(&root.join("dist"), true));
        clear_ignore_rules(&root);
    }

    #[test]
    fn a_changed_gitignore_is_seen_through_the_shared_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        assert!(!ignore_rules(&root).is_ignored(&root.join("out"), true));
        std::fs::write(root.join(".gitignore"), "out/\n").unwrap();
        ignore_file_changed(&root, &root.join(".gitignore"));
        assert!(ignore_rules(&root).is_ignored(&root.join("out"), true));
        clear_ignore_rules(&root);
    }
}
