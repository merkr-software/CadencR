//! A cheap identity of a settings file on disk, checked on every cache hit so
//! the cache never depends on the watcher alone (a dropped inotify event, a
//! watch that died with a replaced directory).

use std::path::Path;
use std::time::SystemTime;

/// One `stat`: size and modification time, plus on Unix the identity
/// (device and inode), mode, owner and status-change time. An atomic save
/// renames a new inode into place; a `chmod` or `chown` changes the mode or
/// owner, so a file made unreadable is re-read (and fails) instead of being
/// served from memory.
///
/// The one blind spot is an in-place edit that keeps the size within one
/// timestamp tick: nanoseconds on APFS, but a few milliseconds on Linux
/// kernels without fine-grained timestamps. The watcher still reports that
/// edit; this check only covers what the watcher misses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Fingerprint {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    uid: u32,
    #[cfg(unix)]
    ctime: (i64, i64),
}

/// What `stat` says about a settings path right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DiskState {
    Missing,
    File(Fingerprint),
}

/// `None` when the path cannot be checked (permission denied, too many open
/// files…): the caller then reads straight from disk and caches nothing.
pub(super) fn disk_state(path: &Path) -> Option<DiskState> {
    match std::fs::metadata(path) {
        Ok(metadata) => Some(DiskState::File(Fingerprint::of(&metadata))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(DiskState::Missing),
        Err(_) => None,
    }
}

impl Fingerprint {
    fn of(metadata: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            len: metadata.len(),
            // Unsupported mtime compares equal to itself: identity and size
            // still catch a replacement.
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            dev: metadata.dev(),
            #[cfg(unix)]
            ino: metadata.ino(),
            #[cfg(unix)]
            mode: metadata.mode(),
            #[cfg(unix)]
            uid: metadata.uid(),
            #[cfg(unix)]
            ctime: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_files_and_edits_are_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(disk_state(&path), Some(DiskState::Missing));

        std::fs::write(&path, "{}").unwrap();
        let first = disk_state(&path).unwrap();
        assert!(matches!(first, DiskState::File(_)));
        assert_eq!(disk_state(&path), Some(first), "stable while untouched");

        std::fs::write(&path, r#"{"theme_current":"x"}"#).unwrap();
        assert_ne!(
            disk_state(&path),
            Some(first),
            "an in-place edit changes it"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_atomic_replacement_with_the_same_size_changes_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{\"a\":1}").unwrap();
        let before = disk_state(&path).unwrap();

        let staged = dir.path().join(".settings.json.tmp");
        std::fs::write(&staged, "{\"a\":2}").unwrap();
        let staged_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        // Same size and mtime as the old file: only the inode differs.
        std::fs::File::options()
            .write(true)
            .open(&staged)
            .unwrap()
            .set_modified(staged_mtime)
            .unwrap();
        std::fs::rename(&staged, &path).unwrap();

        assert_ne!(disk_state(&path).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn a_permission_change_changes_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{}").unwrap();
        let before = disk_state(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let after = disk_state(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_ne!(after, before);
    }
}
