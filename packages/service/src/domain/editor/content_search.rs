//! Parallel project content search with size guards, early binary sniffing,
//! and cooperative cancellation.
//!
//! A symbolic link to a file is searched, under the link's own path, when its
//! target lies inside the project (the editor opens nothing outside it). The
//! target is searched under its own path too when the walk reaches it: both
//! are paths of the project. Links to directories are not followed, so a
//! search never loops nor leaves the project.

use std::fs::Metadata;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::routes::{ContentMatch, ContentSearchParams, ContentSearchResponse};
use crate::error::AppError;
use crate::shared::discard::IgnoreClosed;

/// Skip files larger than 5 MiB before opening them.
pub(crate) const MAX_SEARCH_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Inspect only the first 8 KiB for NUL bytes before reading the rest of a file.
const BINARY_SNIFF_BYTES: usize = 8192;
/// Upper bound on returned matches even if a client asks for more.
const MAX_SEARCH_LIMIT: usize = 2000;
/// Walker threads: half the cores, at least 4 (or every core when fewer) and
/// at most 8, so a search never takes every core. Measured on a 14-core
/// M4 Pro over this repository (`content_search_thread_scaling`), 8 threads
/// search 1.75x faster than 4 (243 ms against 427 ms; 2.7 s against 4.2 s
/// with gitignored files), and 12 gain little more.
const MIN_SEARCH_THREADS: usize = 4;
const MAX_SEARCH_THREADS: usize = 8;
const CONTEXT_LINES: usize = 5;

struct SharedSearchState {
    project: PathBuf,
    line_regex: regex_lite::Regex,
    whole_file_regex: Option<regex_lite::Regex>,
    needs_crlf_guard: bool,
    limit: usize,
    match_count: AtomicUsize,
    /// Files skipped for being larger than [`MAX_SEARCH_FILE_BYTES`].
    skipped_large: AtomicU64,
    cancelled: CancellationToken,
}

#[derive(Clone)]
struct SearchContext {
    shared: Arc<SharedSearchState>,
    tx: std::sync::mpsc::Sender<ContentMatch>,
}

impl SearchContext {
    fn should_stop(&self) -> bool {
        self.shared.cancelled.is_cancelled()
            || self.shared.match_count.load(Ordering::Relaxed) >= self.shared.limit
    }

    fn process_entry(&self, entry: Result<ignore::DirEntry, ignore::Error>) -> ignore::WalkState {
        if self.should_stop() {
            return ignore::WalkState::Quit;
        }

        let Ok(entry) = entry else {
            return ignore::WalkState::Continue;
        };
        let Some((source, meta)) = self.searchable_file(&entry) else {
            return ignore::WalkState::Continue;
        };
        if meta.len() == 0 {
            return ignore::WalkState::Continue;
        }
        if meta.len() > MAX_SEARCH_FILE_BYTES {
            // Only text the search would have read counts: not a large
            // image or database, nor a link (its target counts on its own).
            if entry.path_is_symlink() || !starts_as_text(&source) {
                return ignore::WalkState::Continue;
            }
            self.shared.skipped_large.fetch_add(1, Ordering::Relaxed);
            return ignore::WalkState::Continue;
        }

        let content = match read_searchable_text(&source, meta.len(), MAX_SEARCH_FILE_BYTES) {
            Readable::Text(content) => content,
            Readable::TooLarge => {
                // Grew past the limit since it was measured.
                self.shared.skipped_large.fetch_add(1, Ordering::Relaxed);
                return ignore::WalkState::Continue;
            }
            Readable::Skipped => return ignore::WalkState::Continue,
        };

        // Fast-path whole-file check before splitting into lines.
        // `(?m)$` does not match before `\r\n`, so skip the fast path for
        // `$`-anchored regex queries on CRLF files.
        if let Some(ref whole_file_regex) = self.shared.whole_file_regex {
            let can_fast_skip = !self.shared.needs_crlf_guard || !content.contains('\r');
            if can_fast_skip && !whole_file_regex.is_match(&content) {
                return ignore::WalkState::Continue;
            }
        }

        self.scan_file_lines(&content, entry.path())
    }

