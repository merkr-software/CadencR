use std::path::Path;
use std::time::SystemTime;

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use crate::error::AppError;

/// A file match result with path and matched character positions.
pub struct FileMatch {
    pub path: String,
    pub positions: Vec<u32>,
    /// True when the entry is a directory (only emitted when the caller
    /// opts in via `include_dirs`).
    pub is_dir: bool,
}

/// Build the file-listing walker shared by `recent_files` and
/// `fuzzy_search_files`. We turn off the dotfile filter (the default
/// `WalkBuilder` hides `.env` along with everything else dot-prefixed)
/// and skip `.git` for cost. Gitignored env files are pulled in
/// separately by `env_file::find_env_files` at the call sites — the
/// `ignore` crate's override matcher can't be used here without dropping
/// every non-env file.
fn list_walker(project: &Path) -> ignore::Walk {
    let mut walker = ignore::WalkBuilder::new(project);
    walker
        .hidden(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    walker.build()
}

/// Return the `limit` most recently modified entries under `project_root`,
/// plus any env files (which would otherwise be hidden by `.gitignore`).
/// When `include_dirs` is set, directories are returned alongside files
/// (flagged via `FileMatch::is_dir`). `project_root` must already be canonical.
pub fn recent_files(
    project_root: &Path,
    limit: usize,
    include_dirs: bool,
) -> Result<Vec<FileMatch>, AppError> {
    let project = project_root;
    let mut entries: Vec<(String, SystemTime, bool)> = Vec::new();

    for result in list_walker(project) {
        let entry = result.map_err(|e| AppError::Internal(e.to_string()))?;
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(true);
        if is_dir && !include_dirs {
            continue;
        }

        let relative = entry
            .path()
            .strip_prefix(project)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .to_string_lossy()
            .to_string();
        if relative.is_empty() {
            continue; // the project root itself
        }

        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);

        entries.push((relative, mtime, is_dir));
    }

    // Merge in env files that the standard walk missed because they're
    // gitignored. We resolve mtime so they sort naturally alongside the
    // rest.
    let mut seen: std::collections::HashSet<String> =
        entries.iter().map(|(p, _, _)| p.clone()).collect();
    for rel in crate::shared::env_file::find_env_files(project) {
        if seen.contains(&rel) {
            continue;
        }
        let mtime = std::fs::metadata(project.join(&rel))
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        seen.insert(rel.clone());
        entries.push((rel, mtime, false));
    }

    entries.sort_by(|a, b| b.1.cmp(&a.1));
    entries.truncate(limit);

    Ok(entries
        .into_iter()
        .map(|(path, _, is_dir)| FileMatch {
            path,
            positions: vec![],
            is_dir,
        })
        .collect())
}

/// Score one candidate against the fuzzy `pattern` and push it onto
/// `scored` if it matches. Skips duplicates via `seen`. Pulled out as a
/// free function (not a closure) so the borrow checker is happy with the
/// shared `matcher`/`buf`/`seen` state being mutated across both the
/// main walk and the env-file pass.
fn try_score(
    relative: String,
    is_dir: bool,
    pattern: &Pattern,
    matcher: &mut Matcher,
    buf: &mut Vec<char>,
    seen: &mut std::collections::HashSet<String>,
    scored: &mut Vec<(String, u32, Vec<u32>, bool)>,
) {
    if !seen.insert(relative.clone()) {
        return;
    }
    let haystack = Utf32Str::new(&relative, buf);
    let mut indices = Vec::new();
    if let Some(score) = pattern.indices(haystack, matcher, &mut indices) {
        scored.push((relative, score, indices, is_dir));
    }
}

/// Fuzzy-search entries under `project_root` matching `query`.
/// Returns up to `limit` results sorted by match score, with match positions.
/// When `include_dirs` is set, directories are scored alongside files
/// (flagged via `FileMatch::is_dir`). `project_root` must already be canonical.
pub fn fuzzy_search_files(
    project_root: &Path,
    query: &str,
    limit: usize,
    include_dirs: bool,
) -> Result<Vec<FileMatch>, AppError> {
    let project = project_root;

    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut scored: Vec<(String, u32, Vec<u32>, bool)> = Vec::new();
    let mut buf = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Score the main walk + the env-file pass through a single helper so
    // we stream entries straight into the scorer instead of materialising
    // an intermediate `candidates` Vec.
    for result in list_walker(project) {
        let entry = result.map_err(|e| AppError::Internal(e.to_string()))?;
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(true);
        if is_dir && !include_dirs {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(project)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .to_string_lossy()
            .to_string();
        if relative.is_empty() {
            continue; // the project root itself
        }
        try_score(
            relative,
            is_dir,
            &pattern,
            &mut matcher,
            &mut buf,
            &mut seen,
            &mut scored,
        );
    }
    for relative in crate::shared::env_file::find_env_files(project) {
        try_score(
            relative,
            false,
            &pattern,
            &mut matcher,
            &mut buf,
            &mut seen,
            &mut scored,
        );
    }

    scored.sort_by(|a, b| b.1.cmp(&a.1));
    scored.truncate(limit);

    Ok(scored
        .into_iter()
        .map(|(path, _, positions, is_dir)| FileMatch {
            path,
            positions,
            is_dir,
        })
        .collect())
}
