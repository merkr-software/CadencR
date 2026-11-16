//! The one bounded regular-file reader every plugin inspection uses.
//!
//! Plugin folders are user-writable and inspected without trust, so a file is
//! read only when it is a regular file both before and after opening it: the
//! open refuses to follow a symlink (`O_NOFOLLOW`) or block on a FIFO
//! (`O_NONBLOCK`), and the opened inode must be the one that was inspected.

use std::fs::{self, File, OpenOptions};
use std::io::Read as _;
use std::path::Path;

use sha2::{Digest as _, Sha256};

/// Open `path` when it is a regular file of at most `limit` bytes; the open
/// file and the length it had. A reader must still stop past `limit`: the
/// file may grow once open.
pub fn open_regular_bounded(path: &Path, limit: u64) -> std::io::Result<(File, u64)> {
    let before = fs::symlink_metadata(path)?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(std::io::Error::other(
            "must be a regular file (symlinks and special files are forbidden)",
        ));
    }
    if before.len() > limit {
        return Err(too_large(limit));
    }
    Ok((open_regular(path, &before)?, before.len()))
}

/// Read `path` when it is a regular file of at most `limit` bytes.
pub fn read_regular_bounded(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let (file, length) = open_regular_bounded(path, limit)?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(too_large(limit));
    }
    Ok(bytes)
}

/// Stream-hash `path` when it is a regular file of at most `limit` bytes,
/// without reading it into memory: its SHA-256 (lowercase hex) and length.
pub fn sha256_regular_bounded(path: &Path, limit: u64) -> std::io::Result<(String, u64)> {
    let (file, _) = open_regular_bounded(path, limit)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut reader = file.take(limit.saturating_add(1));
    let mut length = 0_u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        length += read as u64;
        hasher.update(&buffer[..read]);
    }
    if length > limit {
        return Err(too_large(limit));
    }
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((digest, length))
}

fn too_large(limit: u64) -> std::io::Error {
    std::io::Error::other(format!("exceeds the {limit}-byte file limit"))
}

#[cfg(unix)]
fn open_regular(path: &Path, before: &fs::Metadata) -> std::io::Result<File> {
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let after = file.metadata()?;
    if !after.is_file() || before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(std::io::Error::other("changed while being read"));
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_regular(path: &Path, before: &fs::Metadata) -> std::io::Result<File> {
    let file = OpenOptions::new().read(true).open(path)?;
    let after = file.metadata()?;
    if !after.is_file() || before.len() != after.len() {
        return Err(std::io::Error::other("changed while being read"));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bounded_regular_files_only() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("a.json");
        std::fs::write(&file, "1234").unwrap();
        assert_eq!(read_regular_bounded(&file, 4).unwrap(), b"1234");
        assert!(read_regular_bounded(&file, 3).is_err());
        assert!(read_regular_bounded(root.path(), 1024).is_err());
        assert_eq!(
            read_regular_bounded(&root.path().join("missing"), 4)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
    }

    #[test]
    fn hashes_bounded_regular_files_only() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("file");
        std::fs::write(&file, b"abc").unwrap();
        let (digest, length) = sha256_regular_bounded(&file, 3).unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(length, 3);
        assert_eq!(sha256_regular_bounded(&file, u64::MAX).unwrap().1, 3);
        assert!(sha256_regular_bounded(&file, 2).is_err());
        assert!(sha256_regular_bounded(root.path(), 10).is_err());
        #[cfg(unix)]
        {
            let link = root.path().join("link");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(sha256_regular_bounded(&link, 10).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("a.json");
        std::fs::write(&file, "1").unwrap();
        let link = root.path().join("link.json");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(read_regular_bounded(&link, 4).is_err());
    }
}
