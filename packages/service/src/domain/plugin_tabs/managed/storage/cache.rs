//! Immutable proofs are expensive to unpack; reuse them while every inode is unchanged.
use super::{invalid, io, VerifiedRevision};
use crate::error::AppError;
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

/// At most this many revisions, and this many stamped files across them,
/// stay cached; the least recently read go first.
const MAX_ENTRIES: usize = 32;
const MAX_FILES: usize = 8192;

#[derive(PartialEq, Eq)]
struct Stamp {
    length: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64, u32, u64),
}
struct Cached {
    revision: Arc<VerifiedRevision>,
    /// The proof files and the signed web payload (the only servable assets);
    /// never the backend executable, whose bytes are checked at launch.
    files: BTreeMap<PathBuf, Stamp>,
    /// When it was last read ([`TICK`]), for eviction.
    used: AtomicU64,
}
static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<Cached>>>> = OnceLock::new();
static TICK: AtomicU64 = AtomicU64::new(0);

fn entries() -> Result<std::sync::MutexGuard<'static, HashMap<PathBuf, Arc<Cached>>>, AppError> {
    CACHE.get_or_init(Mutex::default).lock().map_err(invalid)
}

fn stamp(path: &Path) -> Result<Stamp, AppError> {
    let meta = path.symlink_metadata().map_err(invalid)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(invalid("tab revision contains a non-regular file"));
    }
    Ok(Stamp {
        length: meta.len(),
        modified: meta.modified().map_err(invalid)?,
        #[cfg(unix)]
        identity: {
            use std::os::unix::fs::MetadataExt as _;
            (
                meta.dev(),
                meta.ino(),
                meta.ctime(),
                meta.ctime_nsec(),
                meta.mode(),
                meta.nlink(),
            )
        },
    })
}

pub(super) fn read_directory(
    root: &Path,
    id: &str,
    dir: &Path,
) -> Result<Arc<VerifiedRevision>, AppError> {
    Ok(entry(root, id, dir)?.revision.clone())
}

/// The cached entry of `dir`, re-verified when any stamped file changed.
fn entry(root: &Path, id: &str, dir: &Path) -> Result<Arc<Cached>, AppError> {
    // Stat outside the lock: other revisions' readers need not wait for it.
    let cached = entries()?.get(dir).cloned();
    if let Some(cached) = cached {
        if unchanged(&cached)? {
            cached
                .used
                .store(TICK.fetch_add(1, Ordering::Relaxed), Ordering::Relaxed);
            return Ok(cached);
        }
    }
    let verified = Arc::new(verify(root, id, dir)?);
    let mut entries = entries()?;
    evict(&mut entries, verified.files.len());
    entries.insert(dir.to_owned(), verified.clone());
    Ok(verified)
}

fn unchanged(cached: &Cached) -> Result<bool, AppError> {
    for (path, before) in &cached.files {
        if stamp(path)? != *before {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Make room for an entry of `incoming` files: drop the least recently read.
fn evict(entries: &mut HashMap<PathBuf, Arc<Cached>>, incoming: usize) {
    let mut files: usize = entries.values().map(|entry| entry.files.len()).sum();
    while !entries.is_empty() && (entries.len() >= MAX_ENTRIES || files + incoming > MAX_FILES) {
        let oldest = entries
            .iter()
            .min_by_key(|(_, entry)| entry.used.load(Ordering::Relaxed))
            .map(|(dir, _)| dir.clone());
        if let Some(entry) = oldest.and_then(|dir| entries.remove(&dir)) {
            files -= entry.files.len();
        }
    }
}

fn verify(root: &Path, id: &str, dir: &Path) -> Result<Cached, AppError> {
    let revision = dir
        .parent()
        .ok_or_else(|| invalid("tab revision missing"))?;
    let archive = revision.join(super::WEB_ARCHIVE);
    let receipt = revision.join(super::RECEIPT);
    let mut stamps = BTreeMap::from([
        (archive.clone(), stamp(&archive)?),
        (receipt.clone(), stamp(&receipt)?),
    ]);
    let trust = trust();
    let backend = revision.join(super::backend::ARCHIVE);
    if backend.symlink_metadata().is_ok() {
        stamps.insert(backend.clone(), stamp(&backend)?);
    }
    let proofs: Vec<PathBuf> = stamps.keys().cloned().collect();
    let trusted = super::read_trusted_directory(root, id, dir, &trust)?;
    if trusted
        .backend_archive
        .as_ref()
        .is_some_and(|path| !stamps.contains_key(path))
    {
        return Err(invalid("tab proof changed during verification"));
    }
    for (name, bytes) in trusted.files {
        let path = dir.join(name);
        let before = stamp(&path)?;
        if io::regular(&path, super::LIMIT)? != bytes || stamp(&path)? != before {
            return Err(invalid("tab revision changed during verification"));
        }
        stamps.insert(path, before);
    }
    for path in &proofs {
        if stamps.get(path) != Some(&stamp(path)?) {
            return Err(invalid("tab proof changed during verification"));
        }
    }
    Ok(Cached {
        revision: Arc::new(trusted.revision),
        files: stamps,
        used: AtomicU64::new(TICK.fetch_add(1, Ordering::Relaxed)),
    })
}

/// The catalog keys revisions are verified with: the build's pinned trust,
/// and in unit tests the fixture key, so routes can be exercised on signed
/// fixture installs (test builds pin no key).
fn trust() -> crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore {
    #[cfg(test)]
    return super::fixtures::trust();
    #[cfg(not(test))]
    crate::domain::agents::providers::installed::managed::trust::pinned_index_trust_store()
}

/// The revision at `dir`, when `file` is one of its signed web assets.
pub(super) fn verify_directory_asset(
    root: &Path,
    id: &str,
    dir: &Path,
    file: &Path,
) -> Result<Arc<VerifiedRevision>, AppError> {
    let entry = entry(root, id, dir)?;
    let canonical = dir.canonicalize().map_err(invalid)?;
    let relative = file.strip_prefix(&canonical).map_err(invalid)?;
    if !entry.files.contains_key(&dir.join(relative)) {
        return Err(invalid("asset is absent from the signed tab archive"));
    }
    Ok(entry.revision.clone())
}

/// A collected directory must never leave a stale authenticated cache entry.
pub(super) fn invalidate(directory: &Path) -> Result<(), AppError> {
    entries()?.remove(directory);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{commit, directory, fixtures::fixture_for};
    use super::*;

    #[test]
    fn the_least_recently_read_revision_is_evicted_first() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let mut dirs = Vec::new();
        for number in 0..=MAX_ENTRIES {
            let id = format!("tab-{number}");
            let (receipt, archive, files, _) =
                fixture_for().root(&temp.path().join(&id)).id(&id).call();
            commit(&root, &receipt, &archive, &files).unwrap();
            let dir = directory(&root, &id).unwrap().unwrap();
            read_directory(&root, &id, &dir).unwrap();
            dirs.push((id, dir));
            if number == 0 {
                continue;
            }
            // Keep the first one hot: the second becomes the oldest.
            read_directory(&root, &dirs[0].0, &dirs[0].1).unwrap();
        }
        let cached = entries().unwrap();
        assert!(cached.contains_key(&dirs[0].1), "recently read stays");
        assert!(!cached.contains_key(&dirs[1].1), "least recently read goes");
        assert!(cached.contains_key(&dirs[MAX_ENTRIES].1));
        assert!(cached.len() <= MAX_ENTRIES);
    }
}
