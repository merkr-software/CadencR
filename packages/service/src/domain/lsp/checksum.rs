use std::fs;
use std::io::Read;

use sha2::{Digest, Sha256};

use crate::error::AppError;

use super::catalog::PlatformSha256;
use super::platform::current_platform_tag;

pub fn current_platform_sha256(checksums: &[PlatformSha256]) -> Result<&'static str, AppError> {
    let (arch, os) = current_platform_tag()?;
    checksums
        .iter()
        .find(|entry| entry.arch == arch && entry.os == os)
        .map(|entry| entry.sha256)
        .ok_or_else(|| {
            AppError::Internal(format!(
                "no LSP checksum available for arch {arch:?} and os {os:?}"
            ))
        })
}

pub fn verify_sha256(path: &std::path::Path, expected: &str) -> Result<(), AppError> {
    let actual = sha256_hex(path)?;
    if actual == expected {
        return Ok(());
    }
    Err(AppError::Internal(format!(
        "LSP download checksum mismatch for {}: expected {expected}, got {actual}",
        path.display()
    )))
}

fn sha256_hex(path: &std::path::Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path)
        .map_err(|e| AppError::Internal(format!("open {}: {e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = [0_u8; 8192];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| AppError::Internal(format!("read {}: {e}", path.display())))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_sha256_rejects_mismatched_download() {
        let temp = tempfile::tempdir().unwrap();
        let bin_path = temp.path().join("rust-analyzer");
        fs::write(&bin_path, b"unexpected executable").unwrap();

        let err = verify_sha256(
            &bin_path,
            "0000000000000000000000000000000000000000000000000000000000000000",
        )
        .unwrap_err();

        assert!(
            err.to_string().contains("checksum mismatch"),
            "unexpected error: {err}"
        );
    }
}
