//! Per-test-thread scratch directories for the process-wide stores (test
//! builds only).
//!
//! libtest runs every test on its own thread, so a directory per thread keeps
//! tests that go through a global store (settings, blobs) from sharing files.
//! Each directory is a [`tempfile::TempDir`]: its name is random, so a test
//! binary never reuses what an earlier run with the same pid left behind, and
//! it is removed when the test's thread exits, so the suite leaves nothing in
//! the temp directory. Installed plugin payloads are read-only on purpose, so
//! the tree is made writable first: otherwise the removal fails half-way.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

thread_local! {
    static DIRS: RefCell<HashMap<&'static str, ScratchDir>> = RefCell::new(HashMap::new());
}

/// A [`tempfile::TempDir`] whose read-only subdirectories do not stop its
/// removal.
struct ScratchDir(tempfile::TempDir);

impl Drop for ScratchDir {
    fn drop(&mut self) {
        // Runs before the TempDir field removes the tree.
        if let Err(error) = make_writable(self.0.path()) {
            eprintln!(
                "could not clean the test directory {}: {error}",
                self.0.path().display()
            );
        }
    }
}

#[cfg(unix)]
fn make_writable(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            make_writable(&entry.path())?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn make_writable(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

/// This thread's directory for `prefix`, created on first use.
pub(crate) fn per_thread_dir(prefix: &'static str) -> PathBuf {
    DIRS.try_with(|dirs| {
        dirs.borrow_mut()
            .entry(prefix)
            .or_insert_with(|| {
                ScratchDir(
                    tempfile::Builder::new()
                        .prefix(prefix)
                        .tempdir()
                        .expect("create a per-test temp directory"),
                )
            })
            .0
            .path()
            .to_path_buf()
    })
    // Only another thread-local's destructor can get here, after this
    // thread's directories were removed: hand it a path that does not exist.
    .unwrap_or_else(|_| std::env::temp_dir().join(format!("{prefix}thread-exited")))
}

#[cfg(test)]
mod tests {
    use super::per_thread_dir;

    #[test]
    fn each_thread_gets_its_own_directory_removed_when_the_thread_exits() {
        let mine = per_thread_dir("cadencr-test-dirs-");
        assert!(mine.is_dir());
        assert_eq!(
            per_thread_dir("cadencr-test-dirs-"),
            mine,
            "stable per thread"
        );

        let other = std::thread::spawn(|| {
            let dir = per_thread_dir("cadencr-test-dirs-");
            std::fs::write(dir.join("settings.json"), "{}").unwrap();
            // Like an installed plugin payload: a read-only directory.
            let payload = dir.join("plugins/payload");
            std::fs::create_dir_all(&payload).unwrap();
            std::fs::write(payload.join("tab.js"), "").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(&payload, std::fs::Permissions::from_mode(0o555)).unwrap();
            }
            dir
        })
        .join()
        .unwrap();
        assert_ne!(other, mine);
        assert!(!other.exists(), "the exited thread's directory is gone");
        assert!(mine.is_dir());
    }

    #[test]
    fn names_are_random_not_derived_from_the_pid() {
        let dir = per_thread_dir("cadencr-test-dirs-");
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("cadencr-test-dirs-"));
        assert!(
            !name.contains(&std::process::id().to_string()),
            "a reused pid must not lead to a previous run's directory: {name}"
        );
    }

    #[test]
    fn prefixes_get_separate_directories() {
        assert_ne!(
            per_thread_dir("cadencr-test-dirs-a-"),
            per_thread_dir("cadencr-test-dirs-b-")
        );
    }
}
