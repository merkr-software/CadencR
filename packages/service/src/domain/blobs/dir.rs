//! Process-wide blob directory, set once at startup.
//!
//! Mirrors `settings_store::dir` deliberately: same OnceLock shape, same
//! derivation from the database path, same per-test isolation. Production is
//! `~/.cadencr/blobs`, alongside `database/` and `settings/`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static BLOB_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Set the blob directory. Called once from `main`; later calls are ignored.
pub fn init(dir: PathBuf) {
    let _ = BLOB_DIR.set(dir);
}

/// The active blob directory. Uninitialized non-test builds fall back to a temp
/// path rather than the real user directory, so a forgotten `init` can never
/// scatter blobs into `~/.cadencr`.
pub fn blob_dir() -> PathBuf {
    #[cfg(test)]
    {
        test_dir()
    }
    #[cfg(not(test))]
    {
        BLOB_DIR
            .get()
            .cloned()
            .unwrap_or_else(|| std::env::temp_dir().join("cadencr-blobs-uninitialized"))
    }
}

/// Unique, per-test-thread blob directory (test builds only). libtest runs each
/// test on its own OS thread, so this keeps store tests from colliding.
#[cfg(test)]
fn test_dir() -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    thread_local! {
        static DIR: PathBuf = {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("cadencr-blobs-test-{}-{n}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            dir
        };
    }
    DIR.with(Clone::clone)
}

/// Production DB layout is `<base>/database/<db>` → blobs live at
/// `<base>/blobs`. Any other layout (dev, ad-hoc CLI) gets a directory named
/// after that exact database file. Two custom databases in one directory must
/// never share a GC root, or one could remove blobs referenced only by the other.
pub fn derive_from_db_path(db_path: &str) -> PathBuf {
    let path = Path::new(db_path);
    let Some(db_dir) = path.parent() else {
        return PathBuf::from(format!("{db_path}.blobs"));
    };
    if db_dir.file_name().is_some_and(|name| name == "database") {
        if let Some(base) = db_dir.parent() {
            return base.join("blobs");
        }
    }
    let file_name = path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("cadencr.db"));
    let source_name = crate::shared::migrate::backup_source_database_file_name(path);
    let mut blob_name = source_name
        .as_deref()
        .map(std::ffi::OsString::from)
        .unwrap_or_else(|| file_name.to_os_string());
    blob_name.push(".blobs");
    db_dir.join(blob_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_production_layout() {
        assert_eq!(
            derive_from_db_path("/home/u/.cadencr/database/cadencr.db"),
            PathBuf::from("/home/u/.cadencr/blobs")
        );
    }

    #[test]
    fn derives_dev_layout_next_to_db() {
        assert_eq!(
            derive_from_db_path("/work/service/cadencr.local.db"),
            PathBuf::from("/work/service/cadencr.local.db.blobs")
        );
    }

    #[test]
    fn bare_filename_falls_back_to_a_relative_dir() {
        assert_eq!(
            derive_from_db_path("cadencr.db"),
            PathBuf::from("cadencr.db.blobs")
        );
    }

    #[test]
    fn custom_backup_reuses_the_source_database_blob_root() {
        let backup = "/work/db-637573746f6d2e6462.0.9.1.2026-08-06-10.cadencr.backup.db";
        assert_eq!(
            derive_from_db_path(backup),
            PathBuf::from("/work/custom.db.blobs")
        );
    }
}
