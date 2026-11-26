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
    database: PathBuf,
}

impl DbLockGuard {
    pub(crate) fn database(&self) -> &Path {
        &self.database
    }
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

/// Acquire an exclusive non-blocking OS advisory lock on `<db_path>.service.lock`,
/// next to the database's resolved location.
pub fn acquire_db_lock(db_path: &Path) -> Result<DbLockGuard, StartupLockError> {
    let io_error = |path: &Path, source: std::io::Error| StartupLockError::Io {
        path: path.to_path_buf(),
        source,
    };
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            secure_fs::create_missing_dirs(parent)
                .map_err(|error| io_error(&lock_path_for_db(db_path), into_io_error(error)))?;
        }
    }
    let resolved =
        resolve_db_path(db_path).map_err(|source| io_error(&lock_path_for_db(db_path), source))?;
    let lock_path = lock_path_for_db(&resolved);

    let file = secure_fs::open_owner_only(&lock_path, true)
        .map_err(|error| io_error(&lock_path, into_io_error(error)))?;

    match file.try_lock() {
        Ok(()) => Ok(DbLockGuard {
            _file: file,
            database: resolved,
        }),
        Err(TryLockError::WouldBlock) => Err(StartupLockError::WouldBlock { path: lock_path }),
        Err(TryLockError::Error(source)) => Err(io_error(&lock_path, source)),
    }
}

/// The database's real path, so a symlink, a relative path or a `..` detour
/// to the same file all land on one lock. A database not created yet resolves
/// through its directory and keeps its own name.
fn resolve_db_path(db_path: &Path) -> std::io::Result<PathBuf> {
    match std::fs::canonicalize(db_path) {
        Ok(resolved) => Ok(resolved),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let name = db_path.file_name().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("database path has no file name: {}", db_path.display()),
                )
            })?;
            let parent = match db_path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent,
                _ => Path::new("."),
            };
            Ok(std::fs::canonicalize(parent)?.join(name))
        }
        Err(error) => Err(error),
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

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_the_same_database_shares_its_lock() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cadencr.db");
        std::fs::write(&db_path, b"").unwrap();
        let alias = dir.path().join("alias.db");
        std::os::unix::fs::symlink(&db_path, &alias).unwrap();

        let guard = acquire_db_lock(&db_path).expect("first acquire");
        let err = acquire_db_lock(&alias).expect_err("the alias names the same database");
        assert!(
            matches!(err, StartupLockError::WouldBlock { .. }),
            "{err:?}"
        );
        drop(guard);
    }

    #[test]
    fn a_relative_detour_to_a_new_database_shares_its_lock() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let direct = dir.path().join("fresh.db");
        let detour = dir.path().join("sub").join("..").join("fresh.db");

        let guard = acquire_db_lock(&direct).expect("first acquire");
        let err = acquire_db_lock(&detour).expect_err("same file through `..`");
        assert!(
            matches!(err, StartupLockError::WouldBlock { .. }),
            "{err:?}"
        );
        drop(guard);
    }
}
