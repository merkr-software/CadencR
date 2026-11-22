//! Process-lifetime exclusive OS advisory lockfile guarding a Cadencr database.
//!
//! Acquired in server mode before running `login_env`, migrations, or `VACUUM`
//! so a second service instance pointing at the same database fails fast
//! instead of racing startup against a running instance.

use std::fmt;
use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};

use crate::remote::secure_fs;

/// Keeps the exclusive advisory lock held until dropped (at process exit).
#[derive(Debug)]
#[must_use = "keep the database lock guard alive for the entire process lifetime"]
pub struct DbLockGuard {
    _file: File,
}

#[derive(Debug)]
pub enum StartupLockError {
    WouldBlock {
        path: PathBuf,
    },
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl fmt::Display for StartupLockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WouldBlock { path } => write!(
                f,
                "another Cadencr service instance is already using this database ({})",
                path.display()
            ),
            Self::Io { path, source } => write!(
                f,
                "failed to acquire Cadencr database lock {}: {source}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for StartupLockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::WouldBlock { .. } => None,
            Self::Io { source, .. } => Some(source),
        }
    }
}

/// Lockfile sibling path for a database file: `<db_path>.service.lock`.
pub fn lock_path_for_db(db_path: &Path) -> PathBuf {
    let mut os = db_path.as_os_str().to_os_string();
    os.push(".service.lock");
    PathBuf::from(os)
}

/// Acquire an exclusive non-blocking OS advisory lock on `<db_path>.service.lock`.
pub fn acquire_db_lock(db_path: &Path) -> Result<DbLockGuard, StartupLockError> {
    let lock_path = lock_path_for_db(db_path);
    if let Some(parent) = lock_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            secure_fs::create_missing_dirs(parent).map_err(|error| StartupLockError::Io {
                path: lock_path.clone(),
                source: into_io_error(error),
            })?;
        }
    }

    let file =
        secure_fs::open_owner_only(&lock_path, true).map_err(|error| StartupLockError::Io {
            path: lock_path.clone(),
            source: into_io_error(error),
        })?;

    match file.try_lock() {
        Ok(()) => Ok(DbLockGuard { _file: file }),
        Err(TryLockError::WouldBlock) => Err(StartupLockError::WouldBlock { path: lock_path }),
        Err(TryLockError::Error(source)) => Err(StartupLockError::Io {
            path: lock_path,
            source,
        }),
    }
}

fn into_io_error(error: anyhow::Error) -> std::io::Error {
    let kind = error
        .downcast_ref::<std::io::Error>()
        .map_or(std::io::ErrorKind::Other, std::io::Error::kind);
    std::io::Error::new(kind, format!("{error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_path_appends_service_lock_suffix() {
        assert_eq!(
            lock_path_for_db(Path::new("/tmp/cadencr.db")),
            PathBuf::from("/tmp/cadencr.db.service.lock")
        );
    }

    #[test]
    fn acquiring_db_lock_twice_fails_with_would_block_and_drop_allows_reacquire() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("nested").join("cadencr.db");

        let guard = acquire_db_lock(&db_path).expect("first acquire must succeed");
        assert!(lock_path_for_db(&db_path).exists());

        let err = acquire_db_lock(&db_path).expect_err("second acquire must fail");
        assert!(
            matches!(err, StartupLockError::WouldBlock { .. }),
            "expected WouldBlock, got {err:?}"
        );
        assert!(
            err.to_string()
                .contains("another Cadencr service instance is already using this database"),
            "unexpected error message: {err}"
        );

        drop(guard);

        let reacquired =
            acquire_db_lock(&db_path).expect("re-acquiring after dropping guard must succeed");
        drop(reacquired);
    }

    #[cfg(unix)]
    #[test]
    fn lock_file_is_owner_only_and_rejects_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cadencr.db");
        let guard = acquire_db_lock(&db_path).expect("acquire lock");
        let mode = std::fs::metadata(lock_path_for_db(&db_path))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        drop(guard);

        let target = dir.path().join("target.lock");
        std::fs::write(&target, b"").unwrap();
        let linked_db = dir.path().join("linked.db");
        symlink(&target, lock_path_for_db(&linked_db)).unwrap();
        assert!(
            matches!(
                acquire_db_lock(&linked_db),
                Err(StartupLockError::Io { .. })
            ),
            "symlinked lock path must be rejected"
        );
    }
}
