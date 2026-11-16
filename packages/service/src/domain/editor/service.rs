use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::error::AppError;

// File/directory search lives in its own module to keep this file focused on
// path validation and content search.
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

/// Build a gitignore matcher for the project root using the `ignore` crate.
pub fn build_gitignore(project_path: &Path) -> Option<ignore::gitignore::Gitignore> {
    let cache_key = project_path.to_path_buf();
    if !cache_key.join(".git").exists() {
        return None;
    }

    if let Some(cached) = gitignore_cache().lock().ok()?.get(&cache_key).cloned() {
        return cached;
    }

    let matcher = build_gitignore_uncached(&cache_key);
    gitignore_cache()
        .lock()
        .ok()?
        .insert(cache_key, matcher.clone());
    matcher
}

/// Drop the cached matcher for `project_path`. The file watcher calls this
/// before filtering `.gitignore` change events so subsequent matches see the
/// latest ignore rules.
pub fn clear_gitignore_cache(project_path: &Path) {
    if let Ok(mut cache) = gitignore_cache().lock() {
        cache.remove(&project_path.to_path_buf());
    }
}

fn build_gitignore_uncached(project_path: &Path) -> Option<ignore::gitignore::Gitignore> {
    let mut builder = ignore::gitignore::GitignoreBuilder::new(project_path);
    let paths = discover_gitignore_paths(project_path);

    if paths.is_empty() {
        return None;
    }

    for path in paths {
        builder.add(path);
    }

    builder.build().ok()
}

fn discover_gitignore_paths(project_path: &Path) -> Vec<PathBuf> {
    let mut walker = ignore::WalkBuilder::new(project_path);
    walker
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|entry| entry.file_name() != ".git");

    let mut paths: Vec<PathBuf> = Vec::new();
    for entry in walker.build().flatten() {
        if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false)
            && entry.file_name() == ".gitignore"
        {
            paths.push(entry.path().to_path_buf());
        }
    }

    paths.sort_by(|a, b| path_depth(a).cmp(&path_depth(b)).then_with(|| a.cmp(b)));
    paths
}

fn path_depth(path: &Path) -> usize {
    path.components().count()
}

