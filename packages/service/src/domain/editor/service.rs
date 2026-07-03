use std::path::{Path, PathBuf};

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

    Ok(canonical_parent.join(file_name))
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
    let gitignore_path = project_path.join(".gitignore");
    if !gitignore_path.exists() {
        return None;
    }

    let mut builder = ignore::gitignore::GitignoreBuilder::new(project_path);
    builder.add(&gitignore_path);
    builder.build().ok()
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
        .map_err(|e| AppError::Internal(e.to_string()))?;
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
