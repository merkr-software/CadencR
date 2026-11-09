use std::path::PathBuf;

use crate::error::AppError;

/// Read a whole file into memory, refusing anything larger than `max_bytes`.
///
/// Shared by the byte-streaming editor routes (images, documents): the
/// `what` label ("Image", "Document") only shapes the size-limit message.
pub async fn read_file_capped(
    path: PathBuf,
    max_bytes: usize,
    what: &'static str,
) -> Result<Vec<u8>, AppError> {
    tokio::task::spawn_blocking(move || -> Result<Vec<u8>, AppError> {
        use std::io::Read;

        let mut file = std::fs::File::open(&path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                AppError::NotFound(format!("File not found: {}", path.display()))
            }
            std::io::ErrorKind::PermissionDenied => {
                AppError::BadRequest(format!("Permission denied: {}", path.display()))
            }
            _ => AppError::internal(e.to_string()),
        })?;
        let len = file
            .metadata()
            .map_err(|e| AppError::internal(e.to_string()))?
            .len();
        if len > max_bytes as u64 {
            return Err(AppError::BadRequest(format!(
                "{what} exceeds {} MB size limit",
                max_bytes / (1024 * 1024)
            )));
        }
        // Pre-size the buffer: `read_to_end` would otherwise grow it
        // through ~18 reallocations for a 25 MB file.
        let mut buf = Vec::with_capacity(len as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| AppError::internal(e.to_string()))?;
        Ok(buf)
    })
    .await
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_a_file_within_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bin");
        std::fs::write(&path, b"hello").unwrap();
        assert_eq!(read_file_capped(path, 5, "File").await.unwrap(), b"hello");
    }

    #[tokio::test]
    async fn rejects_a_file_over_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bin");
        std::fs::write(&path, b"hello").unwrap();
        let err = read_file_capped(path, 4, "Document").await.unwrap_err();
        assert!(matches!(err, AppError::BadRequest(msg) if msg.starts_with("Document exceeds")));
    }

    #[tokio::test]
    async fn missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_file_capped(dir.path().join("nope"), 4, "File")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