fn gitignore_cache() -> &'static Mutex<HashMap<PathBuf, Option<ignore::gitignore::Gitignore>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<ignore::gitignore::Gitignore>>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Search file contents for a pattern, returning matches with context lines.
/// `project_root` must already be canonical.
pub fn content_search(
    project_root: &Path,
    params: &super::routes::ContentSearchParams,
) -> Result<super::routes::ContentSearchResponse, crate::error::AppError> {
    use super::routes::{ContentMatch, ContentSearchResponse};

    if params.query.is_empty() {
        return Ok(ContentSearchResponse {
            matches: vec![],
            truncated: false,
        });
    }

    let project = project_root.to_path_buf();

    // Build regex pattern
    let mut pattern_str = if params.is_regex {
        params.query.clone()
    } else {
        regex_lite::escape(&params.query)
    };
    if params.whole_word {
        pattern_str = format!(r"\b{pattern_str}\b");
    }
    if !params.case_sensitive {
        pattern_str = format!("(?i){pattern_str}");
    }

    let regex = regex_lite::Regex::new(&pattern_str)
        .map_err(|e| AppError::BadRequest(format!("Invalid regex: {e}")))?;

    // Build walker with overrides for include/exclude
    let mut walker = ignore::WalkBuilder::new(&project);
    walker.git_ignore(params.respect_gitignore);

    let mut overrides = ignore::overrides::OverrideBuilder::new(&project);
    if let Some(ref include) = params.include_pattern {
        for glob in include.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            overrides
                .add(glob)
                .map_err(|e| AppError::BadRequest(format!("Invalid include glob: {e}")))?;
        }
    }
    if let Some(ref exclude) = params.exclude_pattern {
        for glob in exclude.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            overrides
                .add(&format!("!{glob}"))
                .map_err(|e| AppError::BadRequest(format!("Invalid exclude glob: {e}")))?;
        }
    }
    let built_overrides = overrides
        .build()
        .map_err(|e| AppError::internal(e.to_string()))?;
    walker.overrides(built_overrides);

    let limit = params.limit;
    let context_lines: usize = 5;

    // Collect matches using parallel walker for speed
    let (tx, rx) = std::sync::mpsc::channel::<ContentMatch>();
    let match_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

    walker.threads(num_cpus()).build_parallel().run(|| {
        let regex = regex.clone();
        let project = project.clone();
        let tx = tx.clone();
        let match_count = match_count.clone();

        Box::new(move |entry| {
            if match_count.load(std::sync::atomic::Ordering::Relaxed) >= limit {
                return ignore::WalkState::Quit;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };

            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(true) {
                return ignore::WalkState::Continue;
            }

            // Read file, skip binary (contains null bytes) or unreadable
            let bytes = match std::fs::read(entry.path()) {
                Ok(b) => b,
                Err(_) => return ignore::WalkState::Continue,
            };
            if bytes.contains(&0) {
                return ignore::WalkState::Continue;
            }
            let content = match std::str::from_utf8(&bytes) {
                Ok(s) => s,
                Err(_) => return ignore::WalkState::Continue,
            };

            let lines: Vec<&str> = content.lines().collect();
            let relative = entry
                .path()
                .strip_prefix(&project)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .to_string();

            for (i, line) in lines.iter().enumerate() {
                if match_count.load(std::sync::atomic::Ordering::Relaxed) >= limit {
                    break;
                }

                if let Some(m) = regex.find(line) {
                    let start = i.saturating_sub(context_lines);
                    let end = (i + context_lines + 1).min(lines.len());

                    let cm = ContentMatch {
                        path: relative.clone(),
                        line_number: (i + 1) as u64,
                        line_content: line.to_string(),
                        match_start: m.start(),
                        match_end: m.end(),
                        context_before: lines[start..i].iter().map(|s| s.to_string()).collect(),
                        context_after: lines[i + 1..end].iter().map(|s| s.to_string()).collect(),
                    };

                    match_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let _ = tx.send(cm);
                }
            }

            ignore::WalkState::Continue
        })
    });

    drop(tx);
    let matches: Vec<ContentMatch> = rx.into_iter().collect();
    let truncated = matches.len() >= limit;
    Ok(ContentSearchResponse { matches, truncated })
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Check if a path is matched by the gitignore rules.
pub fn is_gitignored(
    gitignore: Option<&ignore::gitignore::Gitignore>,
    path: &Path,
    is_dir: bool,
) -> bool {
    match gitignore {
        Some(gi) => gi.matched(path, is_dir).is_ignore(),
        None => false,
    }
}

/// Like [`is_gitignored`], but also treats a path as ignored when any of its
/// ancestor directories is ignored — e.g. a file deep inside `node_modules/`
/// matches the `node_modules/` rule even though the leaf path itself doesn't.
/// The file watcher uses this to drop churn from ignored trees (build output,
/// dependencies) that would otherwise trigger an invalidation storm.
pub fn is_gitignored_or_ancestor(
    gitignore: Option<&ignore::gitignore::Gitignore>,
    path: &Path,
    is_dir: bool,
) -> bool {
    match gitignore {
        Some(gi) => gi.matched_path_or_any_parents(path, is_dir).is_ignore(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_gitignore_returns_none_without_git_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();

        assert!(build_gitignore(root).is_none());
    }

    #[test]
    fn build_gitignore_applies_nested_rules_after_root_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("packages/app")).unwrap();
        std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(root.join("packages/app/.gitignore"), "!keep.log\n").unwrap();

        let matcher = build_gitignore(root).expect("matcher");

        assert!(!is_gitignored(
            Some(&matcher),
            &root.join("packages/app/keep.log"),
            false,
        ));
        assert!(is_gitignored(
            Some(&matcher),
            &root.join("packages/app/drop.log"),
            false,
        ));
    }
}
