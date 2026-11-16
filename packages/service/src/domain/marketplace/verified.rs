//! Verified catalogs, kept in memory per cache file: a catalog version is
//! verified once, then served from memory while its cache file and the trust
//! it was verified under stay the same.
use super::invalid;
use crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore;
use crate::error::AppError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// What identifies one version of a cache file without reading it: a cache
/// is only ever replaced by an atomic rename, which changes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
    /// Device, inode and change time: an in-place rewrite moves ctime.
    #[cfg(unix)]
    inode: (u64, u64, i64, i64),
}

impl Stamp {
    /// The stamp of the file at `path`; `None` when there is none.
    pub(crate) fn of(path: &Path) -> std::io::Result<Option<Self>> {
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        Ok(Some(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            inode: {
                use std::os::unix::fs::MetadataExt as _;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
        }))
    }
}

struct Entry<T> {
    stamp: Stamp,
    trust: String,
    value: T,
}

/// One kind of verified catalog, by cache file.
pub(crate) struct VerifiedMemo<T> {
    entries: OnceLock<Mutex<HashMap<PathBuf, Entry<T>>>>,
}

impl<T: Clone> VerifiedMemo<T> {
    pub(crate) const fn new() -> Self {
        Self {
            entries: OnceLock::new(),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<PathBuf, Entry<T>>>, AppError> {
        self.entries
            .get_or_init(Default::default)
            .lock()
            .map_err(|error| invalid(format!("verified catalog memory is poisoned: {error}")))
    }

    /// What was verified under `trust` for this exact version of the cache
    /// file at `path`, while `current` still accepts it (its validity window).
    pub(crate) fn recall(
        &self,
        path: &Path,
        stamp: &Stamp,
        trust: &ManagedTrustStore,
        current: impl Fn(&T) -> bool,
    ) -> Result<Option<T>, AppError> {
        let fingerprint = trust.fingerprint();
        Ok(self
            .lock()?
            .get(path)
            .filter(|entry| entry.stamp == *stamp && entry.trust == fingerprint)
            .filter(|entry| current(&entry.value))
            .map(|entry| entry.value.clone()))
    }

    /// Record that the cache file at `path`, as `stamp` identifies it, holds
    /// `value`, verified under `trust`.
    pub(crate) fn remember(
        &self,
        path: &Path,
        stamp: Stamp,
        trust: &ManagedTrustStore,
        value: T,
    ) -> Result<(), AppError> {
        self.lock()?.insert(
            path.to_path_buf(),
            Entry {
                stamp,
                trust: trust.fingerprint(),
                value,
            },
        );
        Ok(())
    }
}
