//! Atomic file writes: write a sibling temp file, then rename over the target.
//!
//! Every user-editable JSON document the app owns (settings, themes) goes
//! through this, so a reader — or a directory watcher — never observes a
//! half-written file. The temp file is dot-prefixed both to keep it out of
//! directory listings and because the watchers filter dotfiles out, which is
//! what stops our own writes from broadcasting a partial document.

use std::path::Path;

use crate::error::AppError;

pub fn write_atomic(path: &Path, content: &str) -> Result<(), AppError> {
    write_atomic_with_policy(path, content, false)
}

/// Write an owner-readable/writable document. Provider descriptors can embed
/// credentials in executable arguments or environment values.
pub fn write_atomic_private(path: &Path, content: &str) -> Result<(), AppError> {
    write_atomic_with_policy(path, content, true)
}

fn write_atomic_with_policy(path: &Path, content: &str, private: bool) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Internal(format!("path has no parent: {}", path.display())))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| AppError::Internal(format!("failed to create {}: {e}", parent.display())))?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Internal(format!("path has no file name: {}", path.display())))?;
    let tmp = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    if let Err(error) = write_temp_file(&tmp, content, private) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    replace_file(&tmp, path).map_err(|e| {
        // Don't leave a stale temp file behind for the next reader to trip over.
        let _ = std::fs::remove_file(&tmp);
        AppError::Internal(format!("failed to commit {}: {e}", path.display()))
    })?;
    crate::shared::fs_durability::sync_directory(parent).map_err(|error| {
        AppError::Internal(format!("failed to sync {}: {error}", parent.display()))
    })
}

fn write_temp_file(path: &Path, content: &str, private: bool) -> Result<(), AppError> {
    use std::io::Write as _;

    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| write_error(path, error))?;
    file.write_all(content.as_bytes())
        .map_err(|error| write_error(path, error))?;
    file.sync_all().map_err(|error| write_error(path, error))?;
    let _ = private;
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both pointers reference NUL-terminated UTF-16 buffers alive for
    // the duration of the call. `MoveFileExW` does not retain them.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn write_error(path: &Path, error: std::io::Error) -> AppError {
    AppError::Internal(format!("failed to write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_through_a_temp_file_and_leaves_none_behind() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("doc.json");
        write_atomic(&path, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");

        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "temp file must not survive");
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested/deeper/doc.json");
        write_atomic(&path, "x").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x");
    }

    #[test]
    fn overwrites_an_existing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("doc.json");
        write_atomic(&path, "old").unwrap();
        write_atomic(&path, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn private_writes_replace_permissive_files_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let path = dir.path().join("secret.json");
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_atomic_private(&path, "new").unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
