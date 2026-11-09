//! Content-addressed blob storage on disk.
//!
//! Blobs are keyed by the SHA-256 of their bytes and written to
//! `<blob_dir>/<first two hex chars>/<hash>`. The shard prefix keeps any single
//! directory from accumulating tens of thousands of entries; content addressing
//! means the same screenshot captured twice costs one copy, which matters
//! because agents re-screenshot the same view constantly.
//!
//! Writes are atomic (temp file + rename) so a crash mid-write can't leave a
//! truncated blob under a hash that claims to describe complete bytes. An
//! already-present hash short-circuits: identical content by definition needs no
//! rewrite.

mod durability;

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::dir::blob_dir;
use crate::error::AppError;

/// A stored blob's identity: lowercase hex SHA-256.
pub type BlobHash = String;

/// Reject anything that isn't a well-formed hash before it reaches the
/// filesystem. This is the path-traversal guard for the HTTP read endpoint:
/// `..`, `/`, and absolute paths all fail the hex check.
pub fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn path_for(hash: &str) -> PathBuf {
    blob_dir().join(&hash[..2]).join(hash)
}

fn path_for_in(root: &Path, hash: &str) -> PathBuf {
    root.join(&hash[..2]).join(hash)
}

pub fn hash_bytes(bytes: &[u8]) -> BlobHash {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    encode_hex(&hasher.finalize())
}

fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    // Hand-rolled hex rather than the `hex` crate: the workspace enforces a
    // 14-day `minimumReleaseAge` on new dependencies, and this is four lines.
    bytes
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// Write `bytes` and return their hash. Idempotent: storing identical bytes
/// twice is a no-op the second time.
pub fn put(bytes: &[u8]) -> Result<BlobHash, AppError> {
    put_in(&blob_dir(), bytes)
}

/// Create the process blob root and make its directory entry durable before
/// background maintenance can replace inline payloads with blob references.
pub fn ensure_root(root: &Path) -> Result<(), AppError> {
    durability::ensure_blob_directories(root, root)
        .map_err(|error| blob_io("create durable blob directory", error))
}

