use std::io::Write as _;
use std::path::{Path, PathBuf};

const UNIQUE_DIRECTORY_ATTEMPTS: usize = 8;

pub(super) fn create_unique_directory(parent: &Path) -> std::io::Result<PathBuf> {
    for _ in 0..UNIQUE_DIRECTORY_ATTEMPTS {
        let output = parent.join(uuid::Uuid::new_v4().to_string());
        match std::fs::create_dir(&output) {
            Ok(()) => return Ok(output),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique publication output directory",
    ))
}

pub(super) fn write_exclusive_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

pub(super) fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_distinct_real_directories() {
        let parent = tempfile::tempdir().unwrap();
        let first = create_unique_directory(parent.path()).unwrap();
        let second = create_unique_directory(parent.path()).unwrap();

        assert_ne!(first, second);
        for path in [first, second] {
            let metadata = std::fs::symlink_metadata(path).unwrap();
            assert!(metadata.is_dir());
            assert!(!metadata.file_type().is_symlink());
        }
    }

    #[test]
    fn exclusive_write_refuses_existing_file_without_changing_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("existing.txt");
        std::fs::write(&path, b"original").unwrap();

        assert!(write_exclusive_synced(&path, b"replacement").is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn exclusive_write_refuses_symlink_without_changing_target() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target.txt");
        let link = root.path().join("link.txt");
        std::fs::write(&target, b"original").unwrap();
        symlink(&target, &link).unwrap();

        assert!(write_exclusive_synced(&link, b"replacement").is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"original");
        assert!(std::fs::symlink_metadata(link)
            .unwrap()
            .file_type()
            .is_symlink());
    }
}
