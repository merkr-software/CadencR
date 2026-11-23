//! Atomic file writes: write a sibling temp file, then rename over the target.
//!
//! Every user-editable JSON document the app owns (settings, themes) goes
//! through this, so a reader — or a directory watcher — never observes a
//! half-written file. The temp file is dot-prefixed both to keep it out of
//! directory listings and because the watchers filter dotfiles out, which is
//! what stops our own writes from broadcasting a partial document.

use crate::shared::discard::cleanup;
use std::fs::File;
use std::path::Path;

#[cfg(unix)]
use std::fs::Permissions;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

use crate::error::AppError;

pub fn write_atomic(path: &Path, content: &str) -> Result<(), AppError> {
    write_atomic_with_policy(path, content, WritePermissions::Default)
}

/// Write an owner-readable/writable document. Provider descriptors can embed
/// credentials in executable arguments or environment values.
pub fn write_atomic_private(path: &Path, content: &str) -> Result<(), AppError> {
    write_atomic_with_policy(path, content, WritePermissions::Private)
}

/// Replace an existing provider config, following symlinks and preserving the
/// target's Unix read, write and execute permissions.
pub fn write_atomic_in_place(path: &Path, content: &str) -> Result<(), AppError> {
    let target = std::fs::canonicalize(path).map_err(|error| {
        AppError::internal(format!("failed to resolve {}: {error}", path.display()))
    })?;
    let metadata = std::fs::symlink_metadata(&target).map_err(|error| {
        AppError::internal(format!("failed to inspect {}: {error}", target.display()))
    })?;
    if !metadata.is_file() {
        return Err(AppError::internal(format!(
            "not a regular file: {}",
            target.display()
        )));
    }

    #[cfg(unix)]
    let permissions = WritePermissions::Preserve(Permissions::from_mode(
        metadata.permissions().mode() & 0o777,
    ));
    #[cfg(not(unix))]
    let permissions = WritePermissions::Default;
    write_atomic_with_policy(&target, content, permissions)
}

enum WritePermissions {
    Default,
    Private,
    #[cfg(unix)]
    Preserve(Permissions),
}

fn write_atomic_with_policy(
    path: &Path,
    content: &str,
    permissions: WritePermissions,
) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::internal(format!("path has no parent: {}", path.display())))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| AppError::internal(format!("failed to create {}: {e}", parent.display())))?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::internal(format!("path has no file name: {}", path.display())))?;
    let tmp = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let file = open_temp_file(&tmp, &permissions)?;
    if let Err(error) = write_temp_file(file, &tmp, content, permissions) {
        cleanup(std::fs::remove_file(&tmp), "remove the temporary file");
        return Err(error);
    }
    replace_file(&tmp, path).map_err(|e| {
        // Don't leave a stale temp file behind for the next reader to trip over.
        cleanup(std::fs::remove_file(&tmp), "remove the temporary file");
        AppError::internal(format!("failed to commit {}: {e}", path.display()))
    })?;
    crate::shared::fs_durability::sync_directory(parent).map_err(|error| {
        AppError::internal(format!("failed to sync {}: {error}", parent.display()))
    })
}

fn open_temp_file(path: &Path, permissions: &WritePermissions) -> Result<File, AppError> {
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    if !matches!(permissions, WritePermissions::Default) {
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = permissions;
    options.open(path).map_err(|error| write_error(path, error))
}

fn write_temp_file(
    mut file: File,
    path: &Path,
    content: &str,
    permissions: WritePermissions,
) -> Result<(), AppError> {
    use std::io::Write as _;

    file.write_all(content.as_bytes())
        .map_err(|error| write_error(path, error))?;
    // Apply the final mode only after the complete content has been written.
    #[cfg(unix)]
    if let WritePermissions::Preserve(permissions) = permissions {
        file.set_permissions(permissions).map_err(|error| {
            AppError::internal(format!(
                "failed to set permissions on {}: {error}",
                path.display()
            ))
        })?;
    }
    #[cfg(not(unix))]
    let _ = permissions;
    file.sync_all().map_err(|error| write_error(path, error))
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

#[track_caller]
fn write_error(path: &Path, error: std::io::Error) -> AppError {
    AppError::internal(format!("failed to write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(unix)]
    #[test]
    fn in_place_writes_preserve_the_target_mode() {
        let dir = tempdir().unwrap();
        for mode in [0o400, 0o440, 0o600, 0o640, 0o644, 0o660, 0o751] {
            let path = dir.path().join(format!("config-{mode:o}.toml"));
            std::fs::write(&path, "old").unwrap();
            std::fs::set_permissions(&path, Permissions::from_mode(mode)).unwrap();

            write_atomic_in_place(&path, "new").unwrap();

            assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, mode);
        }
    }

    #[cfg(unix)]
    #[test]
    fn in_place_temporary_files_start_owner_only() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".config.tmp");
        let permissions = WritePermissions::Preserve(Permissions::from_mode(0o640));

        let file = open_temp_file(&path, &permissions).unwrap();

        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o077, 0);
    }

    #[cfg(unix)]
    #[test]
    fn in_place_writes_follow_a_relative_symlink_and_preserve_the_target_mode() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.json");
        std::fs::write(&real, "old").unwrap();
        std::fs::set_permissions(&real, Permissions::from_mode(0o640)).unwrap();
        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink("real.json", &link).unwrap();

        write_atomic_in_place(&link, "new").unwrap();

        assert_eq!(std::fs::read_link(&link).unwrap(), Path::new("real.json"));
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "new");
        let mode = std::fs::metadata(&real).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn in_place_writes_report_unresolvable_symlinks_without_replacing_them() {
        let dir = tempdir().unwrap();
        let link = dir.path().join("link.json");
        for target in ["missing.json", "link.json"] {
            std::os::unix::fs::symlink(target, &link).unwrap();

            let error = write_atomic_in_place(&link, "new").unwrap_err();

            assert!(error.to_string().contains("failed to resolve"), "{error}");
            assert_eq!(std::fs::read_link(&link).unwrap(), Path::new(target));
            std::fs::remove_file(&link).unwrap();
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

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