fn put_in(root: &Path, bytes: &[u8]) -> Result<BlobHash, AppError> {
    let hash = hash_bytes(bytes);
    let path = path_for_in(root, &hash);
    let shard = path
        .parent()
        .ok_or_else(|| AppError::internal("blob path has no parent"))?;
    durability::ensure_blob_directories(root, shard)
        .map_err(|error| blob_io("create durable blob shard", error))?;

    if verify_blob(&path, &hash).map_err(|error| blob_io("verify existing blob", error))? {
        return Ok(hash);
    }
    quarantine_corrupt(&path, shard, &hash)?;

    // UUID + create_new makes staging unique across threads and processes.
    let staging = shard.join(format!(
        ".{hash}.{}.{}.partial",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    write_and_sync_new(&staging, bytes)
        .map_err(|e| AppError::internal(format!("failed to write blob: {e}")))?;
    if let Err(error) = std::fs::rename(&staging, &path) {
        // On platforms where rename cannot replace an existing file, another
        // writer may have won. Success is allowed only after verifying bytes.
        if !verify_blob(&path, &hash)
            .map_err(|error| blob_io("verify concurrently stored blob", error))?
        {
            cleanup_staging(&staging);
            return Err(AppError::internal(format!(
                "failed to commit blob: {error}"
            )));
        }
        cleanup_staging(&staging);
    }
    if !verify_blob(&path, &hash).map_err(|error| blob_io("verify committed blob", error))? {
        return Err(AppError::internal(format!(
            "committed blob {hash} failed integrity verification"
        )));
    }
    crate::shared::fs_durability::sync_directory(shard)
        .map_err(|e| AppError::internal(format!("failed to sync blob directory: {e}")))?;
    Ok(hash)
}

#[track_caller]
fn blob_io(action: &'static str, error: std::io::Error) -> AppError {
    AppError::internal(format!("failed to {action}: {error}"))
}

/// A false result covers both absence and a corrupt/non-file path.
fn verify_blob(path: &Path, expected_hash: &str) -> std::io::Result<bool> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = encode_hex(&hasher.finalize());
    Ok(actual == expected_hash)
}

fn quarantine_corrupt(path: &Path, shard: &Path, hash: &str) -> Result<(), AppError> {
    if std::fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    let quarantine = shard.join(format!(
        ".{hash}.{}.{}.corrupt",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::rename(path, &quarantine).map_err(|error| {
        AppError::internal(format!(
            "failed to quarantine corrupt blob {} as {}: {error}",
            path.display(),
            quarantine.display()
        ))
    })?;
    tracing::warn!(
        blob = %path.display(),
        quarantine = %quarantine.display(),
        "quarantined corrupt blob entry"
    );
    Ok(())
}

fn cleanup_staging(path: &Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(staging = %path.display(), "failed to clean blob staging file: {error}");
        }
    }
}

/// Write `bytes` and flush them to the device before returning.
///
/// The rename that follows is atomic with respect to *this process* crashing,
/// but not to the machine losing power: without the fsync the rename can reach
/// the disk before the data does, leaving a zero-length file under a hash that
/// claims a complete payload. That is unrecoverable, because the caller
/// discards the inline copy once `put` succeeds.
fn write_and_sync_new(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Read a blob's bytes. `NotFound` covers both an invalid hash and a missing
/// file: a caller holding a reference to bytes we no longer have is in the same
/// position either way.
#[cfg(test)]
pub fn get(hash: &str) -> Result<Vec<u8>, AppError> {
    if !is_valid_hash(hash) {
        return Err(AppError::NotFound(format!("blob {hash} not found")));
    }
    let path = path_for(hash);
    let bytes =
        std::fs::read(&path).map_err(|_| AppError::NotFound(format!("blob {hash} not found")))?;
    if !path.is_file() || hash_bytes(&bytes) != hash {
        return Err(AppError::NotFound(format!("blob {hash} not found")));
    }
    Ok(bytes)
}

/// Async read path for HTTP handlers; large screenshots must not block a Tokio
/// worker while the filesystem fills the response buffer.
pub async fn get_async(hash: &str) -> Result<Vec<u8>, AppError> {
    if !is_valid_hash(hash) {
        return Err(AppError::NotFound(format!("blob {hash} not found")));
    }
    let path = path_for(hash);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::NotFound(format!("blob {hash} not found")))?;
    if !path.is_file() || hash_bytes(&bytes) != hash {
        return Err(AppError::NotFound(format!("blob {hash} not found")));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_bytes_and_is_content_addressed() {
        let first = put(b"screenshot-bytes").unwrap();
        let second = put(b"screenshot-bytes").unwrap();
        assert_eq!(first, second, "identical bytes must share one blob");
        assert_eq!(get(&first).unwrap(), b"screenshot-bytes");

        let other = put(b"different").unwrap();
        assert_ne!(first, other);
    }

    #[test]
    fn hash_is_lowercase_hex_sha256() {
        let hash = hash_bytes(b"");
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert!(is_valid_hash(&hash));
    }

    #[test]
    fn rejects_hashes_that_could_escape_the_blob_dir() {
        for bad in [
            "../../etc/passwd",
            "/etc/passwd",
            "..",
            "",
            "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789", // uppercase
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85",  // 63 chars
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855a", // 65
            "g3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // non-hex
        ] {
            assert!(!is_valid_hash(bad), "{bad:?} must be rejected");
            assert!(get(bad).is_err(), "{bad:?} must not be readable");
        }
    }

    #[test]
    fn missing_blob_reads_as_not_found() {
        let absent = "0".repeat(64);

        assert!(matches!(get(&absent), Err(AppError::NotFound(_))));
    }

    #[test]
    fn shards_by_hash_prefix() {
        let hash = put(b"sharded").unwrap();
        let path = path_for(&hash);
        assert_eq!(
            path.parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
            &hash[..2]
        );
        assert!(path.is_file());
    }

    #[test]
    fn replaces_and_quarantines_corrupt_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let hash = hash_bytes(b"correct");
        let path = path_for_in(root.path(), &hash);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"truncated").unwrap();

        assert_eq!(put_in(root.path(), b"correct").unwrap(), hash);
        assert_eq!(std::fs::read(&path).unwrap(), b"correct");
        assert!(std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".corrupt")));
    }

    #[test]
    fn replaces_a_directory_at_the_hash_path_without_deleting_it() {
        let root = tempfile::tempdir().unwrap();
        let hash = hash_bytes(b"correct");
        let path = path_for_in(root.path(), &hash);
        std::fs::create_dir_all(&path).unwrap();

        put_in(root.path(), b"correct").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"correct");
    }

    #[test]
    fn concurrent_writers_share_one_verified_blob() {
        let root = std::sync::Arc::new(tempfile::tempdir().unwrap());
        let mut writers = Vec::new();
        for _ in 0..8 {
            let root = root.clone();
            writers.push(std::thread::spawn(move || {
                put_in(root.path(), b"same bytes").unwrap()
            }));
        }
        let hashes: Vec<_> = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect();
        assert!(hashes.iter().all(|hash| hash == &hashes[0]));
        let path = path_for_in(root.path(), &hashes[0]);
        assert!(verify_blob(&path, &hashes[0]).unwrap());
    }

    #[test]
    fn stale_partial_file_is_ignored_and_preserved() {
        let root = tempfile::tempdir().unwrap();
        let hash = hash_bytes(b"complete");
        let shard = root.path().join(&hash[..2]);
        std::fs::create_dir_all(&shard).unwrap();
        let stale = shard.join(format!(".{hash}.old.partial"));
        std::fs::write(&stale, b"incomplete unrelated write").unwrap();

        assert_eq!(put_in(root.path(), b"complete").unwrap(), hash);
        assert_eq!(
            std::fs::read(path_for_in(root.path(), &hash)).unwrap(),
            b"complete"
        );
        assert_eq!(
            std::fs::read(stale).unwrap(),
            b"incomplete unrelated write",
            "a write must not delete another process's staging data"
        );
    }
}