    /// The file to read for `entry` and its metadata: the entry itself, or
    /// the target of a link to a file inside the project.
    fn searchable_file(&self, entry: &ignore::DirEntry) -> Option<(PathBuf, Metadata)> {
        let kind = entry.file_type()?;
        if kind.is_file() {
            return Some((entry.path().to_path_buf(), entry.metadata().ok()?));
        }
        if !kind.is_symlink() {
            return None;
        }
        // A dangling or looping link fails to resolve and is skipped; a link
        // to a directory is not resolved further.
        let meta = std::fs::metadata(entry.path()).ok()?;
        if !meta.is_file() {
            return None;
        }
        let target = std::fs::canonicalize(entry.path()).ok()?;
        target
            .starts_with(&self.shared.project)
            .then_some((target, meta))
    }

    fn scan_file_lines(&self, content: &str, path: &Path) -> ignore::WalkState {
        let lines: Vec<&str> = content.lines().collect();
        let relative = path
            .strip_prefix(&self.shared.project)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        for (i, line) in lines.iter().enumerate() {
            if self.should_stop() {
                return ignore::WalkState::Quit;
            }

            if let Some(m) = self.shared.line_regex.find(line) {
                if self.shared.match_count.fetch_add(1, Ordering::Relaxed) >= self.shared.limit {
                    return ignore::WalkState::Quit;
                }
                let start = i.saturating_sub(CONTEXT_LINES);
                let end = (i + CONTEXT_LINES + 1).min(lines.len());
                let cm = ContentMatch {
                    path: relative.clone(),
                    line_number: (i + 1) as u64,
                    line_content: (*line).to_string(),
                    match_start: m.start(),
                    match_end: m.end(),
                    context_before: lines[start..i].iter().map(|s| (*s).to_string()).collect(),
                    context_after: lines[i + 1..end].iter().map(|s| (*s).to_string()).collect(),
                };
                self.tx.send(cm).ignore_closed();
            }
        }

        ignore::WalkState::Continue
    }
}

/// [`content_search_cancellable`] that runs to completion, for tests.
#[cfg(test)]
pub fn content_search(
    project_root: &Path,
    params: &ContentSearchParams,
) -> Result<ContentSearchResponse, AppError> {
    content_search_cancellable(project_root, params, CancellationToken::new())
}

/// Search file contents for a pattern, returning matches with context lines,
/// stopping promptly whenever `cancelled` is cancelled (e.g. when the HTTP
/// client disconnects and Axum drops the handler). `project_root` must
/// already be canonical.
pub fn content_search_cancellable(
    project_root: &Path,
    params: &ContentSearchParams,
    cancelled: CancellationToken,
) -> Result<ContentSearchResponse, AppError> {
    search_with_threads(project_root, params, cancelled, search_threads())
}

fn search_with_threads(
    project_root: &Path,
    params: &ContentSearchParams,
    cancelled: CancellationToken,
    threads: usize,
) -> Result<ContentSearchResponse, AppError> {
    if params.query.is_empty() || cancelled.is_cancelled() {
        return Ok(ContentSearchResponse {
            matches: vec![],
            truncated: false,
            skipped_large_files: 0,
            max_file_bytes: MAX_SEARCH_FILE_BYTES,
        });
    }

    let (line_regex, whole_file_regex) = build_regexes(params)?;
    let mut walker = build_walker(project_root, params)?;
    let limit = params.limit.clamp(1, MAX_SEARCH_LIMIT);
    let needs_crlf_guard = params.is_regex && params.query.contains('$');

    let (tx, rx) = std::sync::mpsc::channel::<ContentMatch>();
    let ctx = SearchContext {
        shared: Arc::new(SharedSearchState {
            project: project_root.to_path_buf(),
            line_regex,
            whole_file_regex,
            needs_crlf_guard,
            limit,
            match_count: AtomicUsize::new(0),
            skipped_large: AtomicU64::new(0),
            cancelled,
        }),
        tx,
    };

    walker.threads(threads).build_parallel().run(|| {
        let ctx = ctx.clone();
        Box::new(move |entry| ctx.process_entry(entry))
    });

    let skipped_large_files = ctx.shared.skipped_large.load(Ordering::Relaxed);
    drop(ctx);
    let matches: Vec<ContentMatch> = rx.into_iter().collect();
    let truncated = matches.len() >= limit;
    Ok(ContentSearchResponse {
        matches,
        truncated,
        skipped_large_files,
        max_file_bytes: MAX_SEARCH_FILE_BYTES,
    })
}

