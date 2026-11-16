use std::fs;
use tempfile::TempDir;

use cadencr_service::domain::editor::service;

fn setup_test_dir() -> TempDir {
    let dir = TempDir::new().unwrap();
    let base = dir.path();

    // Create a few files with known names
    fs::create_dir_all(base.join("src")).unwrap();
    fs::write(base.join("src/main.rs"), "fn main() {}").unwrap();
    fs::write(base.join("src/lib.rs"), "pub mod foo;").unwrap();
    fs::write(base.join("README.md"), "# hello").unwrap();

    // Touch main.rs last so it's the most recent
    std::thread::sleep(std::time::Duration::from_millis(50));
    fs::write(base.join("src/main.rs"), "fn main() { updated }").unwrap();

    dir
}

fn canonical_root(dir: &TempDir) -> std::path::PathBuf {
    fs::canonicalize(dir.path()).unwrap()
}

#[test]
fn recent_files_returns_files_sorted_by_mtime() {
    let dir = setup_test_dir();
    let root = canonical_root(&dir);

    let files = service::recent_files(&root, 10, false).unwrap();

    assert!(!files.is_empty());
    // main.rs was touched last, should be first
    assert_eq!(files[0].path, "src/main.rs");
    // Files-only by default
    assert!(files.iter().all(|f| !f.is_dir));
}

#[test]
fn recent_files_respects_limit() {
    let dir = setup_test_dir();
    let root = canonical_root(&dir);

    let files = service::recent_files(&root, 1, false).unwrap();
    assert_eq!(files.len(), 1);
}

#[test]
fn recent_files_includes_dirs_when_requested() {
    let dir = setup_test_dir();
    let root = canonical_root(&dir);

    let entries = service::recent_files(&root, 50, true).unwrap();
    let src = entries.iter().find(|e| e.path == "src").expect("src dir");
    assert!(src.is_dir);
}

#[test]
fn fuzzy_search_finds_matching_files() {
    let dir = setup_test_dir();
    let root = canonical_root(&dir);

    let results = service::fuzzy_search_files(&root, "main", 10, false).unwrap();

    assert!(!results.is_empty());
    assert!(results[0].path.contains("main"));
    assert!(!results[0].positions.is_empty());
}

#[test]
fn fuzzy_search_returns_empty_for_no_match() {
    let dir = setup_test_dir();
    let root = canonical_root(&dir);

    let results = service::fuzzy_search_files(&root, "zzzznotfound", 10, false).unwrap();
    assert!(results.is_empty());
}

#[test]
fn fuzzy_search_respects_limit() {
    let dir = setup_test_dir();
    let root = canonical_root(&dir);

    let results = service::fuzzy_search_files(&root, "rs", 1, false).unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn fuzzy_search_excludes_dirs_by_default() {
    let dir = setup_test_dir();
    let root = canonical_root(&dir);

    let results = service::fuzzy_search_files(&root, "src", 10, false).unwrap();
    assert!(results.iter().all(|r| !r.is_dir));
}

#[test]
fn fuzzy_search_matches_dirs_when_requested() {
    let dir = setup_test_dir();
    let root = canonical_root(&dir);

    let results = service::fuzzy_search_files(&root, "src", 10, true).unwrap();
    let src = results.iter().find(|r| r.path == "src").expect("src dir");
    assert!(src.is_dir);
}
