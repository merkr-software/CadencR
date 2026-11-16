//! Private, owner-only files under the plugins directory: the request's
//! storage root, bounded regular reads and directory checks every managed
//! extension kind relies on. The default root also holds the shared signed
//! catalog cache (historically `plugins/managed-themes`).
/// A storage-layer failure about `path`; it names the path, which says
/// which kind's store it belongs to.
fn unsafe_path(path: &Path, problem: &str) -> AppError {
    AppError::coded(
        axum::http::StatusCode::BAD_REQUEST,
        "MARKETPLACE_STORAGE_INVALID",
        format!("{}: {problem}", path.display()),
    )
}
fn io_failure<E: std::fmt::Display>(path: &Path) -> impl FnOnce(E) -> AppError + '_ {
    move |error| unsafe_path(path, &error.to_string())
}
use crate::error::AppError;
use std::path::{Path, PathBuf};

thread_local! {
    static ROOT_OVERRIDE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}
/// Carry the request's resolved storage directory into a blocking worker.
pub(crate) fn with_root<T>(root: PathBuf, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<PathBuf>);
    impl Drop for Restore {
        fn drop(&mut self) {
            ROOT_OVERRIDE.with(|slot| {
                slot.replace(self.0.take());
            });
        }
    }
    let _restore = Restore(ROOT_OVERRIDE.with(|slot| slot.replace(Some(root))));
    operation()
}
pub fn root() -> PathBuf {
    ROOT_OVERRIDE
        .with(|slot| slot.borrow().clone())
        .unwrap_or_else(|| {
            crate::domain::settings_store::dir::data_sibling_dir("plugins").join("managed-themes")
        })
}
pub fn digest(bytes: &[u8]) -> String {
    crate::shared::file_digest::sha256_hex(bytes)
}
pub fn secure(path: &Path) -> Result<(), AppError> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(unsafe_path(path, "is not a real directory"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
                return Err(unsafe_path(path, "must be owner-only"));
            }
        }
    }
    if let Some(parent) = path.parent() {
        if Some(parent) != root().parent() {
            secure(parent)?;
        } else if let Ok(info) = std::fs::symlink_metadata(parent) {
            if !info.is_dir() || info.file_type().is_symlink() {
                return Err(unsafe_path(parent, "must be a real directory"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt as _;
                if info.uid() != unsafe { libc::geteuid() } || info.mode() & 0o022 != 0 {
                    return Err(unsafe_path(parent, "has unsafe ownership or permissions"));
                }
            }
        } else {
            crate::remote::secure_fs::create_dir_owner_only(parent).map_err(io_failure(parent))?;
        }
    }
    crate::remote::secure_fs::create_dir_owner_only(path).map_err(io_failure(path))
}
pub fn bounded_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, AppError> {
    let bytes = regular(path, cadencr_registry_core::MAX_CATALOG_BYTES)?;
    serde_json::from_slice(&bytes).map_err(|error| unsafe_path(path, &error.to_string()))
}
pub fn regular(path: &Path, limit: usize) -> Result<Vec<u8>, AppError> {
    use std::io::Read as _;
    let before = std::fs::symlink_metadata(path).map_err(io_failure(path))?;
    if !before.is_file() || before.len() > limit as u64 {
        return Err(unsafe_path(path, "is not bounded regular data"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(io_failure(path))?;
    let after = file.metadata().map_err(io_failure(path))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || after.uid() != unsafe { libc::geteuid() }
            || after.mode() & 0o177 != 0
            || after.nlink() != 1
        {
            return Err(unsafe_path(path, "inode or permissions are unsafe"));
        }
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_failure(path))?;
    if bytes.len() > limit {
        return Err(unsafe_path(path, "exceeds its byte budget"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn storage_errors_name_the_offending_path_not_a_theme() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("managed-tabs").join("receipt.json");
        let error = regular(&missing, 10).unwrap_err().to_string();
        assert!(!error.contains("theme"), "{error}");
        let file = root.path().join("data");
        std::fs::write(&file, b"too large").unwrap();
        let error = regular(&file, 2).unwrap_err().to_string();
        assert!(error.contains(&file.display().to_string()), "{error}");
        assert!(!error.contains("theme"), "{error}");
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_hardlinks_executable_bits_and_world_readable_files() {
        use std::os::unix::fs::{symlink, PermissionsExt as _};
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("data");
        std::fs::write(&file, b"inert").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(regular(&file, 10).unwrap(), b"inert");
        assert!(regular(&file, 2).is_err());
        let link = root.path().join("link");
        symlink(&file, &link).unwrap();
        assert!(regular(&link, 10).is_err());
        let hard = root.path().join("hard");
        std::fs::hard_link(&file, &hard).unwrap();
        assert!(regular(&hard, 10).is_err());
        std::fs::remove_file(hard).unwrap();
        for mode in [0o700, 0o644, 0o666] {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
            assert!(regular(&file, 10).is_err());
        }
    }
}