/// Wrapping a user regex in `(?m)` does not make `\A`, `\z`, or inline flag
/// overrides like `(?-m)^` match interior lines; disable the whole-file
/// fast-path whenever those constructs appear.
fn supports_whole_file_fast_path(params: &ContentSearchParams) -> bool {
    !params.is_regex
        || (!params.query.contains(r"\A")
            && !params.query.contains(r"\z")
            && !params.query.contains("(?"))
}

fn build_regexes(
    params: &ContentSearchParams,
) -> Result<(regex_lite::Regex, Option<regex_lite::Regex>), AppError> {
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

    let line_regex = regex_lite::Regex::new(&pattern_str)
        .map_err(|e| AppError::BadRequest(format!("Invalid regex: {e}")))?;
    let whole_file_regex = if !params.is_regex {
        Some(line_regex.clone())
    } else if supports_whole_file_fast_path(params) {
        Some(
            regex_lite::Regex::new(&format!("(?m){pattern_str}"))
                .map_err(|e| AppError::BadRequest(format!("Invalid regex: {e}")))?,
        )
    } else {
        None
    };
    Ok((line_regex, whole_file_regex))
}

fn build_walker(
    project: &Path,
    params: &ContentSearchParams,
) -> Result<ignore::WalkBuilder, AppError> {
    let mut walker = ignore::WalkBuilder::new(project);
    walker.git_ignore(params.respect_gitignore);

    let mut overrides = ignore::overrides::OverrideBuilder::new(project);
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
    Ok(walker)
}

