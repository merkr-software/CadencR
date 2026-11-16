//! SHA-256 digests as Cadencr records them (lowercase hex), of bytes or of
//! one regular file streamed from disk.

use std::path::Path;

use sha2::{Digest as _, Sha256};

/// The SHA-256 of `bytes`, lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A regular file's SHA-256 (lowercase hex) and length, reading at most
/// `limit` bytes and never the whole file into memory: what a managed
/// executable is compared with before it runs. Plugin-core's bounded reader
/// does the opening — no symlink followed (`O_NOFOLLOW` on Unix), nothing
/// but a regular file, and the inode opened must be the one inspected — so
/// a swap between the check and the read cannot redirect it.
pub fn sha256_regular_file(path: &Path, limit: u64) -> std::io::Result<(String, u64)> {
    cadencr_plugin_core::sha256_regular_bounded(path, limit)
        .map_err(|error| std::io::Error::new(error.kind(), format!("{}: {error}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_bytes_and_regular_files_alike() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file");
        std::fs::write(&path, b"abc").unwrap();
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(sha256_hex(b"abc"), expected);
        assert_eq!(
            sha256_regular_file(&path, 3).unwrap(),
            (expected.to_string(), 3)
        );
        let refused = sha256_regular_file(&path, 2).unwrap_err();
        assert!(refused.to_string().contains(&path.display().to_string()));
        assert!(sha256_regular_file(temp.path(), 10).is_err());
    }
}
