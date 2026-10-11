use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

const UNIQUE_DIRECTORY_ATTEMPTS: usize = 8;

/// Join one portable filename component without touching the filesystem.
/// This is lexical validation, not protection against ancestor symlink races.
pub(super) fn child_path(parent: &Path, component: &str) -> std::io::Result<PathBuf> {
    let path = Path::new(component);
    let mut components = path.components();
    if component.is_empty()
        || component == "."
        || component.contains("..")
        || component.contains('/')
        || component.contains('\\')
        || component.contains(':')
        || component.chars().any(char::is_control)
        || path.is_absolute()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "publication child path must be one safe filename component",
        ));
    }
    Ok(parent.join(component))
}

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
    fn child_path_accepts_numeric_and_uuid_components_without_creating_them() {
        let parent = tempfile::tempdir().unwrap();
        for component in [
            "1",
            "9223372036854775807",
            "123e4567-e89b-12d3-a456-426614174000",
        ] {
            assert_eq!(
                child_path(parent.path(), component).unwrap(),
                parent.path().join(component)
            );
        }
        assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 0);
    }

    #[test]
    fn child_path_rejects_unsafe_components_without_changing_parent() {
        let parent = tempfile::tempdir().unwrap();
        let sentinel = parent.path().join("sentinel");
        std::fs::write(&sentinel, b"original").unwrap();
        for component in [
            "",
            ".",
            "..",
            "../escape",
            "nested/child",
            "a..b",
            "/absolute",
            "\\absolute",
            "nested\\child",
            "C:\\absolute",
            "C:/absolute",
            "C:relative",
            "\\\\server\\share",
            "\\\\?\\C:\\absolute",
            "name:stream",
            "nul\0byte",
            "line\nbreak",
            "tab\tname",
            "delete\u{7f}",
        ] {
            let error = child_path(parent.path(), component).unwrap_err();
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::InvalidInput,
                "{component:?}"
            );
        }
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 1);
    }

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