/// Whether the first [`BINARY_SNIFF_BYTES`] hold no NUL: what the search
/// reads before giving up on a binary file.
fn starts_as_text(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = Vec::with_capacity(BINARY_SNIFF_BYTES);
    file.take(BINARY_SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .is_ok_and(|_| !head.contains(&0))
}

/// What reading a file for search found.
enum Readable {
    Text(String),
    /// Larger than the limit once read.
    TooLarge,
    /// Binary, not UTF-8, or unreadable: never searched.
    Skipped,
}

/// Sniff the first 8 KiB for NUL bytes before reading the rest of the file,
/// capped at `max_bytes`.
fn read_searchable_text(path: &Path, known_len: u64, max_bytes: u64) -> Readable {
    match read_text(path, known_len, max_bytes) {
        Some(Ok(text)) => Readable::Text(text),
        Some(Err(TooLarge)) => Readable::TooLarge,
        None => Readable::Skipped,
    }
}

struct TooLarge;

fn read_text(path: &Path, known_len: u64, max_bytes: u64) -> Option<Result<String, TooLarge>> {
    let mut file = std::fs::File::open(path).ok()?;
    let max_usize = usize::try_from(max_bytes).unwrap_or(usize::MAX);
    let known_usize = usize::try_from(known_len)
        .unwrap_or(max_usize)
        .min(max_usize);
    let mut bytes = Vec::with_capacity(known_usize.min(BINARY_SNIFF_BYTES));
    (&mut file)
        .take(BINARY_SNIFF_BYTES as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.is_empty() || bytes.contains(&0) {
        return None;
    }

    if bytes.len() == BINARY_SNIFF_BYTES {
        let remaining = max_usize.saturating_sub(bytes.len());
        bytes.reserve(known_usize.saturating_sub(bytes.len()));
        file.take((remaining as u64).saturating_add(1))
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > max_usize {
            return Some(Err(TooLarge));
        }
        if bytes[BINARY_SNIFF_BYTES..].contains(&0) {
            return None;
        }
    }

    String::from_utf8(bytes).ok().map(Ok)
}

fn search_threads() -> usize {
    let cores = std::thread::available_parallelism().map_or(MIN_SEARCH_THREADS, |n| n.get());
    threads_for(cores)
}

fn threads_for(cores: usize) -> usize {
    (cores / 2)
        .clamp(MIN_SEARCH_THREADS, MAX_SEARCH_THREADS)
        .min(cores)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn default_params(query: &str) -> ContentSearchParams {
        ContentSearchParams {
            project_id: 0,
            feature_id: None,
            query: query.to_string(),
            case_sensitive: false,
            whole_word: false,
            is_regex: false,
            respect_gitignore: false,
            include_pattern: None,
            exclude_pattern: None,
            limit: 500,
        }
    }

    #[test]
    fn skips_oversized_files_without_missing_normal_ones() {
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();

        let oversized = vec![b'a'; (MAX_SEARCH_FILE_BYTES as usize) + 64];
        let mut big = oversized;
        big.extend_from_slice(b"\nNEEDLE_IN_HUGE_FILE\n");
        fs::write(root.join("huge.txt"), &big).unwrap();
        fs::write(root.join("small.txt"), "NEEDLE_IN_HUGE_FILE\n").unwrap();

        let result = content_search(&root, &default_params("NEEDLE_IN_HUGE_FILE")).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "small.txt");
        assert_eq!(result.skipped_large_files, 1, "the skip must be reported");

        // A large binary file would not have been searched anyway.
        let mut blob = b"\x00binary".to_vec();
        blob.resize(MAX_SEARCH_FILE_BYTES as usize + 64, b'b');
        fs::write(root.join("huge.bin"), &blob).unwrap();
        let result = content_search(&root, &default_params("NEEDLE_IN_HUGE_FILE")).unwrap();
        assert_eq!(
            result.skipped_large_files, 1,
            "binary files are not counted"
        );
        assert_eq!(result.max_file_bytes, MAX_SEARCH_FILE_BYTES);
        assert!(!result.truncated);
    }

    #[test]
    fn walker_threads_take_half_the_cores_within_bounds() {
        assert_eq!(threads_for(1), 1);
        assert_eq!(threads_for(2), 2);
        assert_eq!(threads_for(4), 4);
        assert_eq!(threads_for(8), 4);
        assert_eq!(threads_for(14), 7);
        assert_eq!(threads_for(32), 8);
    }

    fn paths(result: &ContentSearchResponse) -> Vec<&str> {
        let mut paths: Vec<&str> = result.matches.iter().map(|m| m.path.as_str()).collect();
        paths.sort_unstable();
        paths
    }

    /// A link to a file inside the project is searched under its own path,
    /// beside its target: both are paths the editor opens.
    #[cfg(unix)]
    #[test]
    fn searches_links_to_files_inside_the_project() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs/guide.md"), "LINKED_NEEDLE\n").unwrap();
        symlink(root.join("docs/guide.md"), root.join("GUIDE.md")).unwrap();
        symlink("docs/guide.md", root.join("relative.md")).unwrap();

        let result = content_search(&root, &default_params("LINKED_NEEDLE")).unwrap();
        assert_eq!(paths(&result), ["GUIDE.md", "docs/guide.md", "relative.md"]);
    }

    /// Links that leave the project, dangle, loop, or name a directory are
    /// not searched; none of them stalls or fails the search.
    #[cfg(unix)]
    #[test]
    fn skips_links_outside_the_project_dangling_looping_or_to_directories() {
        use std::os::unix::fs::symlink;
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), "LINK_NEEDLE\n").unwrap();
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/a.txt"), "LINK_NEEDLE\n").unwrap();
        symlink(outside.path().join("secret.txt"), root.join("outside.txt")).unwrap();
        symlink(outside.path(), root.join("outside-dir")).unwrap();
        symlink(root.join("missing.txt"), root.join("dangling.txt")).unwrap();
        symlink(root.join("loop-b"), root.join("loop-a")).unwrap();
        symlink(root.join("loop-a"), root.join("loop-b")).unwrap();
        symlink(&root, root.join("src/self")).unwrap();

        let result = content_search(&root, &default_params("LINK_NEEDLE")).unwrap();
        assert_eq!(paths(&result), ["src/a.txt"]);
    }

    /// Wall time of a search per walker thread count over
    /// `CADENCR_SEARCH_BENCH_DIR`, gitignored files included and excluded:
    /// `pnpm rust -- test -p cadencr-service --release --lib content_search_thread_scaling -- --ignored --nocapture`
    #[test]
    #[ignore = "benchmark: needs CADENCR_SEARCH_BENCH_DIR"]
    fn content_search_thread_scaling() {
        let Some(dir) = std::env::var_os("CADENCR_SEARCH_BENCH_DIR") else {
            return;
        };
        let root = fs::canonicalize(dir).unwrap();
        for (query, respect_gitignore) in [
            ("fn main", true),
            ("zzqx_no_match", true),
            ("zzqx_no_match", false),
        ] {
            let mut params = default_params(query);
            params.respect_gitignore = respect_gitignore;
            params.limit = MAX_SEARCH_LIMIT;
            // Warm the page cache once.
            search_with_threads(&root, &params, CancellationToken::new(), 8).unwrap();
            for threads in [1, 2, 4, 6, 8, 12] {
                let mut best = std::time::Duration::MAX;
                for _ in 0..3 {
                    let started = std::time::Instant::now();
                    search_with_threads(&root, &params, CancellationToken::new(), threads).unwrap();
                    best = best.min(started.elapsed());
                }
                println!("{query:?} gitignore={respect_gitignore} threads={threads}: {best:?}");
            }
        }
    }

    #[test]
    fn skips_large_binary_file_via_early_sniff() {
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();

        // NUL byte in the first 8 KiB followed by 1 MiB of text containing the needle.
        let mut binary = Vec::with_capacity(1024 * 1024);
        binary.extend_from_slice(b"ELF\x00header");
        binary.resize(BINARY_SNIFF_BYTES + 1024, b'x');
        binary.extend_from_slice(b"\nNEEDLE_AFTER_HEADER\n");
        fs::write(root.join("blob.bin"), &binary).unwrap();
        fs::write(root.join("ok.txt"), "NEEDLE_AFTER_HEADER\n").unwrap();

        let result = content_search(&root, &default_params("NEEDLE_AFTER_HEADER")).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "ok.txt");
    }

    #[test]
    fn cancellation_flag_stops_search_promptly() {
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        for index in 0..50 {
            fs::write(
                root.join(format!("file_{index}.txt")),
                "needle on line 1\nneedle on line 2\n",
            )
            .unwrap();
        }

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let result =
            content_search_cancellable(&root, &default_params("needle"), cancelled).unwrap();
        assert!(
            result.matches.is_empty(),
            "pre-cancelled search should return no matches"
        );
    }

    #[test]
    fn clamps_extreme_limit_values() {
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("a.txt"), "hit\nhit\n").unwrap();

        let mut zero_limit = default_params("hit");
        zero_limit.limit = 0;
        let result = content_search(&root, &zero_limit).unwrap();
        assert_eq!(result.matches.len(), 1, "limit=0 should clamp to 1");
        assert!(result.truncated);
    }

    #[test]
    fn regex_line_anchors_work_with_whole_file_fast_path() {
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("lines.txt"), "first\nanchor_me\nlast\n").unwrap();

        let mut params = default_params("^anchor_me$");
        params.is_regex = true;
        let result = content_search(&root, &params).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line_number, 2);
    }

    #[test]
    fn regex_non_multiline_anchors_and_inline_flags_match_interior_lines() {
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("lines.txt"), "first\nanchor_me\nlast\n").unwrap();

        for pattern in [r"\Aanchor_me", r"anchor_me\z", r"(?-m)^anchor_me"] {
            let mut params = default_params(pattern);
            params.is_regex = true;
            let result = content_search(&root, &params).unwrap();
            assert_eq!(
                result.matches.len(),
                1,
                "pattern {pattern:?} must match interior line"
            );
            assert_eq!(result.matches[0].line_number, 2);
        }
    }

    #[test]
    fn regex_dollar_anchor_matches_crlf_lines() {
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("crlf.txt"), "first\r\nanchor_me\r\nlast\r\n").unwrap();

        let mut params = default_params("^anchor_me$");
        params.is_regex = true;
        let result = content_search(&root, &params).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line_number, 2);
    }
}
