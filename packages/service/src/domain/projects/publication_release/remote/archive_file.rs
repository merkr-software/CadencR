//! Open-handle archive sources: previews hash without retaining archive buffers.
use crate::error::AppError;
use sha2::{Digest as _, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub(crate) struct ArchiveFile {
    file: Arc<Mutex<File>>,
    pub size: u64,
    pub sha256: String,
}
impl ArchiveFile {
    pub fn open(path: &Path, limit: u64) -> Result<Self, AppError> {
        let before = std::fs::symlink_metadata(path).map_err(failed)?;
        if !before.is_file() || before.file_type().is_symlink() || before.len() > limit {
            return Err(invalid());
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options.open(path).map_err(failed)?;
        let after = file.metadata().map_err(failed)?;
        if !after.is_file() || after.len() != before.len() {
            return Err(invalid());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            if before.dev() != after.dev() || before.ino() != after.ino() {
                return Err(invalid());
            }
        }
        let (sha256, size) = hash(&mut file, limit)?;
        if size != after.len() {
            return Err(invalid());
        }
        Ok(Self {
            file: Arc::new(Mutex::new(file)),
            size,
            sha256,
        })
    }
    pub async fn bytes(&self) -> Result<axum::body::Bytes, AppError> {
        let source = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut file = source.file.lock().map_err(|_| invalid())?;
            file.seek(SeekFrom::Start(0)).map_err(failed)?;
            let mut bytes = Vec::with_capacity(source.size as usize);
            (&mut *file)
                .take(source.size + 1)
                .read_to_end(&mut bytes)
                .map_err(failed)?;
            if bytes.len() as u64 != source.size
                || super::super::local::digest(&bytes) != source.sha256
            {
                return Err(invalid());
            }
            Ok(bytes.into())
        })
        .await
        .map_err(|error| AppError::Internal(format!("read publication archive: {error}")))?
    }
}
fn hash(file: &mut File, limit: u64) -> Result<(String, u64), AppError> {
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(failed)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > limit {
            return Err(invalid());
        }
        hash.update(&buffer[..count]);
    }
    Ok((
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        size,
    ))
}
fn invalid() -> AppError {
    AppError::coded(
        axum::http::StatusCode::BAD_REQUEST,
        "PUBLICATION_RELEASE_INVALID",
        "publication archive is not a bounded regular file or changed since preview",
    )
}
fn failed(error: std::io::Error) -> AppError {
    AppError::Internal(format!("read publication archive: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn previews_keep_handles_not_payloads_and_upload_rejects_changed_bytes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("archive");
        std::fs::write(&path, b"original").unwrap();
        let source = ArchiveFile::open(&path, 1024).unwrap();
        assert_eq!(source.size, 8);
        assert_eq!(source.bytes().await.unwrap().as_ref(), b"original");
        std::fs::write(&path, b"tampered").unwrap();
        assert!(source.bytes().await.is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn replacement_or_symlink_cannot_redirect_an_open_archive() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("archive");
        std::fs::write(&path, b"original").unwrap();
        let source = ArchiveFile::open(&path, 1024).unwrap();
        std::fs::rename(&path, root.path().join("original-inode")).unwrap();
        let foreign = root.path().join("foreign");
        std::fs::write(&foreign, b"foreign").unwrap();
        symlink(&foreign, &path).unwrap();
        assert!(ArchiveFile::open(&path, 1024).is_err());
        assert_eq!(source.bytes().await.unwrap().as_ref(), b"original");
        assert!(ArchiveFile::open(&foreign, 2).is_err());
    }
}
