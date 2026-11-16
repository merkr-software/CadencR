//! Never open/close an existing SQLite file outside SQLite itself. On POSIX,
//! closing *any* descriptor releases this process's locks for that inode,
//! including the WAL shared-memory locks protecting other connections.
//! https://www.sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_

use anyhow::Context;
use std::io;
use std::path::Path;
use std::sync::Mutex;

// A new inode may be opened exclusively to create it privately. Serialize
// preparation so another pool cannot reach SQLite before that descriptor closes.
static PREPARATION: Mutex<()> = Mutex::new(());

pub(super) fn prepare_database(db_path: &str, create: bool) -> anyhow::Result<()> {
    if db_path == ":memory:" {
        return Ok(());
    }
    let _guard = PREPARATION
        .lock()
        .map_err(|_| anyhow::anyhow!("database preparation lock poisoned"))?;
    let path = Path::new(db_path);
    crate::remote::secure_fs::secure_app_home(path)?;
    if let Ok(data_dir) = crate::shared::app_paths::data_dir() {
        let database_dir = data_dir.join("database");
        if path.parent() == Some(database_dir.as_path()) {
            crate::remote::secure_fs::create_dir_owner_only(&database_dir)?;
        }
    }
    if let Some(parent) = path.parent() {
        crate::remote::secure_fs::create_missing_dirs(parent)?;
    }
    if create {
        create_database_exclusively(path)
            .with_context(|| format!("cannot create private database {}", path.display()))?;
    }
    secure_existing_file(path)
        .with_context(|| format!("cannot secure database {}", path.display()))?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sibling = path.as_os_str().to_owned();
        sibling.push(suffix);
        let sibling = std::path::PathBuf::from(sibling);
        match secure_existing_file(&sibling) {
            Ok(()) => {}
            // SQLite may remove a sidecar while its last connection closes.
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("cannot secure SQLite sidecar {}", sibling.display())
                });
            }
        }
    }
    Ok(())
}

fn create_database_exclusively(path: &Path) -> io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    match options.open(path) {
        Ok(file) => {
            drop(file);
            Ok(())
        }
        // O_EXCL never opens an existing inode, even through a symlink.
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn secure_existing_file(path: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let before = private_file_metadata(path)?;
    if before.mode() & 0o7777 == 0o600 {
        return Ok(());
    }
    let name = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: name is a live, NUL-terminated path. This changes permissions
    // without opening a normal file descriptor. Never fall back to File::open
    // or follow a symlink when the platform cannot honor AT_SYMLINK_NOFOLLOW.
    let result = unsafe {
        libc::fchmodat(
            libc::AT_FDCWD,
            name.as_ptr(),
            0o600,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    let after = private_file_metadata(path)?;
    if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
        return Err(io::Error::other(
            "SQLite file changed during permission check",
        ));
    }
    if after.mode() & 0o7777 != 0o600 {
        return Err(io::Error::other(
            "SQLite file permissions are not owner-only",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn private_file_metadata(path: &Path) -> io::Result<std::fs::Metadata> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::other(
            "SQLite storage must be a regular file with exactly one link",
        ));
    }
    Ok(metadata)
}

#[cfg(not(unix))]
fn secure_existing_file(path: &Path) -> io::Result<()> {
    crate::remote::secure_fs::ensure_owner_only(path).map_err(|error| {
        error
            .downcast::<io::Error>()
            .unwrap_or_else(|error| io::Error::other(error.to_string()))
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    #[test]
    fn preparation_preserves_contents_inodes_and_custom_directory_mode() {
        let dir = tempfile::tempdir().unwrap().keep();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.join("private.db");
        let mut inodes = Vec::new();
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let file = dir.join(format!("private.db{suffix}"));
            std::fs::write(&file, b"preserved").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            inodes.push(std::fs::metadata(&file).unwrap().ino());
        }
        prepare_database(path.to_str().unwrap(), true).unwrap();
        for (suffix, inode) in ["", "-wal", "-shm", "-journal"].into_iter().zip(inodes) {
            let file = dir.join(format!("private.db{suffix}"));
            assert_eq!(std::fs::read(&file).unwrap(), b"preserved");
            let metadata = std::fs::metadata(&file).unwrap();
            assert_eq!(metadata.ino(), inode);
            assert_eq!(metadata.mode() & 0o7777, 0o600);
        }
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o755);
    }

    #[test]
    fn rejects_links_and_directories_without_changing_their_targets() {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            for kind in ["symlink", "hardlink", "directory"] {
                let dir = tempfile::tempdir().unwrap().keep();
                let path = dir.join("private.db");
                if !suffix.is_empty() {
                    std::fs::write(&path, b"preserved").unwrap();
                }
                let target = dir.join("target");
                std::fs::write(&target, b"untouched").unwrap();
                std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
                let link = dir.join(format!("private.db{suffix}"));
                match kind {
                    "symlink" => symlink(&target, &link).unwrap(),
                    "hardlink" => std::fs::hard_link(&target, &link).unwrap(),
                    _ => std::fs::create_dir(&link).unwrap(),
                }
                assert!(
                    prepare_database(path.to_str().unwrap(), true).is_err(),
                    "{suffix} {kind}"
                );
                assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
                assert_eq!(std::fs::metadata(&target).unwrap().mode() & 0o777, 0o644);
            }
        }
    }

    #[test]
    fn rejects_dangling_symlink_without_creating_its_target() {
        let dir = tempfile::tempdir().unwrap().keep();
        let path = dir.join("private.db");
        let missing = dir.join("missing.db");
        symlink(&missing, &path).unwrap();
        assert!(prepare_database(path.to_str().unwrap(), true).is_err());
        assert!(!missing.exists());
    }
}
